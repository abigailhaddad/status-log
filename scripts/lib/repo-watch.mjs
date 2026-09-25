// Watches a given list of repos for commits.
const TIMEOUT_MS = 15000;

async function fetchRepoCommits(repo) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = {
    "user-agent": "status-log/1.0",
    accept: "application/vnd.github+json",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  try {
    // 30 rather than 10 so an hourly check doesn't miss commits during a
    // burst of activity.
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=30`, {
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, commits: [] };
    }
    const raw = await res.json();
    const commits = raw.map((c) => ({
      repo,
      sha: c.sha,
      author: c.commit?.author?.name || c.author?.login || "unknown",
      githubLogin: c.author?.login || null,
      date: c.commit?.author?.date,
      message: c.commit?.message || "",
      url: c.html_url,
    }));
    return { ok: true, error: null, commits };
  } catch (e) {
    return { ok: false, error: e.message || String(e), commits: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkRepos(repos) {
  const results = await Promise.all(repos.map(fetchRepoCommits));
  const commits = results.flatMap((r) => r.commits);
  const errors = results.filter((r) => !r.ok).map((r) => r.error);
  return { ok: errors.length === 0, error: errors.join("; ") || null, commits };
}
