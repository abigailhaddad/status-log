// Weekly "what does the shape of activity look like" report — commit
// volume/authorship/timing plus the most-reacted comments — across the
// tracked repos. Complements check.mjs's real-time "what's new" alerts with
// a periodic step back: is one author dominating, is the pace plausible for
// a human, and what did the community react most strongly to (in either
// direction). See scripts/lib/weekly-summary.mjs for the actual logic.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  collectWeeklyCommits,
  summarizeCommits,
  formatSummaryMarkdown,
  collectWeeklyComments,
  formatCommentsMarkdown,
} from "./lib/weekly-summary.mjs";
import { WATCH_TARGETS } from "./lib/watch-targets.mjs";

const DATA_DIR = path.join(process.cwd(), "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const SUMMARY_DIR = path.join(DATA_DIR, "weekly-summary");

async function trackedRepos() {
  // Reuses check.mjs's already-current org-repo discovery from the latest
  // snapshot rather than re-querying the org here — one fewer live call,
  // and the two stay consistent with whatever check.mjs is currently
  // tracking commits/comments against.
  try {
    const latest = JSON.parse(await readFile(LATEST_PATH, "utf8"));
    return [...new Set([...WATCH_TARGETS.repos, ...(latest.org?.repos || [])])];
  } catch {
    return WATCH_TARGETS.repos;
  }
}

async function main() {
  await mkdir(SUMMARY_DIR, { recursive: true });

  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 3600 * 1000);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  const repos = await trackedRepos();

  const [commits, comments] = await Promise.all([
    collectWeeklyCommits(repos, sinceIso, untilIso),
    collectWeeklyComments(repos, sinceIso),
  ]);

  const commitSummary = summarizeCommits(commits);
  const commitsMarkdown = formatSummaryMarkdown(commitSummary, { sinceIso, untilIso, repoCount: repos.length });
  const commentsMarkdown = formatCommentsMarkdown(comments);

  const body = [commitsMarkdown, commentsMarkdown].filter(Boolean).join("\n\n");

  const record = {
    sinceIso,
    untilIso,
    repos,
    commitSummary,
    topUpvotedComments: comments.filter((c) => c.up > 0).sort((a, b) => b.up - a.up).slice(0, 10),
    topDownvotedComments: comments.filter((c) => c.down > 0).sort((a, b) => b.down - a.down).slice(0, 10),
  };
  const stamp = untilIso.replace(/[:.]/g, "-");
  await writeFile(path.join(SUMMARY_DIR, `${stamp}.json`), JSON.stringify(record, null, 2) + "\n");
  await writeFile(path.join(SUMMARY_DIR, "latest.json"), JSON.stringify(record, null, 2) + "\n");

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFile } = await import("node:fs/promises");
    const delimiter = `SUMMARY_BODY_${Math.random().toString(36).slice(2)}`;
    await appendFile(ghOutput, `summary_body<<${delimiter}\n${body}\n${delimiter}\n`);
  }

  console.log(`Weekly summary ${sinceIso} -> ${untilIso}: ${commitSummary.total} commits, ${comments.length} comments across ${repos.length} repos`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
