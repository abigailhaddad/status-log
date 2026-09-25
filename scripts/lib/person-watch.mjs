// Watches the public GitHub activity (via the same events API GitHub shows
// any visitor on a user's profile page) of the accounts listed in
// config/watch-targets.yml.
import { escapeMentions } from "./escape-mentions.mjs";
import { WATCH_TARGETS } from "./watch-targets.mjs";

export const WATCHED_USERS = WATCH_TARGETS.people;

const TIMEOUT_MS = 15000;
const INTERESTING_EVENT_TYPES = new Set(["PushEvent", "PullRequestEvent", "CreateEvent", "PublicEvent"]);

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
    return { ok: false, status: null, data: null, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// The public events API's push/PR payloads are trimmed — no commit list,
// no PR title. This fills in the actual content, but only ever gets called
// on events diffUserActivity has already determined are new, so API usage
// stays proportional to actual new activity, not per-check overhead.
function summarizeEvent(e) {
  const base = { id: e.id, type: e.type, repo: e.repo?.name, createdAt: e.created_at };
  if (e.type === "PushEvent") {
    return { ...base, ref: e.payload?.ref, before: e.payload?.before, head: e.payload?.head };
  }
  if (e.type === "PullRequestEvent") {
    return { ...base, action: e.payload?.action, number: e.payload?.number };
  }
  if (e.type === "CreateEvent") {
    return { ...base, refType: e.payload?.ref_type, ref: e.payload?.ref };
  }
  return base; // PublicEvent needs no extra fields — the repo name alone is the finding.
}

export async function checkUserActivity(username) {
  const result = await fetchJson(`https://api.github.com/users/${username}/events/public?per_page=50`);
  if (!result.ok) return { ok: false, error: result.error || `HTTP ${result.status}`, events: [] };
  const events = result.data.filter((e) => INTERESTING_EVENT_TYPES.has(e.type)).map(summarizeEvent);
  return { ok: true, error: null, events };
}

export async function checkAllWatchedUsers() {
  const results = {};
  for (const username of WATCHED_USERS) {
    results[username] = await checkUserActivity(username);
  }
  return results;
}

// Returns { text, shas } — shas lets the caller cross-check against
// uswds-watch.mjs's own repo-commit diff (same commit, same push, reached
// via two independent GitHub API surfaces) so it isn't reported twice.
async function describeEvent(e) {
  if (e.type === "PushEvent") {
    const { ok, data } = await fetchJson(`https://api.github.com/repos/${e.repo}/compare/${e.before}...${e.head}`);
    if (ok && data?.commits?.length) {
      const commits = data.commits.slice(0, 10);
      const lines = commits.map((c) => `${c.sha.slice(0, 7)} ${escapeMentions(c.commit.message.split("\n")[0])}`).join("\n  ");
      return { text: `pushed to ${e.repo} (${(e.ref || "").replace("refs/heads/", "")}):\n  ${lines}`, shas: commits.map((c) => c.sha) };
    }
    return {
      text: `pushed to ${e.repo} (${(e.ref || "").replace("refs/heads/", "")}): \`https://github.com/${e.repo}/compare/${e.before}...${e.head}\``,
      shas: [],
    };
  }
  if (e.type === "PullRequestEvent") {
    const { ok, data } = await fetchJson(`https://api.github.com/repos/${e.repo}/pulls/${e.number}`);
    const title = ok && data?.title ? escapeMentions(data.title) : null;
    // Backtick-wrapped: a plain github.com link in a GitHub issue/PR body
    // creates a public "mentioned this pull request" cross-reference on the
    // TARGET, visible to anyone with access to the repo that did the
    // mentioning — including from a private repo, to anyone who later gets
    // access to it. Wrapping in code-span syntax suppresses GitHub's
    // reference-detection entirely (confirmed empirically), so watching
    // someone's activity never leaves a trace on their own PRs.
    const url = `\`https://github.com/${e.repo}/pull/${e.number}\``;
    const text = title ? `${e.action} PR #${e.number} on ${e.repo}: "${title}" (${url})` : `${e.action} PR #${e.number} on ${e.repo}: ${url}`;
    return { text, shas: [] };
  }
  if (e.type === "CreateEvent") {
    return { text: `created ${e.refType}${e.ref ? ` "${e.ref}"` : ""} on ${e.repo}`, shas: [] };
  }
  if (e.type === "PublicEvent") {
    return { text: `made ${e.repo} PUBLIC`, shas: [] };
  }
  return { text: `${e.type} on ${e.repo}`, shas: [] };
}

// Diffs against the previous run's known event IDs and returns a
// human-readable description of newly-seen events, enriching only those
// (not the whole fetched batch) with the extra API calls needed for real
// content.
export async function diffUserActivity(username, current, previous) {
  const prevIds = new Set((previous?.events || []).map((e) => e.id));
  const newEvents = (current.events || []).filter((e) => !prevIds.has(e.id));
  if (newEvents.length === 0) return null;

  const described = await Promise.all(
    newEvents.map((e) => describeEvent(e).catch(() => ({ text: `${e.type} on ${e.repo}`, shas: [] })))
  );
  const detail = described.map((d, i) => `[${newEvents[i].createdAt}] ${d.text}`).join("\n\n");
  const commitShas = new Set(described.flatMap((d) => d.shas));
  return { username, detail, commitShas };
}
