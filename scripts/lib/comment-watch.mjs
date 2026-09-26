// Tracks issues and issue/PR comments across a list of repos: new issues
// opened, new comments (who, when, and the content — kept in full in our
// own state even after truncation in a human-facing summary, since a
// deletion means GitHub's own copy is gone), and comments that existed on a
// previous run but don't anymore.
//
// GitHub has no "list deleted comments" feed — noticing a deletion means
// re-checking a comment we've already recorded to see if it 404s now. See
// deletion-check.mjs for the caching policy that keeps that bounded as the
// known set grows (recent comments every run, older ones at most weekly).
import { escapeMentions } from "./escape-mentions.mjs";
import { partitionForDeletionCheck, applyDeletionResults } from "./deletion-check.mjs";

const TIMEOUT_MS = 15000;

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
    if (res.status === 404) return { ok: true, status: 404, data: null };
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: null, data: null, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllPages(urlWithoutPage) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const { ok, data } = await fetchJson(`${urlWithoutPage}&page=${page}`);
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < 100) break; // last page
  }
  return items;
}

export async function fetchNewIssues(repo, sinceIso) {
  const data = await fetchAllPages(
    `https://api.github.com/repos/${repo}/issues?since=${encodeURIComponent(sinceIso)}&state=all&per_page=100`
  );
  return data
    .filter((issue) => issue.created_at >= sinceIso)
    .map((issue) => ({
      repo,
      number: issue.number,
      title: escapeMentions(issue.title || ""),
      author: issue.user?.login || "unknown",
      isPullRequest: Boolean(issue.pull_request),
      createdAt: issue.created_at,
      url: issue.html_url,
    }));
}

// GitHub includes reaction counts on every comment in this same response at
// no extra cost — but note `since` here filters by the comment's updated_at,
// and adding a reaction doesn't bump that, so a reaction added well after a
// comment's creation on an old comment won't be caught by an incremental
// "since last check" fetch. That's fine for "was this just posted" (this
// function's job); ranking by reaction counts needs its own fresh, wider
// fetch instead (see weekly-summary.mjs), not this incremental one.
export async function fetchNewComments(repo, sinceIso) {
  const data = await fetchAllPages(
    `https://api.github.com/repos/${repo}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100`
  );
  return data
    .filter((c) => c.created_at >= sinceIso)
    .map((c) => ({
      kind: "issue",
      id: c.id,
      repo,
      issueNumber: Number(c.issue_url.split("/").pop()),
      author: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
      url: c.html_url,
      up: c.reactions?.["+1"] || 0,
      down: c.reactions?.["-1"] || 0,
      totalReactions: c.reactions?.total_count || 0,
    }));
}

async function commentStillExists(repo, commentId) {
  const { ok, status } = await fetchJson(`https://api.github.com/repos/${repo}/issues/comments/${commentId}`);
  if (!ok) return null; // network/timeout error — inconclusive, never report a false deletion
  return status !== 404;
}

// prevKnown: [{ id, repo, issueNumber, author, body, createdAt, url, lastCheckedAt }, ...] from the last run.
export async function checkRepoActivity(repos, sinceIso, prevKnown = []) {
  const [issueLists, commentLists] = await Promise.all([
    Promise.all(repos.map((r) => fetchNewIssues(r, sinceIso))),
    Promise.all(repos.map((r) => fetchNewComments(r, sinceIso))),
  ]);
  const newIssues = issueLists.flat();
  const newComments = commentLists.flat();

  const now = Date.now();
  const { due, notDue } = partitionForDeletionCheck(prevKnown, now);
  const existenceChecks = await Promise.all(
    due.map(async (c) => ({ comment: c, exists: await commentStillExists(c.repo, c.id) }))
  );
  const { deleted: deletedComments, stillKnown } = applyDeletionResults(existenceChecks, notDue, now);

  const knownById = new Map(stillKnown.map((c) => [c.id, c]));
  for (const c of newComments) knownById.set(c.id, { ...c, lastCheckedAt: new Date(now).toISOString() });

  return { newIssues, newComments, deletedComments, known: [...knownById.values()] };
}
