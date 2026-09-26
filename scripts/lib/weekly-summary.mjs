// Aggregates raw commit volume/authorship/timing across the tracked repos
// over a trailing window — a different question from check.mjs's "what's
// new since last time": not "what happened" but "what does the pace and
// shape of activity look like." Answers exactly the kind of suspicion
// FedScoop's reporting raised about one person's commit volume: is one
// author dominating, and is the pace/timing plausible for a human (vs.
// commits landing faster than someone could plausibly review between them).
//
// Pulled fresh from GitHub's commits API for the window rather than
// reconstructed from our own data/events/ history, so a gap in check.mjs's
// own run cadence can't silently produce an incomplete report. Same story
// for the most-reacted-comments section below: reaction counts accumulate
// on a comment long after it's created, and check.mjs's incremental
// "since last check" comment fetch has no reason to ever revisit an old
// comment just because it picked up a new reaction — so ranking by
// reactions needs its own fresh, wider fetch, not the real-time tracker's.
import { fetchNewComments } from "./comment-watch.mjs";
import { fetchRepoDiscussions } from "./discussion-watch.mjs";
import { escapeMentions } from "./escape-mentions.mjs";

const TIMEOUT_MS = 15000;
const RAPID_FIRE_MS = 2 * 60 * 1000; // same-author commits closer together than this get flagged

function authHeaders() {
  const headers = { "user-agent": "status-log/1.0", accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: authHeaders() });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, data: null, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCommitsInRange(repo, sinceIso, untilIso) {
  const commits = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(sinceIso)}&until=${encodeURIComponent(untilIso)}&per_page=100&page=${page}`;
    const { ok, data } = await fetchJson(url);
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    for (const c of data) {
      commits.push({
        repo,
        sha: c.sha,
        author: c.author?.login || c.commit?.author?.name || "unknown",
        date: c.commit?.author?.date,
      });
    }
    if (data.length < 100) break; // last page
  }
  return commits;
}

export async function collectWeeklyCommits(repos, sinceIso, untilIso) {
  const lists = await Promise.all(repos.map((r) => fetchCommitsInRange(r, sinceIso, untilIso)));
  return lists.flat();
}

export function summarizeCommits(commits) {
  const byAuthor = new Map();
  const byHourUtc = new Array(24).fill(0);
  for (const c of commits) {
    byAuthor.set(c.author, (byAuthor.get(c.author) || 0) + 1);
    if (c.date) byHourUtc[new Date(c.date).getUTCHours()]++;
  }
  const topAuthors = [...byAuthor.entries()].sort((a, b) => b[1] - a[1]);

  // Flag same-author commits closer together than a human could plausibly
  // write and review between them — a concrete, checkable stand-in for "is
  // this pace realistic," not a verdict on its own (a legitimate scripted
  // dependency-bump batch would also trip this).
  const byAuthorSorted = new Map();
  for (const c of commits) {
    if (!c.date) continue;
    if (!byAuthorSorted.has(c.author)) byAuthorSorted.set(c.author, []);
    byAuthorSorted.get(c.author).push(c);
  }
  const rapidFireByAuthor = new Map();
  for (const [author, list] of byAuthorSorted) {
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    let count = 0;
    for (let i = 1; i < list.length; i++) {
      if (new Date(list[i].date) - new Date(list[i - 1].date) < RAPID_FIRE_MS) count++;
    }
    if (count > 0) rapidFireByAuthor.set(author, count);
  }

  return {
    total: commits.length,
    topAuthors,
    byHourUtc,
    rapidFirePairs: [...rapidFireByAuthor.entries()].sort((a, b) => b[1] - a[1]),
  };
}

export async function collectWeeklyComments(repos, sinceIso) {
  const [issueLists, discussionLists] = await Promise.all([
    Promise.all(repos.map((r) => fetchNewComments(r, sinceIso))),
    Promise.all(repos.map((r) => fetchRepoDiscussions(r, sinceIso))),
  ]);
  return [...issueLists.flat(), ...discussionLists.flatMap((r) => r.newComments)];
}

function commentLocation(c) {
  return c.kind === "discussion" ? `discussion #${c.discussionNumber} on ${c.repo}` : `${c.repo}#${c.issueNumber}`;
}

// Only ever the top few by a strictly-positive count — most comments get
// zero reactions of either kind, so "most reacted" only means something
// once there's at least one.
export function topReactedComments(comments, key, limit = 5) {
  return comments
    .filter((c) => c[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, limit);
}

function bar(count, max, width = 20) {
  const len = max > 0 ? Math.round((count / max) * width) : 0;
  return "█".repeat(len) + " ".repeat(width - len);
}

export function formatSummaryMarkdown(summary, { sinceIso, untilIso, repoCount }) {
  const lines = [];
  lines.push(`Covering ${sinceIso.slice(0, 10)} → ${untilIso.slice(0, 10)} across ${repoCount} tracked repo(s).`);
  lines.push("");
  lines.push(`**Total commits: ${summary.total}**`);
  lines.push("");
  if (summary.topAuthors.length > 0) {
    lines.push("## By author");
    for (const [author, count] of summary.topAuthors) {
      const pct = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
      lines.push(`- ${author}: ${count} (${pct}%)`);
    }
    lines.push("");
  }
  const maxHour = Math.max(...summary.byHourUtc, 1);
  lines.push("## By hour (UTC)");
  lines.push("```");
  for (let h = 0; h < 24; h++) {
    if (summary.byHourUtc[h] === 0) continue;
    lines.push(`${String(h).padStart(2, "0")}:00  ${bar(summary.byHourUtc[h], maxHour)}  ${summary.byHourUtc[h]}`);
  }
  lines.push("```");
  if (summary.rapidFirePairs.length > 0) {
    lines.push("");
    lines.push(`## Rapid-fire commits (<${RAPID_FIRE_MS / 60000}min apart, same author)`);
    lines.push(
      "Not a verdict on its own — a scripted dependency-bump batch trips this too — but worth a look at *what* landed that fast."
    );
    for (const [author, count] of summary.rapidFirePairs) {
      lines.push(`- ${author}: ${count} pair(s) this week`);
    }
  }
  return lines.join("\n");
}

function formatReactedComment(c, key) {
  const body = escapeMentions((c.body || "").replace(/\r?\n/g, " ").slice(0, 200));
  return `- **${c[key]}** ${key === "up" ? "👍" : "👎"} — ${c.author} on ${commentLocation(c)}: ${body}\n  \`${c.url}\``;
}

export function formatCommentsMarkdown(comments) {
  const lines = [];
  const topUp = topReactedComments(comments, "up");
  const topDown = topReactedComments(comments, "down");
  if (topUp.length > 0) {
    lines.push("## Most upvoted comments");
    lines.push(...topUp.map((c) => formatReactedComment(c, "up")));
  }
  if (topDown.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("## Most downvoted comments");
    lines.push(...topDown.map((c) => formatReactedComment(c, "down")));
  }
  return lines.join("\n");
}
