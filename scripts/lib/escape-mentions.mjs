// A bare @handle inside third-party text (a commit message, a PR title) —
// e.g. "Add contributor information for @natalialuzuriaga" — becomes a real,
// notifying GitHub @mention once that text is rendered into an issue body.
// Wrapping it in a code span suppresses GitHub's mention-detection the same
// way it suppresses PR/commit link cross-references elsewhere in this repo
// (see person-watch.mjs) — confirmed empirically for links; applied here on
// the same principle for mentions, since both are markdown-render-time
// GitHub behaviors triggered by plain (non-code-span) text.
export function escapeMentions(text) {
  return text.replace(/(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g, "`@$1`");
}
