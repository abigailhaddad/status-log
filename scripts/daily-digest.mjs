// Rolls up commit and account-activity events (recorded every hour by
// check.mjs into data/events/, but no longer emailed hourly — see
// check.mjs's IMMEDIATE_EVENT_TYPES) into one daily "what happened" digest.
// Target-itself events (live/down/new cert) stay on the hourly alert in
// watch.yml; this is only for the lower-priority noise.
import { readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const EVENTS_DIR = path.join(DATA_DIR, "events");
const STATE_PATH = path.join(DATA_DIR, "digest-state.json");

const DIGEST_EVENT_TYPES = new Set(["NEW_REPO_COMMITS", "NEW_PERSON_ACTIVITY", "NEW_ISSUE", "NEW_DISCUSSION", "NEW_COMMENT"]);

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return { lastDigestedAt: null };
  }
}

async function main() {
  const state = await loadState();
  const since = state.lastDigestedAt ? new Date(state.lastDigestedAt) : new Date(0);
  const now = new Date();

  let files;
  try {
    files = await readdir(EVENTS_DIR);
  } catch {
    files = [];
  }

  const collected = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(EVENTS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const ts = new Date(parsed.timestamp);
    if (ts <= since || ts > now) continue;
    for (const e of parsed.events || []) {
      if (DIGEST_EVENT_TYPES.has(e.type)) {
        collected.push({ timestamp: parsed.timestamp, type: e.type, detail: e.detail });
      }
    }
  }

  collected.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const commitEvents = collected.filter((e) => e.type === "NEW_REPO_COMMITS");
  const personEvents = collected.filter((e) => e.type === "NEW_PERSON_ACTIVITY");
  const issueEvents = collected.filter((e) => e.type === "NEW_ISSUE");
  const discussionEvents = collected.filter((e) => e.type === "NEW_DISCUSSION");
  const commentEvents = collected.filter((e) => e.type === "NEW_COMMENT");

  const sections = [];
  if (commitEvents.length > 0) {
    sections.push(`## Repo commits\n\n${commitEvents.map((e) => e.detail).join("\n\n")}`);
  }
  if (issueEvents.length > 0) {
    sections.push(`## New issues/PRs\n\n${issueEvents.map((e) => e.detail).join("\n\n")}`);
  }
  if (discussionEvents.length > 0) {
    sections.push(`## New discussions\n\n${discussionEvents.map((e) => e.detail).join("\n\n")}`);
  }
  if (commentEvents.length > 0) {
    sections.push(`## New comments\n\n${commentEvents.map((e) => e.detail).join("\n\n")}`);
  }
  if (personEvents.length > 0) {
    sections.push(`## Account activity\n\n${personEvents.map((e) => e.detail).join("\n\n")}`);
  }

  const hasContent = sections.length > 0;
  const digestBody = hasContent
    ? `Covering ${since.toISOString()} → ${now.toISOString()}.\n\n${sections.join("\n\n")}`
    : "";

  await writeFile(STATE_PATH, JSON.stringify({ lastDigestedAt: now.toISOString() }, null, 2) + "\n");

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const lines = [`has_content=${hasContent}`];
    await appendFile(ghOutput, lines.join("\n") + "\n");
    const delimiter = `DIGEST_BODY_${Math.random().toString(36).slice(2)}`;
    await appendFile(ghOutput, `digest_body<<${delimiter}\n${digestBody || "none"}\n${delimiter}\n`);
  }

  console.log(`Digest window ${since.toISOString()} -> ${now.toISOString()}: ${collected.length} events (${commitEvents.length} commit, ${personEvents.length} person)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
