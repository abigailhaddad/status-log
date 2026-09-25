// Records every network call the page makes (a real HAR, not just static
// source), including calls triggered by actually typing into and submitting
// whatever chat/search input we can find. This is exactly what a browser's
// devtools Network tab would show a human visitor — nothing here bypasses
// auth, rate limits, or robots.txt; it's a scripted version of "open the
// site, use the chatbot, watch what it talks to."

const KNOWN_AI_HOST_PATTERNS = [
  { key: "xai_grok", pattern: /(^|\.)x\.ai$|api\.x\.ai|grok\.com/i },
  { key: "openai", pattern: /(^|\.)openai\.com$/i },
  { key: "anthropic", pattern: /(^|\.)anthropic\.com$/i },
  { key: "google_gemini", pattern: /generativelanguage\.googleapis\.com|(^|\.)ai\.google\.dev$/i },
  { key: "azure_openai", pattern: /openai\.azure\.com/i },
  { key: "aws_bedrock", pattern: /bedrock-runtime.*amazonaws\.com/i },
  { key: "groq", pattern: /api\.groq\.com/i },
  { key: "together_ai", pattern: /api\.together\.(ai|xyz)/i },
  { key: "mistral", pattern: /api\.mistral\.ai/i },
  { key: "vercel_ai_gateway", pattern: /ai-gateway\.vercel\.sh/i },
  { key: "cloudflare_ai_gateway", pattern: /gateway\.ai\.cloudflare\.com/i },
  { key: "huggingface", pattern: /api-inference\.huggingface\.co/i },
];

// Response-body/protocol fingerprints that can identify the model provider
// even when the API call itself is proxied through a first-party backend
// (so the host alone doesn't give it away).
const STREAM_PROTOCOL_SIGNATURES = [
  { key: "openai_chat_completion_chunk", pattern: /"object"\s*:\s*"chat\.completion\.chunk"/ },
  { key: "openai_responses_api", pattern: /"type"\s*:\s*"response\.(created|output_text\.delta)"/ },
  { key: "anthropic_content_block_delta", pattern: /event:\s*content_block_delta|"type"\s*:\s*"content_block_delta"/ },
  { key: "anthropic_message_start", pattern: /"type"\s*:\s*"message_start"/ },
  { key: "vercel_ai_sdk_data_stream", pattern: /^[0-9a-z]:"|"type"\s*:\s*"text-delta"/m },
  { key: "gemini_candidates_format", pattern: /"candidates"\s*:\s*\[/ },
  { key: "model_name_gpt", pattern: /"model"\s*:\s*"(gpt-|o[134])/ },
  { key: "model_name_grok", pattern: /"model"\s*:\s*"grok/ },
  { key: "model_name_claude", pattern: /"model"\s*:\s*"claude/ },
  { key: "model_name_gemini", pattern: /"model"\s*:\s*"gemini/ },
];

export const CHAT_TEST_MESSAGES = [
  "How do I renew my passport?",
  "How do I file my taxes for free?",
  "How do I check my Social Security benefits?",
  "What is Direct File?",
  "How do I contact my member of Congress?",
  "What documents do I need for a REAL ID?",
];

export { KNOWN_AI_HOST_PATTERNS, STREAM_PROTOCOL_SIGNATURES };

const CHAT_INPUT_SELECTORS = [
  'textarea[placeholder*="ask" i]',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="chat" i]',
  'textarea[placeholder*="question" i]',
  '[role="textbox"]',
  'div[contenteditable="true"]',
  "textarea",
  'input[type="text"]',
  'input[type="search"]',
];

// Ordinary site search boxes are extremely common on government sites and
// otherwise match the generic fallback selectors above (bare textarea,
// input[type="text"], etc.), producing false "chatbot found" results.
// Reject a candidate if its own attributes, its label, or its enclosing
// form look like search/newsletter/login rather than a chat/assistant.
async function looksLikeNonChatInput(locator) {
  try {
    const fingerprint = await locator.evaluate((el) => {
      const parts = [
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("role"),
      ];
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) parts.push(document.getElementById(labelledBy)?.textContent);
      if (el.id) parts.push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
      const form = el.closest("form");
      if (form) parts.push(form.getAttribute("role"), form.getAttribute("action"), form.getAttribute("id"), form.getAttribute("class"));
      return parts.filter(Boolean).join(" | ");
    });
    return /search|filter|\bzip\b|postal|address|e-?mail|username|password|subscribe|newsletter|^q$|\bquery\b/i.test(fingerprint);
  } catch {
    return false;
  }
}

const CHAT_LAUNCHER_SELECTORS = [
  'button[aria-label*="chat" i]',
  'a[aria-label*="chat" i]',
  'button[aria-label*="assistant" i]',
  'a[aria-label*="assistant" i]',
  '[class*="chat-launcher" i]',
  '[class*="chat-widget" i][role="button"]',
  '[id*="chat-widget" i]',
  // Older enterprise chat vendors (e.g. NICE inContact's NITAgent, seen on
  // USCIS's "Ask Emma" widget) launch from a plain <a onclick=...> link
  // rather than a semantic <button>.
  'button:has-text("Chat")',
  'a:has-text("Chat")',
  'button:has-text("Ask")',
  'a:has-text("Ask")',
];

// Some chat widgets stay collapsed behind a floating launcher button until
// clicked. Best-effort: try each launcher, give the widget a moment to
// mount, and don't treat a miss as an error — most pages won't have one.
// `a:has-text("Ask")`/`"Chat"` are broad enough to occasionally match an
// unrelated link ("Ask a librarian", "Chat history", ...) that navigates
// away instead of opening a widget — if that happens, undo it and move on.
async function tryOpenChatLauncher(page) {
  const urlBefore = page.url();
  for (const selector of CHAT_LAUNCHER_SELECTORS) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible({ timeout: 500 }))) continue;
      await locator.click({ timeout: 2000 });
      await page.waitForTimeout(1000);
      if (page.url() !== urlBefore) {
        await page.goto(urlBefore, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
        continue;
      }
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function tryChatInputInFrame(frame, testMessage, frameLabel) {
  // `frame` is either the main Page or a child Frame — both expose url(),
  // but only Page exposes waitForTimeout(), so resolve the owning page once.
  const pageRef = typeof frame.page === "function" ? frame.page() : frame;
  const urlBefore = frame.url();
  for (const selector of CHAT_INPUT_SELECTORS) {
    const locator = frame.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible({ timeout: 1000 }))) continue;
      if (await looksLikeNonChatInput(locator)) continue;
      await locator.click({ timeout: 3000 });
      await locator.fill(testMessage, { timeout: 3000 }).catch(async () => {
        await locator.type(testMessage, { timeout: 5000 });
      });
      // Try an explicit send button first; fall back to Enter.
      const sendButton = frame
        .locator('button:has-text("Send"), button:has-text("Ask"), button[aria-label*="send" i]')
        .first();
      if ((await sendButton.count()) > 0 && (await sendButton.isVisible({ timeout: 500 }).catch(() => false))) {
        await sendButton.click({ timeout: 3000 }).catch(() => {});
      } else {
        await locator.press("Enter", { timeout: 3000 }).catch(() => {});
      }

      // A real chat widget answers in place; a plain <form> (search, login,
      // signup) navigates the page. If the URL just changed, this almost
      // certainly wasn't a chatbot even though it passed the filters above —
      // restore the original page and keep looking at the remaining selectors.
      await pageRef.waitForTimeout(500);
      if (frame.url() !== urlBefore) {
        // Only safe to restore via goto() when we were on the top-level page;
        // for an iframe, urlBefore is the frame's own URL, and navigating the
        // whole page there would replace the entire site with just that embed.
        if (frame === pageRef) {
          await pageRef.goto(urlBefore, { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
        }
        continue;
      }

      return { used: true, selector: `${frameLabel}${selector}`, locator, frame };
    } catch {
      continue;
    }
  }
  return null;
}

const CONSENT_BUTTON_SELECTORS = [
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Accept Cookies")',
  'button:has-text("I Accept")',
  'button:has-text("Got it")',
  "#onetrust-accept-btn-handler",
  '[class*="cookie-consent" i] button',
];

const BLOCKER_SIGNATURES = [
  { key: "cloudflare_challenge", pattern: /just a moment|checking your browser|cf-turnstile/i },
  { key: "recaptcha", selector: 'iframe[src*="recaptcha" i]' },
  { key: "hcaptcha", selector: 'iframe[src*="hcaptcha" i]' },
  { key: "generic_verify_human", pattern: /verify you are human|are you a robot/i },
];

// Dismisses an ordinary cookie-consent banner (equivalent to what any real
// visitor does) and separately detects — but never attempts to bypass — a
// bot-check/CAPTCHA wall, so a blocked crawl is reported as blocked rather
// than silently returning empty results.
export async function handlePageBlockers(page) {
  for (const selector of CONSENT_BUTTON_SELECTORS) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible({ timeout: 500 }))) continue;
      await locator.click({ timeout: 2000 });
      await page.waitForTimeout(300);
    } catch {
      continue;
    }
  }

  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const detected = [];
  for (const b of BLOCKER_SIGNATURES) {
    if (b.pattern && b.pattern.test(bodyText)) {
      detected.push(b.key);
      continue;
    }
    if (b.selector) {
      const found = await page
        .locator(b.selector)
        .first()
        .count()
        .then((c) => c > 0)
        .catch(() => false);
      if (found) detected.push(b.key);
    }
  }
  return { blockers: detected };
}

export function attachWebSocketListener(page, wsLog) {
  page.on("websocket", (ws) => {
    const entry = { url: ws.url(), framesSent: [], framesReceived: [], error: null };
    wsLog.push(entry);
    ws.on("framesent", ({ payload }) => {
      if (typeof payload === "string") entry.framesSent.push(payload.slice(0, 5000));
    });
    ws.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") entry.framesReceived.push(payload.slice(0, 5000));
    });
    ws.on("socketerror", (err) => {
      entry.error = String(err);
    });
  });
}

export async function findAndUseChatInput(page, testMessage) {
  // Try the main page first, as-is.
  let result = await tryChatInputInFrame(page, testMessage, "");
  if (result) return result;

  // Some widgets are collapsed behind a launcher button — open it and retry
  // both the main page and any iframes that appeared as a result.
  const opened = await tryOpenChatLauncher(page);
  if (opened) {
    result = await tryChatInputInFrame(page, testMessage, "");
    if (result) return result;
  }

  // Check iframes (embedded third-party chat widgets are common).
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    result = await tryChatInputInFrame(frame, testMessage, `iframe[${frame.url()}] `);
    if (result) return result;
  }

  return { used: false, selector: null };
}

// A request that gets blocked (CSP, ORB, an ad-blocking-style Chromium
// policy) or aborted never fires a 'response' event at all — without this,
// an attempted-but-blocked call to a third-party AI host would be
// completely invisible rather than showing up as a host we saw it try.
export function attachFailedRequestListener(page, requestLog) {
  page.on("requestfailed", (request) => {
    requestLog.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: null,
      contentType: null,
      failed: true,
      errorText: request.failure()?.errorText || "unknown",
    });
  });
}

// Attaches a response listener that accumulates every request/response pair
// (and small text bodies worth keeping) onto shared arrays. Used both for a
// single-page capture and across an entire multi-page crawl.
export function attachResponseListener(page, requestLog, bodySamples) {
  page.on("response", async (response) => {
    const req = response.request();
    const entry = {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: response.status(),
      contentType: response.headers()["content-type"] || null,
    };
    requestLog.push(entry);
    // Only pull bodies for small-ish, text-like, non-static-asset responses
    // so we don't try to embed multi-MB JS bundles or images into JSON.
    const ct = entry.contentType || "";
    const isInteresting =
      req.resourceType() === "xhr" ||
      req.resourceType() === "fetch" ||
      ct.includes("json") ||
      ct.includes("event-stream");
    if (isInteresting) {
      try {
        const text = await response.text();
        if (text && text.length < 20000) {
          bodySamples.push({ url: entry.url, contentType: ct, body: text });
        } else if (text) {
          bodySamples.push({ url: entry.url, contentType: ct, body: text.slice(0, 20000), truncated: true });
        }
      } catch {
        // Body not available (e.g. redirect, already consumed) — fine to skip.
      }
    }
  });
}

export function summarizeNetworkActivity({
  requestLog,
  bodySamples,
  chatAttempts = [],
  pagesVisited = null,
  wsLog = [],
  blockersFound = [],
  cookies = [],
  storage = null,
}) {
  const hostCounts = {};
  for (const r of requestLog) {
    try {
      const parsed = new URL(r.url);
      // data:/blob:/about: URLs parse "successfully" but have no host —
      // without this check they show up as a bogus "" entry in the list.
      if (!parsed.host) continue;
      hostCounts[parsed.host] = (hostCounts[parsed.host] || 0) + 1;
    } catch {
      // ignore unparsable URLs
    }
  }
  const hosts = Object.keys(hostCounts).sort();

  // Surface separately from a normal successful load — e.g. "we saw an
  // attempted call to api.x.ai that got blocked" is a materially different
  // (and still very relevant) finding from "it successfully loaded xAI."
  // net::ERR_ABORTED overwhelmingly just means "the page navigated away
  // before this beacon finished" (extremely common and expected for
  // analytics pixels) rather than an actual block — excluded as noise
  // unless it's an otherwise-interesting AI provider host, where even a
  // cancelled attempt is worth knowing about.
  const blockedRequests = requestLog
    .filter((r) => {
      if (!r.failed) return false;
      if (r.errorText !== "net::ERR_ABORTED") return true;
      try {
        return KNOWN_AI_HOST_PATTERNS.some(({ pattern }) => pattern.test(new URL(r.url).host));
      } catch {
        return false;
      }
    })
    .reduce((byUrl, r) => {
      // The same resource (e.g. a shared search-widget CSS file) commonly
      // fails identically on every page of a crawl — one entry with a count
      // is more useful than the same line repeated once per page.
      const existing = byUrl.get(r.url);
      if (existing) existing.count += 1;
      else byUrl.set(r.url, { url: r.url, errorText: r.errorText, count: 1 });
      return byUrl;
    }, new Map());
  const blockedRequestsDeduped = [...blockedRequests.values()];

  const aiHostMatches = [];
  for (const host of hosts) {
    for (const { key, pattern } of KNOWN_AI_HOST_PATTERNS) {
      if (pattern.test(host)) aiHostMatches.push({ host, provider: key });
    }
  }

  const streamingResponses = requestLog.filter((r) => (r.contentType || "").includes("event-stream"));

  const protocolSignatures = [];
  for (const sample of bodySamples) {
    for (const { key, pattern } of STREAM_PROTOCOL_SIGNATURES) {
      if (pattern.test(sample.body)) {
        protocolSignatures.push({ signature: key, url: sample.url });
      }
    }
  }

  const successfulChatAttempts = chatAttempts.filter((c) => c.used);

  const wsProtocolSignatures = [];
  for (const ws of wsLog) {
    const allFrames = [...ws.framesSent, ...ws.framesReceived];
    for (const frame of allFrames) {
      for (const { key, pattern } of STREAM_PROTOCOL_SIGNATURES) {
        if (pattern.test(frame)) wsProtocolSignatures.push({ signature: key, url: ws.url, transport: "websocket" });
      }
    }
  }

  return {
    pagesVisited,
    chatInputFoundOnPages: successfulChatAttempts.map((c) => ({ url: c.url, selector: c.selector, testMessage: c.testMessage })),
    totalRequests: requestLog.length,
    uniqueHosts: hosts,
    aiProviderHostMatches: aiHostMatches,
    streamingEndpoints: streamingResponses.map((r) => r.url),
    protocolSignatures: [...protocolSignatures, ...wsProtocolSignatures],
    websockets: wsLog.map((ws) => ({ url: ws.url, framesSentCount: ws.framesSent.length, framesReceivedCount: ws.framesReceived.length })),
    blockersEncountered: blockersFound,
    blockedOrFailedRequests: blockedRequestsDeduped,
    // Metadata only, never the value (a cookie/storage value can be a
    // session token or other sensitive state, and this gets committed to
    // the public data/ directory).
    cookies: cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.expires === -1,
    })),
    storageKeys: {
      localStorage: storage?.localStorageKeys || [],
      sessionStorage: storage?.sessionStorageKeys || [],
    },
  };
}
