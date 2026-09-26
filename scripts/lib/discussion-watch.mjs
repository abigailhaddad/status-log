// Tracks GitHub Discussions — a separate feature from issues/PRs, only
// reachable via GitHub's GraphQL API (there's no REST endpoint for them):
// new discussions opened, new discussion comments (who, when, content), and
// comments that existed on a previous run but don't anymore. Same
// no-deletion-feed problem as issue/PR comments (see comment-watch.mjs),
// solved the same way and with the same caching policy (deletion-check.mjs)
// — just via GraphQL's `node(id:)` lookup instead of a REST GET, since a
// discussion comment's ID lives in GraphQL's ID space, not REST's.
//
// Fails soft per repo: Discussions is opt-in, so most watched repos likely
// don't have it enabled at all, which GraphQL reports as an error on the
// `discussions` field rather than just an empty list.
import { escapeMentions } from "./escape-mentions.mjs";
import { partitionForDeletionCheck, applyDeletionResults } from "./deletion-check.mjs";

const GRAPHQL_URL = "https://api.github.com/graphql";
const TIMEOUT_MS = 20000;

function authHeaders() {
  const headers = { "user-agent": "status-log/1.0", "content-type": "application/json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function graphql(query, variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (json.errors) return { ok: false, error: json.errors.map((e) => e.message).join("; "), data: json.data };
    return { ok: true, data: json.data };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const DISCUSSIONS_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      discussions(first: 25, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes {
          number
          title
          url
          createdAt
          author { login }
          comments(last: 25) {
            nodes {
              id
              url
              body
              createdAt
              author { login }
            }
          }
        }
      }
    }
  }
`;

const NODE_EXISTS_QUERY = `
  query($id: ID!) {
    node(id: $id) { id }
  }
`;

function splitRepo(repo) {
  const [owner, name] = repo.split("/");
  return { owner, name };
}

async function fetchRepoDiscussions(repo, sinceIso) {
  const { owner, name } = splitRepo(repo);
  const { ok, data } = await graphql(DISCUSSIONS_QUERY, { owner, name });
  const nodes = ok ? data?.repository?.discussions?.nodes : null;
  if (!Array.isArray(nodes)) return { newDiscussions: [], newComments: [] };

  const newDiscussions = nodes
    .filter((d) => d.createdAt >= sinceIso)
    .map((d) => ({
      repo,
      number: d.number,
      title: escapeMentions(d.title || ""),
      author: d.author?.login || "unknown",
      createdAt: d.createdAt,
      url: d.url,
    }));
  const newComments = nodes.flatMap((d) =>
    (d.comments?.nodes || [])
      .filter((c) => c.createdAt >= sinceIso)
      .map((c) => ({
        kind: "discussion",
        id: c.id,
        repo,
        discussionNumber: d.number,
        author: c.author?.login || "unknown",
        body: c.body || "",
        createdAt: c.createdAt,
        url: c.url,
      }))
  );
  return { newDiscussions, newComments };
}

async function discussionCommentStillExists(id) {
  // Deliberately not using graphql() above: GitHub answers a deleted/
  // nonexistent node with *both* `data.node: null` and a NOT_FOUND error in
  // the same response (confirmed live) — that's the real "doesn't exist"
  // signal we want, not a failure. graphql() treats any `errors` presence
  // as ok:false, which would misreport every real deletion as inconclusive.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(),
      body: JSON.stringify({ query: NODE_EXISTS_QUERY, variables: { id } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.data && "node" in json.data) return Boolean(json.data.node);
    return null; // some other error shape (bad auth, timeout-like) — inconclusive
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// prevKnown: [{ kind: "discussion", id, repo, discussionNumber, author, body, createdAt, url, lastCheckedAt }, ...]
export async function checkDiscussionActivity(repos, sinceIso, prevKnown = []) {
  const results = await Promise.all(repos.map((r) => fetchRepoDiscussions(r, sinceIso)));
  const newDiscussions = results.flatMap((r) => r.newDiscussions);
  const newComments = results.flatMap((r) => r.newComments);

  const now = Date.now();
  const { due, notDue } = partitionForDeletionCheck(prevKnown, now);
  const existenceChecks = await Promise.all(
    due.map(async (c) => ({ comment: c, exists: await discussionCommentStillExists(c.id) }))
  );
  const { deleted: deletedComments, stillKnown } = applyDeletionResults(existenceChecks, notDue, now);

  const knownById = new Map(stillKnown.map((c) => [c.id, c]));
  for (const c of newComments) knownById.set(c.id, { ...c, lastCheckedAt: new Date(now).toISOString() });

  return { newDiscussions, newComments, deletedComments, known: [...knownById.values()] };
}
