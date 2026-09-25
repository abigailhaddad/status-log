// Polite, same-site BFS crawl: discovers pages from sitemap.xml plus in-page
// links, visits each one sequentially with a fixed delay between requests
// (never concurrent, never faster than a careful human clicking around),
// skips anything robots.txt disallows, and on every page tries the chat/
// search widget (if one exists) with a rotating benign test question so we
// can see what it calls. Everything is recorded into one shared HAR file.
import { fetchText } from "./http-check.mjs";
import { loadRobotsRules, isPathAllowed } from "./robots.mjs";
import {
  attachResponseListener,
  attachFailedRequestListener,
  attachWebSocketListener,
  findAndUseChatInput,
  handlePageBlockers,
  CHAT_TEST_MESSAGES,
} from "./network-capture.mjs";

const POLITE_DELAY_MS = 1500;
const NAV_TIMEOUT_MS = 20000;
const POST_CHAT_IDLE_TIMEOUT_MS = 20000;

async function discoverSitemapUrls(origin, robotsSitemaps = []) {
  const urls = new Set();
  // Not every site's sitemap lives at the conventional /sitemap.xml — some
  // (e.g. va.gov) only advertise a differently-named index via robots.txt's
  // Sitemap: directive, so try both and dedupe.
  const entrypoints = new Set([`${origin}/sitemap.xml`, ...robotsSitemaps]);

  const visitedSitemaps = new Set();
  const queue = [...entrypoints];
  // One level of sitemap-index recursion is plenty for reconnaissance, but
  // cap total sitemap fetches too in case of a pathological index chain.
  while (queue.length > 0 && visitedSitemaps.size < 15) {
    const sitemapUrl = queue.shift();
    if (visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    const { ok, text } = await fetchText(sitemapUrl);
    if (!ok || !text) continue;

    const locMatches = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    const sitemapRefs = locMatches.filter((u) => /sitemap.*\.xml$/i.test(u));
    const pageRefs = locMatches.filter((u) => !/sitemap.*\.xml$/i.test(u));
    pageRefs.forEach((u) => urls.add(u));
    sitemapRefs.forEach((u) => {
      if (!visitedSitemaps.has(u)) queue.push(u);
    });
  }
  return urls;
}

function normalize(url, origin) {
  try {
    const u = new URL(url, origin);
    u.hash = "";
    if (u.origin !== origin) return null;
    // Drop obvious non-HTML assets from the crawl frontier — otherwise
    // page.goto() starts a real file download and throws. Some CMSes (e.g.
    // medicare.gov) append a disambiguating "-0"/"-1" suffix after the
    // extension for duplicate filenames, so allow an optional numeric tail.
    if (
      /\.(png|jpg|jpeg|gif|svg|webp|css|js|ico|pdf|xml|json|woff2?|ttf|epub|mobi|docx?|xlsx?|pptx?|zip|mp3|mp4)(-\d+)?$/i.test(
        u.pathname
      )
    ) {
      return null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

export async function crawlSite({ startUrl, maxPages = 25, harPath, scanAccessibility = false }) {
  const origin = new URL(startUrl).origin;
  const rules = await loadRobotsRules(origin);
  const politeDelayMs = Math.max(POLITE_DELAY_MS, (rules.crawlDelaySeconds || 0) * 1000);

  const sitemapUrls = await discoverSitemapUrls(origin, rules.sitemaps);
  const queue = [startUrl, ...sitemapUrls];
  const visited = new Set();
  const pages = [];
  const requestLog = [];
  const bodySamples = [];
  const chatAttempts = [];
  const wsLog = [];
  const blockersFound = [];
  const a11yByPage = [];

  let AxeBuilder = null;
  if (scanAccessibility) {
    ({ default: AxeBuilder } = await import("@axe-core/playwright"));
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      recordHar: { path: harPath, content: "embed" },
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    attachResponseListener(page, requestLog, bodySamples);
    attachFailedRequestListener(page, requestLog);
    attachWebSocketListener(page, wsLog);

    let messageIndex = 0;
    while (queue.length > 0 && visited.size < maxPages) {
      const rawUrl = queue.shift();
      const url = normalize(rawUrl, origin);
      if (!url || visited.has(url)) continue;
      const pathname = new URL(url).pathname;
      if (!isPathAllowed(rules, pathname)) {
        pages.push({ url, skipped: "robots_disallowed" });
        continue;
      }
      visited.add(url);

      let navError = null;
      let title = null;
      let finalUrl = url;
      let httpStatus = null;
      try {
        // "networkidle" never fires on sites with continuous background
        // ad-tech/analytics beacons (common on .gov sites with heavy trackers)
        // — "load" is far more reliable and still means the page rendered.
        const response = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
        if (!response) {
          navError = "no_response";
        } else {
          httpStatus = response.status();
        }

        // A <meta http-equiv="refresh"> redirect (common on .gov sites for
        // preserving old bookmarked URLs, e.g. CDC's COVID-era link
        // consolidation) fires as a separate navigation *after* page.goto()
        // already resolved — without waiting for it, we'd capture the
        // transient "Loading..." stub instead of the real destination page.
        if (!navError) {
          const hasMetaRefresh = await page
            .locator('meta[http-equiv="refresh" i]')
            .count()
            .then((c) => c > 0)
            .catch(() => false);
          if (hasMetaRefresh) {
            const preRefreshUrl = page.url();
            await page.waitForURL((u) => u.toString() !== preRefreshUrl, { timeout: 8000 }).catch(() => {});
            await page.waitForLoadState("load", { timeout: 8000 }).catch(() => {});
          }
        }

        title = await page.title().catch(() => null);
        finalUrl = page.url();
      } catch (e) {
        const message = e.message || String(e);
        // Defense in depth: the extension filter in normalize() should
        // catch downloadable files before we ever get here, but a link with
        // no recognizable extension (driven by a Content-Disposition header)
        // can still slip through and trigger this from Playwright/Chromium.
        navError = /download is starting/i.test(message) ? "file_download_not_crawlable" : message;
      }
      // Some paths (e.g. auth-gated VA.gov pages) silently redirect to an
      // entirely different page rather than erroring — without this, we'd
      // misattribute the landing page's forms/content/a11y to the URL we
      // actually requested.
      const redirectedAway = !navError && finalUrl !== url;

      let pageBlockers = { blockers: [] };
      if (!navError) {
        pageBlockers = await handlePageBlockers(page).catch(() => ({ blockers: [] }));
        if (pageBlockers.blockers.length > 0) {
          blockersFound.push({ url, blockers: pageBlockers.blockers });
        }
      }

      let forms = [];
      let links = [];
      if (!navError) {
        forms = await page
          .$$eval("form", (fs) =>
            fs.map((f) => ({
              action: f.action || null,
              method: (f.method || "get").toLowerCase(),
              fields: [...f.elements].map((el) => el.name).filter(Boolean),
            }))
          )
          .catch(() => []);
        links = await page
          .$$eval("a[href]", (as) => as.map((a) => a.href))
          .catch(() => []);
      }

      const testMessage = CHAT_TEST_MESSAGES[messageIndex % CHAT_TEST_MESSAGES.length];
      messageIndex++;
      let chatAttempt = { used: false, selector: null };
      if (!navError) {
        chatAttempt = await findAndUseChatInput(page, testMessage).catch(() => ({ used: false, selector: null }));
        if (chatAttempt.used) {
          // Wait for the (likely streamed) response to actually finish
          // rather than guessing a fixed delay — settles as soon as network
          // activity quiets down, capped so a stuck stream can't hang the crawl.
          await page.waitForLoadState("networkidle", { timeout: POST_CHAT_IDLE_TIMEOUT_MS }).catch(() => {});
        }
      }
      chatAttempts.push({ url, testMessage, ...chatAttempt });

      let a11y = null;
      if (scanAccessibility && !navError) {
        try {
          const axeResults = await new AxeBuilder({ page }).analyze();
          a11y = {
            violationCount: axeResults.violations?.length ?? 0,
            violations: (axeResults.violations || []).map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes?.length })),
          };
        } catch (e) {
          a11y = { error: e.message || String(e) };
        }
        a11yByPage.push({ url, ...a11y });
      }

      pages.push({
        url,
        redirectedTo: redirectedAway ? finalUrl : null,
        title,
        httpStatus,
        navError,
        formCount: forms.length,
        forms,
        chatInputFound: chatAttempt.used,
        blockers: pageBlockers.blockers,
        a11yViolationCount: a11y?.violationCount ?? null,
      });

      for (const link of links) {
        const normalizedLink = normalize(link, origin);
        if (normalizedLink && !visited.has(normalizedLink) && !queue.includes(normalizedLink)) {
          queue.push(normalizedLink);
        }
      }

      if (queue.length > 0 && visited.size < maxPages) {
        await page.waitForTimeout(politeDelayMs);
      }
    }

    await context.close(); // flushes HAR
  } finally {
    await browser.close();
  }

  return { pages, requestLog, bodySamples, chatAttempts, wsLog, blockersFound, a11yByPage };
}
