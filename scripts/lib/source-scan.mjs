// Greps rendered HTML/response headers for known integration and hosting
// signatures. This is a static-source grep only — it never executes site JS
// or attempts to bypass any access control.
const SIGNATURES = [
  { key: "grok_xai", pattern: /x\.ai|grok/i },
  { key: "openai", pattern: /openai|chatgpt/i },
  { key: "anthropic_claude", pattern: /anthropic|claude/i },
  { key: "login_gov", pattern: /secure\.login\.gov|login\.gov/i },
  { key: "uswds", pattern: /uswds/i },
  { key: "vercel", pattern: /vercel/i },
  { key: "cloud_gov", pattern: /cloud\.gov|cloudfoundry/i },
  { key: "google_analytics", pattern: /gtag\(|googletagmanager|google-analytics/i },
  { key: "irs_direct_file_terms", pattern: /direct[\s-]?file/i },
];

export function scanSource(text) {
  if (!text) return {};
  const matches = {};
  for (const { key, pattern } of SIGNATURES) {
    matches[key] = pattern.test(text);
  }
  return matches;
}

export function scanHeaders(headers) {
  if (!headers) return {};
  const flat = JSON.stringify(headers).toLowerCase();
  return {
    server: headers.server || null,
    via: headers.via || null,
    x_vercel_id: headers["x-vercel-id"] || null,
    cf_ray: headers["cf-ray"] || null,
    hsts: headers["strict-transport-security"] || null,
    csp: headers["content-security-policy"] || null,
    x_powered_by: headers["x-powered-by"] || null,
    looks_like_akamai: /akamai/.test(flat),
    looks_like_cloudflare: /cloudflare|cf-ray/.test(flat),
  };
}
