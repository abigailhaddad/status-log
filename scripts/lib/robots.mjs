import { fetchText } from "./http-check.mjs";

// Minimal robots.txt parser: honors Disallow/Allow for "*" and for our own
// user-agent token, ignores everything else (crawl-delay is respected
// separately by the crawler's own fixed delay, which is already more
// conservative than most sites request).
export async function loadRobotsRules(origin) {
  const { ok, text } = await fetchText(`${origin}/robots.txt`);
  if (!ok || !text) return { disallow: [], allow: [], crawlDelaySeconds: 0, sitemaps: [] };

  const rules = { disallow: [], allow: [], crawlDelaySeconds: 0, sitemaps: [] };
  let applies = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || /status-log/i.test(value);
    } else if (applies && key === "disallow" && value) {
      rules.disallow.push(value);
    } else if (applies && key === "allow" && value) {
      rules.allow.push(value);
    } else if (applies && key === "crawl-delay" && value) {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds)) rules.crawlDelaySeconds = Math.max(rules.crawlDelaySeconds, seconds);
    } else if (key === "sitemap" && value) {
      // Sitemap: is a global directive, not scoped to a user-agent block —
      // sites like va.gov point it at a non-default filename (sitemap_index.xml).
      rules.sitemaps.push(value);
    }
  }
  return rules;
}

export function isPathAllowed(rules, pathname) {
  const matches = (prefix) => pathname.startsWith(prefix);
  const disallowMatch = rules.disallow.find(matches);
  if (!disallowMatch) return true;
  const allowMatch = rules.allow.find(matches);
  // Longer, more specific Allow overrides a shorter Disallow.
  return Boolean(allowMatch && allowMatch.length >= disallowMatch.length);
}
