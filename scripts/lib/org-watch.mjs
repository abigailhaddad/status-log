// Watches the org listed in config/watch-targets.yml directly. Repo list is
// fetched dynamically each run so a new repo appearing gets caught
// immediately rather than requiring a hardcoded name to be updated.
import { WATCH_TARGETS } from "./watch-targets.mjs";

const ORG = WATCH_TARGETS.org;
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
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: null, data: null, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRepoCommits(repo) {
  const { ok, data } = await fetchJson(`https://api.github.com/repos/${repo}/commits?per_page=30`);
  if (!ok || !Array.isArray(data)) return [];
  return data.map((c) => ({
    repo,
    sha: c.sha,
    author: c.commit?.author?.name || c.author?.login || "unknown",
    date: c.commit?.author?.date,
    message: c.commit?.message || "",
    url: c.html_url,
  }));
}

export async function checkOrgRepos() {
  const reposResult = await fetchJson(`https://api.github.com/orgs/${ORG}/repos?per_page=100`);
  if (!reposResult.ok || !Array.isArray(reposResult.data)) {
    return { ok: false, error: `HTTP ${reposResult.status}`, repos: [], commits: [] };
  }
  const repos = reposResult.data.map((r) => r.full_name);
  const commitLists = await Promise.all(repos.map(fetchRepoCommits));
  return { ok: true, error: null, repos, commits: commitLists.flat() };
}
