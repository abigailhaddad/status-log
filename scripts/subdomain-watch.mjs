// Alerts only when a hostname under america.gov appears in Certificate
// Transparency (crt.sh or Cert Spotter) for the first time. Renewals of known hosts are ignored.
// State: data/known-hostnames.json  { updated, names: { "<host>": "<first seen>" } }
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { WATCH_TARGETS } from "./lib/watch-targets.mjs";

const DOMAIN = WATCH_TARGETS.domain;
const STATE_PATH = path.join("data", "known-hostnames.json");
const SUFFIX = `.${DOMAIN}`;

function addName(names, raw, notBefore) {
  const n = String(raw).trim().toLowerCase();
  if (n !== DOMAIN && !n.endsWith(SUFFIX)) return; // drops emails and other domains on shared certs
  const prev = names.get(n);
  if (!prev || notBefore < prev) names.set(n, notBefore);
}

async function withRetries(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  throw lastErr;
}

// crt.sh: full history, but often returns 502s and has gaps.
async function fetchCrtSh() {
  const res = await fetch(`https://crt.sh/?q=%25.${DOMAIN}&output=json`, {
    signal: AbortSignal.timeout(90000),
    headers: { "user-agent": "status-log/1.0" },
  });
  if (!res.ok) throw new Error(`crt.sh HTTP ${res.status}`);
  const rows = await res.json();
  const names = new Map(); // name -> earliest not_before
  for (const r of rows) {
    for (const raw of String(r.name_value || "").split("\n")) addName(names, raw, r.not_before);
  }
  return { names, rowCount: rows.length };
}

// Cert Spotter: only unexpired certs, which is enough to catch a new host.
// Unauthenticated limit is 10 requests/hour; one page normally covers it.
async function fetchCertSpotter() {
  const names = new Map();
  let rowCount = 0;
  let after = "";
  for (let page = 0; page < 5; page++) {
    const url = `https://api.certspotter.com/v1/issuances?domain=${DOMAIN}&include_subdomains=true&expand=dns_names${after ? `&after=${after}` : ""}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60000),
      headers: { "user-agent": "status-log/1.0" },
    });
    if (!res.ok) throw new Error(`certspotter HTTP ${res.status}`);
    const rows = await res.json();
    if (rows.length === 0) break;
    rowCount += rows.length;
    for (const r of rows) {
      for (const raw of r.dns_names || []) addName(names, raw, r.not_before);
    }
    after = rows[rows.length - 1].id;
  }
  return { names, rowCount };
}

// Union of every source that answers. Fails only if all of them fail.
async function fetchNames() {
  const sources = { "crt.sh": fetchCrtSh, certspotter: fetchCertSpotter };
  const names = new Map();
  let rowCount = 0;
  const ok = [];
  for (const [label, fn] of Object.entries(sources)) {
    try {
      const got = await withRetries(fn);
      for (const [n, nb] of got.names) addName(names, n, nb);
      rowCount += got.rowCount;
      ok.push(`${label} (${got.names.size} names)`);
    } catch (e) {
      console.warn(`${label} failed: ${e.message}`);
    }
  }
  if (ok.length === 0) throw new Error("every CT source failed; leaving state untouched");
  console.log(`sources ok: ${ok.join(", ")}`);
  return { names, rowCount };
}

async function main() {
  let state = null;
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {}

  // If every source fails, exit non-zero and leave state untouched, so a
  // bad fetch can never be mistaken for "everything is new" next time.
  const { names, rowCount } = await fetchNames();
  if (names.size === 0) throw new Error(`CT sources returned ${rowCount} rows but no ${DOMAIN} names; refusing to update`);

  const now = new Date().toISOString();
  const baseline = !state;
  const known = state?.names || {};
  const fresh = [...names.keys()].filter((n) => !(n in known)).sort();
  for (const n of fresh) known[n] = baseline ? `baseline ${now.slice(0, 10)}` : now;

  // Only touch the file when something changed, so quiet runs make no commit.
  if (fresh.length > 0 || baseline) {
    await mkdir("data", { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify({ updated: now, names: known }, null, 2) + "\n");
  }
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
