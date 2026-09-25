import dns from "node:dns/promises";
import { WATCH_TARGETS } from "./watch-targets.mjs";

const DOMAIN = WATCH_TARGETS.domain;
const HOSTS = [DOMAIN, `www.${DOMAIN}`];

async function resolveHost(host) {
  const result = { host, a: [], aaaa: [], cname: null, ns: [], error: null };
  try {
    result.a = await dns.resolve4(host);
  } catch (e) {
    result.a = [];
  }
  try {
    result.aaaa = await dns.resolve6(host);
  } catch (e) {
    result.aaaa = [];
  }
  try {
    result.cname = await dns.resolveCname(host);
  } catch (e) {
    result.cname = null;
  }
  if (result.a.length === 0 && result.aaaa.length === 0 && !result.cname) {
    result.error = "NXDOMAIN_OR_NO_RECORDS";
  }
  return result;
}

export async function checkDns() {
  const hosts = {};
  for (const h of HOSTS) {
    hosts[h] = await resolveHost(h);
  }
  try {
    hosts[DOMAIN].ns = await dns.resolveNs(DOMAIN);
  } catch (e) {
    hosts[DOMAIN].ns = [];
  }
  return hosts;
}
