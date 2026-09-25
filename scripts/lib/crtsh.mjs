// Certificate Transparency log lookup via crt.sh. Public, no auth, no rate-limit
// key required, but the service is flaky under load so we fail soft.
import { WATCH_TARGETS } from "./watch-targets.mjs";

const DOMAIN = WATCH_TARGETS.domain;
const TIMEOUT_MS = 15000;

export async function checkCertTransparency() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://crt.sh/?q=%25.${DOMAIN}&output=json`, {
      signal: controller.signal,
      headers: { "user-agent": "status-log/1.0" },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, certs: [] };
    }
    const raw = await res.json();
    // Dedupe by common_name + not_before, sort newest first, cap to keep the
    // committed JSON small.
    const seen = new Set();
    const certs = [];
    for (const c of raw) {
      const key = `${c.common_name}|${c.not_before}`;
      if (seen.has(key)) continue;
      seen.add(key);
      certs.push({
        common_name: c.common_name,
        issuer: c.issuer_name,
        not_before: c.not_before,
        not_after: c.not_after,
      });
    }
    certs.sort((a, b) => new Date(b.not_before) - new Date(a.not_before));
    return { ok: true, error: null, certs: certs.slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e.message || String(e), certs: [] };
  } finally {
    clearTimeout(timer);
  }
}
