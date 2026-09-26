// Shared "did this comment get deleted?" bookkeeping for comment-watch.mjs
// (issue/PR comments, REST) and discussion-watch.mjs (discussion comments,
// GraphQL) — the check mechanism differs per source, but the caching policy
// is the same either way: a comment younger than a week gets re-verified
// every run, but once it ages past that, re-checking it at most once a week
// is enough — a comment that's survived a week isn't likely to vanish in
// the next hour, and this is what keeps the per-run check cost from growing
// unbounded as the known-comment set accumulates over time.
const RECENT_MS = 7 * 24 * 3600 * 1000;
const RECHECK_INTERVAL_MS = 7 * 24 * 3600 * 1000;

export function partitionForDeletionCheck(known, now = Date.now()) {
  const due = [];
  const notDue = [];
  for (const c of known) {
    const age = now - new Date(c.createdAt).getTime();
    const lastChecked = c.lastCheckedAt ? new Date(c.lastCheckedAt).getTime() : 0;
    if (age < RECENT_MS || now - lastChecked >= RECHECK_INTERVAL_MS) {
      due.push(c);
    } else {
      notDue.push(c);
    }
  }
  return { due, notDue };
}

// existenceChecks: [{ comment, exists }] — exists is true/false/null (null =
// inconclusive network/timeout error; never treated as a deletion, and left
// unstamped so it's retried again next run instead of going quiet for a week).
export function applyDeletionResults(existenceChecks, notDue, now = Date.now()) {
  const deleted = existenceChecks.filter((r) => r.exists === false).map((r) => r.comment);
  const survivors = existenceChecks
    .filter((r) => r.exists === true)
    .map((r) => ({ ...r.comment, lastCheckedAt: new Date(now).toISOString() }));
  const inconclusive = existenceChecks.filter((r) => r.exists === null).map((r) => r.comment);
  return { deleted, stillKnown: [...notDue, ...survivors, ...inconclusive] };
}
