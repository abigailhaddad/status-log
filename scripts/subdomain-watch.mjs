// Alerts only when a hostname under america.gov appears in Certificate
// Transparency for the first time. Renewals of known hosts are ignored.
// State: data/known-hostnames.json  { updated, names: { "<host>": "<first seen>" } }
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { WATCH_TARGETS } from "./lib/watch-targets.mjs";

const DOMAIN = WATCH_TARGETS.domain;
const STATE_PATH = path.join("data", "known-hostnames.json");
const SUFFIX = `.${DOMAIN}`;

async function fetchNames() {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://crt.sh/?q=%25.${DOMAIN}&output=json`, {
        signal: AbortSignal.timeout(90000),
        headers: { "user-agent": "status-log/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      const names = new Map(); // name -> earliest not_before
      for (const r of rows) {
        for (const raw of String(r.name_value || "").split("\n")) {
          const n = raw.trim().toLowerCase();
          if (n !== DOMAIN && !n.endsWith(SUFFIX)) continue; // drops emails and other domains on shared certs
          const prev = names.get(n);
          if (!prev || r.not_before < prev) names.set(n, r.not_before);
        }
      }
      return { names, rowCount: rows.length };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  throw lastErr;
}

async function main() {
  let state = null;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {}

  // crt.sh is flaky. On failure exit non-zero and leave state untouched, so a
  // bad fetch can never be mistaken for "everything is new" next time.
  const { names, rowCount } = await fetchNames();
  if (names.size === 0) throw new Error(`crt.sh returned ${rowCount} rows but no ${DOMAIN} names; refusing to update`);

  const now = new Date().toISOString();
  const baseline = !state;
  const known = state?.names || {};
  const fresh = [...names.keys()].filter((n) => !(n in known)).sort();
  for (const n of fresh) known[n] = baseline ? `baseline ${now.slice(0, 10)}` : now;

  await mkdir("data", { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ updated: now, names: known }, null, 2) + "\n");
  console.log(`${names.size} names in CT (${rowCount} cert rows); ${fresh.length} ${baseline ? "baselined" : "new"}`);

  const out = process.env.GITHUB_OUTPUT;
  if (out && !baseline && fresh.length > 0) {
    const detail = fresh.map((n) => `- \`${n}\` (earliest cert ${names.get(n)})`).join("\n");
    await appendFile(out, `changed=true\nsummary=${fresh.length} new hostname(s): ${fresh.slice(0, 3).join(", ")}${fresh.length > 3 ? ", ..." : ""}\n`);
    await appendFile(out, `details<<EOF_HOSTS\n${detail}\nEOF_HOSTS\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
