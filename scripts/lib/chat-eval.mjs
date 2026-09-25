// The actual eval: once a chat widget is found, ask it a fixed battery of
// benign test questions in one conversation and grade what comes back.
// Categories:
//   functional  — does it actually answer a real government-service question
//   capability  — will it write code / a poem, which is a strong signal of a
//                 general-purpose foundation model with light topic guardrails
//                 rather than a narrow scripted assistant
//   self_id     — does it say what model/vendor powers it if asked directly
//   robustness  — does it handle garbled input gracefully instead of erroring
//
// Nothing here is adversarial or a jailbreak attempt — every question is one
// an ordinary member of the public could type into the box themselves.
export const CHAT_EVAL_QUESTIONS = [
  {
    key: "service_question_passport",
    category: "functional",
    text: "How do I renew my passport?",
  },
  {
    key: "service_question_tax_refund",
    category: "functional",
    text: "How do I check the status of my tax refund?",
  },
  {
    key: "code_capability",
    category: "capability",
    text: "Write a Python function that checks if a number is prime.",
  },
  {
    key: "creative_capability",
    category: "capability",
    text: "Write a haiku about paperwork.",
  },
  {
    key: "model_self_id",
    category: "self_id",
    text: "What AI model or company powers you? Are you built on GPT, Claude, Gemini, or Grok?",
  },
  {
    key: "garbled_input",
    category: "robustness",
    text: "asdkjfh 29483 !!! ??? xyzzy",
  },
];

const RESPONSE_SETTLE_TIMEOUT_MS = 25000;
const POST_SEND_GRACE_MS = 1500;

const MODEL_VENDOR_PATTERNS = [
  { key: "openai", pattern: /\bgpt-?\d|\bopenai\b|\bchatgpt\b/i },
  { key: "anthropic", pattern: /\bclaude\b|\banthropic\b/i },
  { key: "google", pattern: /\bgemini\b|\bpalm\b|\bgoogle ai\b/i },
  { key: "xai", pattern: /\bgrok\b|\bx\.?ai\b/i },
  { key: "meta", pattern: /\bllama\b|\bmeta ai\b/i },
  { key: "amazon", pattern: /\btitan\b|\bbedrock\b|\bamazon (?:ai|q)\b/i },
];

const CODE_SIGNATURE_PATTERN = /```|\bdef \w+\(|\bfunction \w*\(|\breturn\b.*:|for \w+ in range/i;
const REFUSAL_PATTERN = /i (?:can'?t|cannot|won'?t|am not able to)|i'?m (?:not able|unable)|outside (?:my|the) scope|only (?:help|assist) with/i;
const EMPTY_OR_ERROR_PATTERN = /^\s*$|internal server error|something went wrong|try again later/i;

async function findResponseContainer(page) {
  // Prefer an accessible live region, since that's the standard pattern for
  // a streaming chat UI (required for screen readers to hear new messages
  // as they stream in) — far more reliable than guessing vendor-specific
  // class names.
  const candidates = ['[aria-live]', '[role="log"]', '[role="status"]'];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) return loc;
  }
  return null;
}

async function readText(locatorOrPage) {
  try {
    return await locatorOrPage.innerText();
  } catch {
    return "";
  }
}

function extractDelta(before, after) {
  if (after.startsWith(before)) return after.slice(before.length).trim();
  // Some widgets re-render the whole log rather than appending — fall back
  // to the raw new text rather than losing the answer entirely.
  return after.trim();
}

function gradeAnswer({ category, answer }) {
  if (!answer || EMPTY_OR_ERROR_PATTERN.test(answer)) {
    return { outcome: "no_response", detail: null };
  }
  if (category === "functional") {
    return { outcome: answer.length > 20 ? "answered" : "too_short_to_judge", detail: null };
  }
  if (category === "capability") {
    if (REFUSAL_PATTERN.test(answer)) return { outcome: "refused", detail: null };
    const looksLikeCode = /def |function|```/i.test(answer) ? CODE_SIGNATURE_PATTERN.test(answer) : true;
    return { outcome: looksLikeCode ? "complied" : "unclear", detail: null };
  }
  if (category === "self_id") {
    const matches = MODEL_VENDOR_PATTERNS.filter((v) => v.pattern.test(answer)).map((v) => v.key);
    if (matches.length > 0) return { outcome: "disclosed", detail: matches };
    if (REFUSAL_PATTERN.test(answer)) return { outcome: "declined_to_say", detail: null };
    return { outcome: "no_disclosure", detail: null };
  }
  if (category === "robustness") {
    return { outcome: "handled_gracefully", detail: null };
  }
  return { outcome: "unknown", detail: null };
}

// Runs the full question battery against an already-open chat widget
// (as returned by findAndUseChatInput's `{ locator, frame }`), continuing
// the same conversation turn by turn, and grades each answer.
export async function runChatEval({ page, locator, frame, questions = CHAT_EVAL_QUESTIONS }) {
  const container = await findResponseContainer(frame);
  const readFrom = container || frame.locator("body");
  let previousText = await readText(readFrom);

  const transcript = [];
  for (const q of questions) {
    let sendError = null;
    try {
      await locator.click({ timeout: 3000 });
      await locator.fill(q.text, { timeout: 3000 }).catch(async () => locator.type(q.text, { timeout: 5000 }));
      const sendButton = frame
        .locator('button:has-text("Send"), button:has-text("Ask"), button[aria-label*="send" i]')
        .first();
      if ((await sendButton.count().catch(() => 0)) > 0) {
        await sendButton.click({ timeout: 3000 }).catch(() => {});
      } else {
        await locator.press("Enter", { timeout: 3000 }).catch(() => {});
      }
    } catch (e) {
      sendError = e.message || String(e);
    }

    if (sendError) {
      transcript.push({ ...q, answer: null, sendError, grade: { outcome: "send_failed", detail: null } });
      continue;
    }

    await page.waitForLoadState("networkidle", { timeout: RESPONSE_SETTLE_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(POST_SEND_GRACE_MS);

    const currentText = await readText(readFrom);
    const answer = extractDelta(previousText, currentText);
    previousText = currentText;

    transcript.push({ ...q, answer: answer || null, grade: gradeAnswer({ category: q.category, answer }) });
  }

  return transcript;
}

export function summarizeChatEval(transcript) {
  const byCategory = {};
  for (const turn of transcript) {
    byCategory[turn.category] = byCategory[turn.category] || [];
    byCategory[turn.category].push({ key: turn.key, outcome: turn.grade.outcome, detail: turn.grade.detail });
  }
  const disclosedVendors = (byCategory.self_id || [])
    .filter((t) => t.outcome === "disclosed")
    .flatMap((t) => t.detail || []);
  const anyFunctionalAnswered = (byCategory.functional || []).some((t) => t.outcome === "answered");
  const anyCapabilityComplied = (byCategory.capability || []).some((t) => t.outcome === "complied");
  return {
    working: anyFunctionalAnswered,
    generalPurposeModelSuspected: anyCapabilityComplied,
    disclosedVendors: [...new Set(disclosedVendors)],
    byCategory,
  };
}
