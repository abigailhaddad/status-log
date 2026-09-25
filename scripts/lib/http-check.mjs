const TIMEOUT_MS = 12000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "manual",
      ...opts,
      signal: controller.signal,
      headers: {
        "user-agent": "status-log/1.0",
        ...opts.headers,
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Follows a small number of redirects manually so we can record the chain.
async function fetchChain(url, maxHops = 5) {
  const chain = [];
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    let res;
    try {
      res = await fetchWithTimeout(current);
    } catch (e) {
      chain.push({ url: current, error: e.message || String(e) });
      return { chain, finalStatus: null, finalHeaders: null, body: null };
    }
    const headers = Object.fromEntries(res.headers.entries());
    chain.push({ url: current, status: res.status, headers });
    if ([301, 302, 303, 307, 308].includes(res.status) && headers.location) {
      current = new URL(headers.location, current).toString();
      continue;
    }
    let body = null;
    try {
      body = await res.text();
    } catch (e) {
      body = null;
    }
    return { chain, finalStatus: res.status, finalHeaders: headers, body };
  }
  return { chain, finalStatus: null, finalHeaders: null, body: null };
}

export async function checkHttp(host) {
  const result = {
    host,
    reachable: false,
    finalStatus: null,
    finalHeaders: null,
    redirectChain: null,
    bodyLength: null,
    bodySnippet: null,
    error: null,
  };
  const { chain, finalStatus, finalHeaders, body } = await fetchChain(`https://${host}/`);
  result.redirectChain = chain;
  const last = chain[chain.length - 1];
  if (last?.error) {
    result.error = last.error;
    return result;
  }
  result.reachable = true;
  result.finalStatus = finalStatus;
  result.finalHeaders = finalHeaders;
  if (body) {
    result.bodyLength = body.length;
    result.bodySnippet = body.slice(0, 2000);
  }
  return result;
}

export async function fetchText(url) {
  try {
    // Unlike checkHttp (which wants the redirect chain), callers of
    // fetchText just want the final content — e.g. robots.txt commonly
    // points at a sitemap path that 301s to a versioned/CDN URL.
    const res = await fetchWithTimeout(url, { redirect: "follow" });
    if (!res.ok) return { ok: false, status: res.status, text: null };
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (e) {
    return { ok: false, status: null, text: null, error: e.message || String(e) };
  }
}
