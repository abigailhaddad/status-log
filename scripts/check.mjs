import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { checkDns } from "./lib/dns-check.mjs";
import { checkHttp, fetchText } from "./lib/http-check.mjs";
import { checkCertTransparency } from "./lib/crtsh.mjs";
import { checkRepos } from "./lib/repo-watch.mjs";
import { checkOrgRepos } from "./lib/org-watch.mjs";
import { checkAllWatchedUsers, diffUserActivity } from "./lib/person-watch.mjs";
import { checkRepoActivity } from "./lib/comment-watch.mjs";
import { checkDiscussionActivity } from "./lib/discussion-watch.mjs";
import { scanSource, scanHeaders } from "./lib/source-scan.mjs";
import { escapeMentions } from "./lib/escape-mentions.mjs";
import { WATCH_TARGETS } from "./lib/watch-targets.mjs";

const DOMAIN = WATCH_TARGETS.domain;
const WWW_DOMAIN = `www.${DOMAIN}`;

const DATA_DIR = path.join(process.cwd(), "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const HISTORY_PATH = path.join(DATA_DIR, "history.jsonl");
const EVENTS_DIR = path.join(DATA_DIR, "events");

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(LATEST_PATH, "utf8"));
  } catch {
    return null;
  }
}

function isLive(httpResults) {
  return Object.values(httpResults).some((r) => r.reachable && r.finalStatus && r.finalStatus < 500);
}

// A literal tag some commit messages use for a specific initiative's work —
// flag it so it doesn't get lost among routine commits from unrelated authors.
const FLAG_PATTERN = /\bNDS\b/;
function formatCommit(c) {
  const message = escapeMentions(c.message.split("\n")[0].slice(0, 300));
  const flag = FLAG_PATTERN.test(c.message) ? " [flagged]" : "";
  return `[${c.repo}] ${c.sha.slice(0, 7)} ${message}${flag} — ${c.author}\n  \`${c.url}\``;
}

function diffNewCommits(current, previous, excludeShas) {
  const prevShas = new Set((previous?.commits || []).map((c) => c.sha));
  return (current.commits || []).filter((c) => !prevShas.has(c.sha) && !excludeShas.has(c.sha));
}

function formatIssue(i) {
  return `${i.author} opened ${i.isPullRequest ? "PR" : "issue"} #${i.number} on ${i.repo}: "${i.title}"\n  \`${i.url}\``;
}

function formatDiscussion(d) {
  return `${d.author} opened discussion #${d.number} on ${d.repo}: "${d.title}"\n  \`${d.url}\``;
}

// A comment's location reads differently depending on whether it came from
// comment-watch.mjs (an issue/PR) or discussion-watch.mjs (a discussion) —
// everything else about the two is handled identically from here on.
function commentLocation(c) {
  return c.kind === "discussion" ? `discussion #${c.discussionNumber} on ${c.repo}` : `${c.repo}#${c.issueNumber}`;
}

function formatComment(c) {
  const body = escapeMentions((c.body || "").replace(/\r?\n/g, " ").slice(0, 300));
  return `${c.author} commented on ${commentLocation(c)}: ${body}\n  \`${c.url}\``;
}

function formatDeletedComment(c) {
  const body = escapeMentions((c.body || "").replace(/\r?\n/g, " ").slice(0, 500));
  return `${c.author}'s comment on ${commentLocation(c)} (posted ${c.createdAt}) was deleted. Last known content: "${body}"`;
}

async function runFullSnapshot(prev) {
  const timestamp = new Date().toISOString();

  const [dns, certResult, repoResult, orgResult, personActivity] = await Promise.all([
    checkDns(),
    checkCertTransparency(),
    checkRepos(WATCH_TARGETS.repos),
    checkOrgRepos(),
    checkAllWatchedUsers(),
  ]);

  // crt.sh and the GitHub commits API both fail soft (ok:false, empty list)
  // on a timeout/error rather than throwing — but persisting that empty
  // result as the new baseline is worse than the failure itself: the next
  // successful check then diffs the real list against an empty one and
  // reports every cert/commit that's ever existed as "new." Carry the last
  // known-good data forward on a failed check instead, so a transient
  // outage just delays detection by one cycle rather than firing a flood of
  // false positives.
  const cert = certResult.ok ? certResult : prev?.cert ?? certResult;
  const repos = repoResult.ok ? repoResult : prev?.repos ?? repoResult;
  const org = orgResult.ok ? orgResult : prev?.org ?? orgResult;

  const http = {
    [DOMAIN]: await checkHttp(DOMAIN),
    [WWW_DOMAIN]: await checkHttp(WWW_DOMAIN),
  };

  const live = isLive(http);

  let audit = null;
  if (live) {
    const [robots, sitemap] = await Promise.all([
      fetchText(`https://${DOMAIN}/robots.txt`),
      fetchText(`https://${DOMAIN}/sitemap.xml`),
    ]);
    const primary = http[DOMAIN].reachable ? http[DOMAIN] : http[WWW_DOMAIN];
    audit = {
      robotsTxt: robots.ok ? robots.text : null,
      sitemapXml: sitemap.ok ? sitemap.text?.slice(0, 5000) : null,
      sourceSignatures: scanSource(primary.bodySnippet),
      headerSignatures: scanHeaders(primary.finalHeaders),
    };
  }

  // Only checked once there's a `prev` to diff against (below) — on the very
  // first run there's no baseline yet, and fetching "everything since the
  // dawn of time" would both be a huge/slow request and misreport the
  // entire pre-existing issue/comment history as brand new.
  let comments = { known: prev?.comments?.known || [] };

  const events = [];
  if (prev) {
    if (prev.live !== live) {
      events.push({
        type: live ? "SITE_WENT_LIVE" : "SITE_WENT_DOWN",
        detail: `Reachability changed from ${prev.live} to ${live}`,
      });
    }
    const prevCertNames = new Set((prev.cert?.certs || []).map((c) => `${c.common_name}|${c.not_before}`));
    const newCerts = (cert.certs || []).filter((c) => !prevCertNames.has(`${c.common_name}|${c.not_before}`));
    if (newCerts.length > 0) {
      events.push({
        type: "NEW_CERTIFICATE",
        detail: newCerts.map((c) => `${c.common_name} (${c.not_before})`).join("; "),
      });
    }
    // Computed before NEW_REPO_COMMITS: a single push shows up both as a
    // new commit on the repo and as a PushEvent on the pusher's public
    // activity feed — two independent GitHub API surfaces for the same
    // action. Collecting person-activity's commit SHAs first lets the repo
    // diff exclude anything already covered there, instead of reporting the
    // same commit twice under two different event types.
    const personDiffs = [];
    const shasCoveredByPersonActivity = new Set();
    for (const username of Object.keys(personActivity)) {
      const diff = await diffUserActivity(username, personActivity[username], prev.personActivity?.[username]);
      if (diff) {
        personDiffs.push(diff);
        for (const sha of diff.commitShas) shasCoveredByPersonActivity.add(sha);
      }
    }

    const newRepoCommits = [
      ...diffNewCommits(repos, prev.repos, shasCoveredByPersonActivity),
      ...diffNewCommits(org, prev.org, shasCoveredByPersonActivity),
    ];
    if (newRepoCommits.length > 0) {
      events.push({ type: "NEW_REPO_COMMITS", detail: newRepoCommits.map(formatCommit).join("\n\n") });
    }

    // A brand-new repo appearing under the org is rarer and more significant
    // than routine commits to the one repo we already know about — worth an
    // immediate alert rather than waiting for the daily digest.
    const prevOrgRepos = new Set(prev.org?.repos || []);
    const newOrgRepos = (org.repos || []).filter((r) => !prevOrgRepos.has(r));
    if (newOrgRepos.length > 0) {
      events.push({ type: "NEW_ORG_REPO", detail: newOrgRepos.map((r) => `\`https://github.com/${r}\``).join(", ") });
    }

    const trackedRepos = [...new Set([...WATCH_TARGETS.repos, ...(org.repos || [])])];
    // Split by kind before checking: a discussion comment's ID lives in
    // GraphQL's ID space, not REST's, so handing the wrong kind to the
    // wrong checker would either error or (worse) 404 spuriously.
    const prevKnownComments = prev.comments?.known || [];
    const prevIssueComments = prevKnownComments.filter((c) => c.kind !== "discussion");
    const prevDiscussionComments = prevKnownComments.filter((c) => c.kind === "discussion");
    const [issueActivity, discussionActivity] = await Promise.all([
      checkRepoActivity(trackedRepos, prev.timestamp, prevIssueComments),
      checkDiscussionActivity(trackedRepos, prev.timestamp, prevDiscussionComments),
    ]);
    comments = { known: [...issueActivity.known, ...discussionActivity.known] };

    if (issueActivity.newIssues.length > 0) {
      events.push({ type: "NEW_ISSUE", detail: issueActivity.newIssues.map(formatIssue).join("\n\n") });
    }
    if (discussionActivity.newDiscussions.length > 0) {
      events.push({ type: "NEW_DISCUSSION", detail: discussionActivity.newDiscussions.map(formatDiscussion).join("\n\n") });
    }
    const newComments = [...issueActivity.newComments, ...discussionActivity.newComments];
    if (newComments.length > 0) {
      events.push({ type: "NEW_COMMENT", detail: newComments.map(formatComment).join("\n\n") });
    }
    // Someone deleting a comment is the whole reason this is worth tracking
    // at all (routine new comments are noise; a comment quietly disappearing
    // is not) — worth an immediate alert rather than the daily digest.
    const deletedComments = [...issueActivity.deletedComments, ...discussionActivity.deletedComments];
    if (deletedComments.length > 0) {
      events.push({ type: "DELETED_COMMENT", detail: deletedComments.map(formatDeletedComment).join("\n\n") });
    }

    for (const diff of personDiffs) {
      events.push({ type: "NEW_PERSON_ACTIVITY", detail: `${diff.username}:\n${diff.detail}` });
    }
  } else if (live) {
    events.push({ type: "SITE_WENT_LIVE", detail: "First observed reachable" });
  }

  const snapshot = { timestamp, live, dns, http, cert, repos, org, personActivity, comments, audit };
  return { snapshot, events };
}

// Events about the target itself fire an issue immediately, hourly — that's
// the thing worth knowing about the moment it happens. Commit/person-activity
// noise is still recorded every run (below) but only surfaces as a daily
// digest (see scripts/daily-digest.mjs) instead of an email every hour.
const IMMEDIATE_EVENT_TYPES = new Set(["SITE_WENT_LIVE", "SITE_WENT_DOWN", "NEW_CERTIFICATE", "NEW_ORG_REPO", "DELETED_COMMENT"]);

async function main() {
  await mkdir(EVENTS_DIR, { recursive: true });
  const prev = await loadPrevious();
  const { snapshot, events } = await runFullSnapshot(prev);

  await writeFile(LATEST_PATH, JSON.stringify(snapshot, null, 2) + "\n");

  const historyLine = JSON.stringify({
    timestamp: snapshot.timestamp,
    live: snapshot.live,
    primaryStatus: snapshot.http[DOMAIN].finalStatus,
    wwwStatus: snapshot.http[WWW_DOMAIN].finalStatus,
    certCount: snapshot.cert.certs.length,
  });
  await appendFile(HISTORY_PATH, historyLine + "\n");

  if (events.length > 0) {
    const eventFile = path.join(EVENTS_DIR, `${snapshot.timestamp.replace(/[:.]/g, "-")}.json`);
    await writeFile(eventFile, JSON.stringify({ timestamp: snapshot.timestamp, events }, null, 2) + "\n");
  }

  // Wire up outputs for the GitHub Actions step that runs this script. Only
  // Target-itself events (live/down/new cert) drive the hourly issue —
  // repo commits and account activity are still recorded in data/events/
  // above, just surfaced later by the daily digest instead of every hour.
  const immediateEvents = events.filter((e) => IMMEDIATE_EVENT_TYPES.has(e.type));

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const lines = [
      `live=${snapshot.live}`,
      `changed=${immediateEvents.length > 0}`,
      `event_summary=${[...new Set(immediateEvents.map((e) => e.type))].join(",") || "none"}`,
    ];
    await appendFile(ghOutput, lines.join("\n") + "\n");

    // event_summary is just types (for a short issue title) — the actual
    // detail (which cert, etc.) needs GitHub Actions' multiline-output
    // delimiter syntax since it can contain arbitrary text.
    const delimiter = `EVENT_DETAILS_${Math.random().toString(36).slice(2)}`;
    const detailsText = immediateEvents.map((e) => `${e.type}: ${e.detail}`).join("\n\n") || "none";
    await appendFile(ghOutput, `event_details<<${delimiter}\n${detailsText}\n${delimiter}\n`);
  }

  console.log(`[${snapshot.timestamp}] live=${snapshot.live} events=${events.length}`);
  for (const e of events) console.log(`  - ${e.type}: ${e.detail}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
