// A bare @handle inside third-party text (a commit message, a PR title) —
// e.g. "Add contributor information for @natalialuzuriaga" — becomes a real,
// notifying GitHub @mention once that text is rendered into an issue body.
// Wrapping it in a code span suppresses GitHub's mention-detection the same
// way it suppresses PR/commit link cross-references elsewhere in this repo
// (see person-watch.mjs) — confirmed empirically for links; applied here on
// the same principle for mentions, since both are markdown-render-time
// GitHub behaviors triggered by plain (non-code-span) text.
export function escapeMentions(text) {
  return escapeRefs(text).replace(/(?<![\w`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g, "`@$1`");
}

// Cross-repo issue/PR shorthand — "uswds/uswds#6997" — is the other thing
// GitHub auto-links at render time. In an issue body it posts a public
// "mentioned this pull request/issue" event on the TARGET, so a plain
// `${repo}#${number}` leaves a visible trace on whatever we're watching
// (the same leak person-watch.mjs closes for full URLs). Code-span it.
// The lookbehind skips text already in a code span and URL path segments.
export function escapeRefs(text) {
  return text.replace(
    /(?<![\w`/.@-])([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+#\d+)(?![\w`])/g,
    "`$1`"
  );
}
