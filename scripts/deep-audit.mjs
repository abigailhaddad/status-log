// Heavier audit: only worth running once the target is actually reachable.
// Runs Lighthouse (perf/SEO/best-practices), an axe-core accessibility scan,
// and a screenshot diff against the previous run so visual/feature changes
// (e.g. a chatbot widget appearing or disappearing) are easy to spot.
import { mkdir, readFile, writeFile, readdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WATCH_TARGETS } from "./lib/watch-targets.mjs";

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(process.cwd(), "data");
const LATEST_PATH = path.join(DATA_DIR, "latest.json");
const LIGHTHOUSE_DIR = path.join(DATA_DIR, "lighthouse");
const A11Y_DIR = path.join(DATA_DIR, "a11y");
const SCREENSHOT_DIR = path.join(DATA_DIR, "screenshots");
const NETWORK_DIR = path.join(DATA_DIR, "network");
const CHAT_EVAL_DIR = path.join(DATA_DIR, "chat-eval");
const HAR_DIR = path.join(process.cwd(), "har-artifacts"); // uploaded as a CI artifact, never committed

const TARGET_URL = `https://${WATCH_TARGETS.domain}/`;
const MAX_CRAWL_PAGES = 30;
const MAX_CHAT_EVAL_PAGES = 2; // it's a live third-party-backed conversation — keep this small
const DISCOVERY_MESSAGE = "Hello"; // opens the conversation so eval questions get clean before/after diffs

async function getLatestScreenshot() {
  try {
    const files = (await readdir(SCREENSHOT_DIR)).filter((f) => f.endsWith(".png")).sort();
    return files.length ? path.join(SCREENSHOT_DIR, files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

async function runLighthouse(stamp) {
  await mkdir(LIGHTHOUSE_DIR, { recursive: true });
  const outPath = path.join(LIGHTHOUSE_DIR, `${stamp}.json`);
  try {
    await execFileAsync("npx", [
      "lighthouse",
      TARGET_URL,
      "--output=json",
      `--output-path=${outPath}`,
      "--chrome-flags=--headless=new --no-sandbox",
      "--quiet",
    ], { timeout: 120000 });
    const raw = JSON.parse(await readFile(outPath, "utf8"));
    return {
      ok: true,
      scores: {
        performance: raw.categories?.performance?.score,
        accessibility: raw.categories?.accessibility?.score,
        bestPractices: raw.categories?.["best-practices"]?.score,
        seo: raw.categories?.seo?.score,
      },
      reportPath: path.relative(process.cwd(), outPath),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function runAccessibilityAndScreenshot(stamp) {
  const { chromium } = await import("playwright");
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const { PNG } = await import("pngjs");
  const { default: pixelmatch } = await import("pixelmatch");

  await mkdir(A11Y_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 });

    const axeResults = await new AxeBuilder({ page }).analyze();
    const a11yPath = path.join(A11Y_DIR, `${stamp}.json`);
    await writeFile(a11yPath, JSON.stringify(axeResults, null, 2));

    const screenshotPath = path.join(SCREENSHOT_DIR, `${stamp}.png`);
    const prevScreenshotPath = await getLatestScreenshot();
    await page.screenshot({ path: screenshotPath, fullPage: true });

    let diffPercent = null;
    if (prevScreenshotPath) {
      try {
        const img1 = PNG.sync.read(await readFile(prevScreenshotPath));
        const img2 = PNG.sync.read(await readFile(screenshotPath));
        if (img1.width === img2.width && img1.height === img2.height) {
          const { width, height } = img1;
          const diff = new PNG({ width, height });
          const diffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold: 0.1 });
          diffPercent = (diffPixels / (width * height)) * 100;
        }
      } catch {
        diffPercent = null;
      }
    }

    return {
      ok: true,
      violationCount: axeResults.violations?.length ?? null,
      violationSummary: (axeResults.violations || []).map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes?.length })),
      a11yReportPath: path.relative(process.cwd(), a11yPath),
      screenshotPath: path.relative(process.cwd(), screenshotPath),
      diffPercentVsPrevious: diffPercent,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    await browser.close();
  }
}

async function loadPreviousNetworkSummary() {
  try {
    return JSON.parse(await readFile(path.join(NETWORK_DIR, "latest.json"), "utf8"));
  } catch {
    return null;
  }
}

async function runCrawlAndCapture(stamp) {
  const { crawlSite } = await import("./lib/crawler.mjs");
  const { summarizeNetworkActivity } = await import("./lib/network-capture.mjs");

  await mkdir(NETWORK_DIR, { recursive: true });
  await mkdir(HAR_DIR, { recursive: true });

  const harPath = path.join(HAR_DIR, `${stamp}.har`);
  let crawl;
  try {
    crawl = await crawlSite({ startUrl: TARGET_URL, maxPages: MAX_CRAWL_PAGES, harPath, scanAccessibility: true });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  await mkdir(A11Y_DIR, { recursive: true });
  await writeFile(path.join(A11Y_DIR, `${stamp}-sitewide.json`), JSON.stringify(crawl.a11yByPage, null, 2) + "\n");

  const summary = summarizeNetworkActivity({
    requestLog: crawl.requestLog,
    bodySamples: crawl.bodySamples,
    chatAttempts: crawl.chatAttempts,
    pagesVisited: crawl.pages.length,
    wsLog: crawl.wsLog,
    blockersFound: crawl.blockersFound,
  });
  const siteWideA11yViolationCount = crawl.a11yByPage.reduce((sum, p) => sum + (p.violationCount || 0), 0);
  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    harArtifactPath: path.relative(process.cwd(), harPath),
    pages: crawl.pages.map(({ url, redirectedTo, title, httpStatus, navError, formCount, chatInputFound, blockers, a11yViolationCount, skipped }) => ({
      url,
      redirectedTo,
      title,
      httpStatus,
      navError,
      formCount,
      chatInputFound,
      blockers,
      a11yViolationCount,
      skipped,
    })),
    siteWideA11yViolationCount,
    a11yReportPath: path.relative(process.cwd(), path.join(A11Y_DIR, `${stamp}-sitewide.json`)),
    ...summary,
  };

  const prev = await loadPreviousNetworkSummary();
  const newEvents = [];
  if (prev) {
    const prevHosts = new Set(prev.uniqueHosts || []);
    const newHosts = (result.uniqueHosts || []).filter((h) => !prevHosts.has(h));
    if (newHosts.length > 0) {
      newEvents.push({ type: "NEW_NETWORK_HOSTS", detail: newHosts.join(", ") });
    }
    const prevAiKeys = new Set((prev.aiProviderHostMatches || []).map((m) => `${m.host}|${m.provider}`));
    const newAiMatches = (result.aiProviderHostMatches || []).filter((m) => !prevAiKeys.has(`${m.host}|${m.provider}`));
    if (newAiMatches.length > 0) {
      newEvents.push({
        type: "NEW_AI_PROVIDER_HOST",
        detail: newAiMatches.map((m) => `${m.provider} via ${m.host}`).join(", "),
      });
    }
    const prevSigKeys = new Set((prev.protocolSignatures || []).map((s) => `${s.signature}|${s.url}`));
    const newSigs = (result.protocolSignatures || []).filter((s) => !prevSigKeys.has(`${s.signature}|${s.url}`));
    if (newSigs.length > 0) {
      newEvents.push({
        type: "NEW_MODEL_PROTOCOL_SIGNATURE",
        detail: newSigs.map((s) => `${s.signature} on ${s.url}`).join(", "),
      });
    }
  } else if ((result.aiProviderHostMatches || []).length > 0) {
    newEvents.push({
      type: "AI_PROVIDER_HOST_DETECTED",
      detail: result.aiProviderHostMatches.map((m) => `${m.provider} via ${m.host}`).join(", "),
    });
  }
  if ((result.blockersEncountered || []).length > 0) {
    newEvents.push({
      type: "BOT_WALL_OR_CAPTCHA_ENCOUNTERED",
      detail: result.blockersEncountered.map((b) => `${b.blockers.join("+")} on ${b.url}`).join(", "),
    });
  }
  const errorPages = (result.pages || []).filter((p) => p.httpStatus && p.httpStatus >= 400);
  if (errorPages.length > 0) {
    newEvents.push({
      type: "PAGE_ERROR_STATUS",
      detail: errorPages.map((p) => `${p.httpStatus} on ${p.url}${p.title ? ` ("${p.title}")` : ""}`).join(", "),
    });
  }
  result.newEvents = newEvents;

  await writeFile(path.join(NETWORK_DIR, "latest.json"), JSON.stringify(result, null, 2) + "\n");
  await appendFile(
    path.join(NETWORK_DIR, "history.jsonl"),
    JSON.stringify({
      timestamp: result.timestamp,
      pagesVisited: result.pagesVisited,
      totalRequests: result.totalRequests,
      uniqueHostCount: (result.uniqueHosts || []).length,
      aiProviderMatchCount: (result.aiProviderHostMatches || []).length,
      newEventTypes: newEvents.map((e) => e.type),
    }) + "\n"
  );

  return result;
}

// If the crawl found a working chat widget, open it fresh (a clean
// conversation, not reusing the crawl's own throwaway discovery message)
// and run the real question battery against it. Capped to a couple of pages
// since this holds an actual conversation with a live, possibly
// third-party-backed system — not something to do at crawl scale.
async function runChatEvals(networkResult, stamp) {
  const candidateUrls = [...new Set((networkResult.chatInputFoundOnPages || []).map((c) => c.url))].slice(
    0,
    MAX_CHAT_EVAL_PAGES
  );
  if (candidateUrls.length === 0) return [];

  const { chromium } = await import("playwright");
  const { findAndUseChatInput, handlePageBlockers } = await import("./lib/network-capture.mjs");
  const { runChatEval, summarizeChatEval } = await import("./lib/chat-eval.mjs");

  await mkdir(CHAT_EVAL_DIR, { recursive: true });
  const results = [];

  for (const url of candidateUrls) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      await handlePageBlockers(page).catch(() => {});

      const opened = await findAndUseChatInput(page, DISCOVERY_MESSAGE).catch(() => ({ used: false }));
      if (!opened.used) {
        results.push({ url, ok: false, reason: "chat_widget_not_reproducible_on_revisit" });
        continue;
      }
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const transcript = await runChatEval({ page, locator: opened.locator, frame: opened.frame });
      const summary = summarizeChatEval(transcript);

      const slug = new URL(url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
      const filePath = path.join(CHAT_EVAL_DIR, `${stamp}-${slug}.json`);
      await writeFile(filePath, JSON.stringify({ url, timestamp: new Date().toISOString(), transcript, summary }, null, 2) + "\n");

      results.push({ url, ok: true, summary, reportPath: path.relative(process.cwd(), filePath) });
    } catch (e) {
      results.push({ url, ok: false, reason: e.message || String(e) });
    } finally {
      await browser.close();
    }
  }

  return results;
}

async function main() {
  let latest;
  try {
    latest = JSON.parse(await readFile(LATEST_PATH, "utf8"));
  } catch {
    console.log("No data/latest.json yet — run scripts/check.mjs first. Skipping deep audit.");
    return;
  }
  if (!latest.live) {
    console.log("Site not live yet per latest check — skipping deep audit.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Lighthouse and the axe/screenshot pass each launch their own browser but
  // are lightweight enough to run together; the crawl launches a third
  // browser and can run for minutes, so it runs after, sequentially, to
  // avoid overloading a small CI runner.
  const [lighthouse, a11y] = await Promise.all([
    runLighthouse(stamp),
    runAccessibilityAndScreenshot(stamp),
  ]);
  const network = await runCrawlAndCapture(stamp);
  const chatEvals = await runChatEvals(network, stamp);

  const summary = { timestamp: new Date().toISOString(), lighthouse, a11y, network, chatEvals };
  await writeFile(path.join(DATA_DIR, "deep-audit-latest.json"), JSON.stringify(summary, null, 2) + "\n");

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const newEventTypes = (network.newEvents || []).map((e) => e.type).join(",") || "none";
    await appendFile(ghOutput, `network_events=${newEventTypes}\n`);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
