# status-log

Scheduled checks and data collection. Runs on a schedule via GitHub Actions,
diffs each run against the last, and files an issue when something notable
changes.

All checks use publicly available data (DNS, Certificate Transparency logs,
HTTP responses, robots.txt/sitemap.xml, public GitHub API) — no
authentication bypass, no scraping behind login walls, nothing outside
normal browser-equivalent requests.

## What it does

**`.github/workflows/watch.yml`** — runs on a schedule:
- Resolves DNS for the configured target(s) and records nameservers.
- Queries Certificate Transparency logs for newly issued TLS certs (a common
  leading indicator of an upcoming change).
- Checks for new commits and broader public GitHub activity (pushes, PR
  opens/merges, branch creation, a repo going public) against whatever is
  configured in `config/watch-targets.yml` — see that file for the current
  list; nothing about what/who it covers is duplicated here. One org's repo
  list is fetched dynamically each run, not hardcoded, so a *new* repo
  appearing there fires an immediate alert rather than requiring a code
  change to notice.
- Once the target responds, fetches `robots.txt` / `sitemap.xml` and scans
  the page source + response headers for known signatures.
- Diffs every run against the previous one and commits all results to
  `data/` so the whole history is diffable in git. Only target-itself events
  (goes live/down, a new relevant cert, a brand-new repo appearing) open a
  GitHub issue immediately — routine commit and account activity is still
  recorded every run but rolls up into the daily digest below instead of
  filing an issue every time.
- All embedded GitHub links, and any bare `@handle` in third-party commit
  messages or PR titles, are wrapped in backticks before going into an issue
  body — a plain link or mention triggers GitHub's own cross-reference/
  notification behavior on the linked PR or mentioned account. Code-span
  syntax suppresses that detection entirely.

**`.github/workflows/daily-digest.yml`** — runs once daily: rolls up
everything `watch.yml` recorded that day into a single digest issue, instead
of filing one every time any of it fires. Tracks its own watermark in
`data/digest-state.json` so each day only covers what's new since the last
digest.

**`.github/workflows/deep-audit.yml`** — runs once daily, but does nothing
until `watch.yml` has observed the target as live (checked via
`data/latest.json` before installing anything heavy):
- Lighthouse (performance / SEO / best practices / accessibility scores).
- A full `axe-core` accessibility scan via Playwright.
- A full-page screenshot, diffed against the previous run's screenshot, to
  catch visual/feature changes.
- **A polite same-site crawl** (`scripts/lib/crawler.mjs`): discovers pages
  from `sitemap.xml` plus in-page links, visits up to 30 of them sequentially
  (1.5s delay between pages, robots.txt-respecting, no concurrency — this is
  a scripted single visitor, not a load test), and on every page tries any
  chat/search input it finds with a rotating benign test question.
- **Full network capture during that crawl**: every request/response is
  recorded into one HAR file (uploaded as a 90-day CI artifact), plus a
  lightweight committed summary (`data/network/latest.json`) listing every
  unique host contacted, which ones match known third-party service
  signatures, and whether any response body matches a known
  streaming-protocol fingerprint — this catches a proxied integration even
  when it never touches a third-party host directly from the browser.
- Captures WebSocket traffic too (HAR doesn't include WS frames): every
  frame sent/received is logged and run through the same signature
  detection as HTTP bodies.
- Dismisses an ordinary cookie-consent banner automatically (like any real
  visitor would) but *detects and reports rather than bypasses* an actual
  bot-check/CAPTCHA wall, so a blocked crawl shows up as "blocked," not as
  silent empty results.
- Runs the axe-core accessibility scan on every crawled page, not just the
  homepage (reusing the page already loaded during the crawl).
- After sending a chat test message, waits for network activity to actually
  settle rather than a fixed delay, so it doesn't cut off a slow-streaming
  response early.
- Files a GitHub issue if accessibility violations are found, or if the
  crawl turns up a new host, a new signature match, a new protocol
  signature, or a bot-wall/CAPTCHA, compared to the previous run.
- **If the crawl finds a working chat widget, evaluates it**
  (`scripts/lib/chat-eval.mjs`): opens the widget fresh (a real
  conversation, not the crawl's own throwaway probe message) and asks a
  fixed battery of benign questions — real service questions (does it
  actually work), a coding question and a "write a haiku" request
  (complying is a strong signal it's a general-purpose foundation model
  with light topic guardrails, not a narrow scripted assistant), a direct
  "what model powers you" question, and a garbled-input robustness check.
  The full transcript and a grade per answer are saved to `data/chat-eval/`
  and a GitHub issue is filed with the summary. Capped to 2 pages per run
  since it's a real conversation with a live, possibly third-party-backed
  system.

## Data layout

```
data/
  latest.json           # most recent full snapshot
  history.jsonl         # one compact line per check, for trend-watching
  events/               # a JSON file per run where something changed
  lighthouse/*.json      # per-run Lighthouse reports (deep audit only)
  a11y/*.json            # per-run axe-core reports (deep audit only)
  screenshots/*.png       # per-run full-page screenshots (deep audit only)
  network/latest.json    # crawl-wide summary: hosts, signature matches, protocol signatures
  chat-eval/*.json        # full transcript + grade for each chatbot evaluation (deep audit only)
  deep-audit-latest.json # summary of the most recent deep audit
```

## Running locally

```
npm install
node scripts/check.mjs        # lightweight watch — no extra deps needed
node scripts/deep-audit.mjs   # only runs once data/latest.json says live:true
```

## Notes

- `watch.yml` needs `contents: write` and `issues: write` (already set) to
  commit data and file issues using the default `GITHUB_TOKEN` — no extra
  secrets required.
- Certificate Transparency lookups hit a free community service that's
  occasionally slow/rate-limited; failures there are recorded but don't
  fail the run.
- To change what's monitored (target, repos, org, accounts), edit
  `config/watch-targets.yml` — nothing else needs updating.
