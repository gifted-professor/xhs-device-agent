import { createHash } from "node:crypto";

const UNKNOWN_COUNT = Object.freeze({ count: null, countKind: "unknown", confidence: 0 });
const MAX_COMMENT_COUNT = 1_000_000_000;
const MIN_CONFIDENCE = 0.8;

const POLICY_BANDS = Object.freeze([
  Object.freeze({ band: "ZERO", minimum: 0, maximum: 0, maxScrolls: 0, maxItems: 0 }),
  Object.freeze({ band: "ONE_TO_FIVE", minimum: 1, maximum: 5, maxScrolls: 1, maxItems: 5 }),
  Object.freeze({ band: "SIX_TO_TWENTY", minimum: 6, maximum: 20, maxScrolls: 3, maxItems: 20 }),
  Object.freeze({ band: "TWENTY_ONE_TO_NINETY_NINE", minimum: 21, maximum: 99, maxScrolls: 5, maxItems: 30 }),
  Object.freeze({ band: "ONE_HUNDRED_PLUS", minimum: 100, maximum: MAX_COMMENT_COUNT, maxScrolls: 8, maxItems: 50 }),
]);

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function unknown(extra = {}) {
  return { ...UNKNOWN_COUNT, ...extra };
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COMMENT_COUNT;
}

export function parseCommentCount(value, { confidence = 1, minimumConfidence = MIN_CONFIDENCE } = {}) {
  const numericConfidence = Number(confidence);
  if (!Number.isFinite(numericConfidence) || numericConfidence < minimumConfidence || numericConfidence > 1) return unknown();
  if (typeof value === "number") {
    return validCount(value) ? { count: value, countKind: "exact", confidence: numericConfidence } : unknown();
  }
  const normalized = compact(value).toLocaleLowerCase().replace(/,/gu, "");
  if (!normalized) return unknown();
  let match = /^(\d+)$/u.exec(normalized);
  if (match) {
    const count = Number(match[1]);
    return validCount(count) ? { count, countKind: "exact", confidence: numericConfidence } : unknown();
  }
  match = /^(\d+)\+$/u.exec(normalized);
  if (match) {
    const count = Number(match[1]);
    return validCount(count) ? { count, countKind: "lower_bound", confidence: numericConfidence } : unknown();
  }
  match = /^(\d+(?:\.\d+)?)\s*(k|w|\u4e07)$/u.exec(normalized);
  if (match) {
    const multiplier = match[2] === "k" ? 1000 : 10000;
    const count = Math.round(Number(match[1]) * multiplier);
    return validCount(count) ? { count, countKind: "estimate", confidence: numericConfidence } : unknown();
  }
  return unknown();
}

function normalizeCandidate(candidate, minimumConfidence) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return parseCommentCount(candidate, { minimumConfidence });
  }
  if (Object.hasOwn(candidate, "value")) {
    return parseCommentCount(candidate.value, { confidence: candidate.confidence ?? 1, minimumConfidence });
  }
  const confidence = Number(candidate.confidence);
  if (!validCount(candidate.count) || !["exact", "lower_bound", "estimate"].includes(candidate.countKind)
      || !Number.isFinite(confidence) || confidence < minimumConfidence || confidence > 1) return unknown();
  return { count: candidate.count, countKind: candidate.countKind, confidence };
}

export function resolveCommentCount(candidates, { minimumConfidence = MIN_CONFIDENCE } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 16) return unknown();
  const valid = candidates.map((candidate) => normalizeCandidate(candidate, minimumConfidence)).filter((entry) => entry.countKind !== "unknown");
  if (valid.length === 0) return unknown();
  const exactValues = new Set(valid.filter((entry) => entry.countKind === "exact").map((entry) => entry.count));
  if (exactValues.size > 1) return unknown({ conflict: "exact_value_conflict" });
  const rank = { exact: 3, lower_bound: 2, estimate: 1 };
  valid.sort((left, right) => rank[right.countKind] - rank[left.countKind] || right.confidence - left.confidence || left.count - right.count);
  return { ...valid[0] };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function freezeCommentBudget(observation, { liveCap = { maxScrolls: 3, maxItems: 20 }, maxNoNewScrolls = 2 } = {}) {
  const normalized = normalizeCandidate(observation, MIN_CONFIDENCE);
  const target = normalized.countKind === "unknown"
    ? { band: "UNKNOWN", maxScrolls: 1, maxItems: 5 }
    : POLICY_BANDS.find((entry) => normalized.count >= entry.minimum && normalized.count <= entry.maximum);
  const finalTarget = { maxScrolls: target.maxScrolls, maxItems: target.maxItems };
  const liveBudget = {
    maxScrolls: Math.min(finalTarget.maxScrolls, Math.max(0, Number(liveCap.maxScrolls) || 0)),
    maxItems: Math.min(finalTarget.maxItems, Math.max(0, Number(liveCap.maxItems) || 0)),
  };
  return deepFreeze({
    policyRef: "count-adaptive-v1",
    band: target.band,
    observation: normalized,
    finalTarget,
    liveBudget,
    maxNoNewScrolls: Math.min(2, Math.max(1, Number(maxNoNewScrolls) || 2)),
    frozen: true,
  });
}

export function applyCountUpdateToFrozenBudget(frozenBudget, _laterObservation) {
  if (!frozenBudget || frozenBudget.frozen !== true || !Object.isFrozen(frozenBudget)) throw new Error("a frozen comment budget is required");
  return frozenBudget;
}

export function advanceCommentCollection(previous, { hashes = [], budget, scrolled = false, endMarker = false } = {}) {
  if (!budget?.frozen) throw new Error("a frozen comment budget is required");
  const seen = new Set(previous?.seenHashes ?? []);
  let added = 0;
  for (const value of hashes) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    added += 1;
  }
  const scrolls = (previous?.scrolls ?? 0) + (scrolled ? 1 : 0);
  const noNewScrolls = scrolled ? (added === 0 ? (previous?.noNewScrolls ?? 0) + 1 : 0) : (previous?.noNewScrolls ?? 0);
  let stopReason = null;
  if (endMarker) stopReason = "end_marker";
  else if (seen.size >= budget.liveBudget.maxItems) stopReason = "item_budget";
  else if (scrolls >= budget.liveBudget.maxScrolls && scrolled) stopReason = "scroll_budget";
  else if (noNewScrolls >= budget.maxNoNewScrolls) stopReason = "two_no_new_scrolls";
  return deepFreeze({ seenHashes: [...seen], scrolls, noNewScrolls, stop: stopReason !== null, stopReason });
}

export function normalizedCommentHash(value) {
  return createHash("sha256").update(compact(value).toLocaleLowerCase(), "utf8").digest("hex");
}

const REDACTIONS = Object.freeze({
  author: "[AUTHOR_REDACTED]",
  handle: "[HANDLE_REDACTED]",
  phone: "[PHONE_REDACTED]",
  email: "[EMAIL_REDACTED]",
  url: "[URL_REDACTED]",
  contact: "[CONTACT_REDACTED]",
  account: "[ACCOUNT_ID_REDACTED]",
});

export function deidentifyCommentSnippet(value, { authorNames = [], uiAccountIds = [], redactions = REDACTIONS } = {}) {
  let output = compact(value);
  if (!output || output.length > 2000) return null;
  for (const author of authorNames) {
    const normalized = compact(author);
    if (normalized) output = output.replaceAll(normalized, redactions.author);
  }
  for (const accountId of uiAccountIds) {
    const normalized = compact(accountId);
    if (normalized) output = output.replaceAll(normalized, redactions.account);
  }
  output = output
    .replace(/https?:\/\/[^\s]+/giu, redactions.url)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, redactions.email)
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/gu, redactions.phone)
    .replace(/@[\p{L}\p{N}_.-]+/gu, redactions.handle)
    .replace(/(?:\u5fae\u4fe1|wechat|weixin|wx)\s*(?:\u53f7|id)?\s*[:\uff1a]?\s*[A-Za-z][A-Za-z0-9_-]{4,}/giu, redactions.contact)
    .replace(/(?:qq|contact|\u8054\u7cfb\u65b9\u5f0f|\u8054\u7cfb)\s*(?:\u53f7|id)?\s*[:\uff1a]?\s*[A-Za-z0-9_-]{4,}/giu, redactions.contact)
    .replace(/(?:account|user\s*id|\u8d26\u53f7|\u5c0f\u7ea2\u4e66\u53f7)\s*[:\uff1a]?\s*[A-Za-z0-9_-]{4,}/giu, redactions.account)
    .replace(/\b\d{6,}\b/gu, redactions.account)
    .slice(0, 240);
  const residual = output
    .replace(/\[[A-Z_]+\]/gu, "")
    .replace(/(?:\u5fae\u4fe1|wechat|weixin|wx|qq|contact|\u8054\u7cfb\u65b9\u5f0f|\u8054\u7cfb|account|user\s*id|\u8d26\u53f7|\u5c0f\u7ea2\u4e66\u53f7)/giu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return residual.length >= 3 ? output : null;
}

export function collectCommentSnippets({ nodes = [], maximum = 20, seenHashes = new Set(), authorNames = [], uiAccountIds = [], redactions } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 50 || !(seenHashes instanceof Set)) throw new Error("invalid comment collection bounds");
  const output = [];
  for (const node of nodes) {
    if (!/comment[_-]?(?:content|text|body)/iu.test(String(node?.resourceId ?? "")) || /input|editor/iu.test(String(node?.resourceId ?? ""))) continue;
    const snippet = deidentifyCommentSnippet(node.text || node.contentDesc, { authorNames, uiAccountIds, ...(redactions ? { redactions } : {}) });
    if (!snippet) continue;
    const digest = normalizedCommentHash(snippet);
    if (seenHashes.has(digest)) continue;
    seenHashes.add(digest);
    output.push(snippet);
    if (output.length >= maximum) break;
  }
  return output;
}

function bounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(String(value ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (left < 0 || top < 0 || right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function largestContainer(snapshot, pattern, { requireState } = {}) {
  if (requireState && snapshot?.classification?.state !== requireState) return null;
  return (snapshot?.document?.nodes ?? [])
    .filter((node) => node.scrollable && pattern.test(String(node.resourceId ?? "")) && !/input|editor/iu.test(String(node.resourceId ?? "")))
    .map((node) => ({ node, bounds: bounds(node.attributes?.bounds) }))
    .filter((entry) => entry.bounds)
    .sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height)[0] ?? null;
}

export function findNoteContentContainer(snapshot) {
  return largestContainer(snapshot, /note[_-]?content|content[_-]?scroll|detail[_-]?scroll|article[_-]?content/iu, { requireState: "IMAGE_NOTE" });
}

export function findCommentContainer(snapshot) {
  if (snapshot?.classification?.state && !["COMMENT_PANEL", "IMAGE_NOTE", "VIDEO_NOTE"].includes(snapshot.classification.state)) return null;
  return largestContainer(snapshot, /comment[_-]?(?:panel|list|container|scroll)|comments[_-]?(?:list|container)/iu);
}

function preferredText(nodes, pattern) {
  return compact(nodes.find((node) => pattern.test(String(node.resourceId ?? "")) && compact(node.text || node.contentDesc))?.text
    || nodes.find((node) => pattern.test(String(node.resourceId ?? "")) && compact(node.text || node.contentDesc))?.contentDesc);
}

function commentCountValue(node) {
  const resourceId = String(node?.resourceId ?? "");
  const text = compact(node?.text);
  const contentDesc = compact(node?.contentDesc);
  const semanticDescription = /(?:评论|comments?)\s*[:：]?\s*(\d+(?:\.\d+)?\s*(?:\+|[kw\u4e07])?)/iu.exec(contentDesc)
    || /(\d+(?:\.\d+)?\s*(?:\+|[kw\u4e07])?)\s*(?:条\s*)?(?:评论|comments?)/iu.exec(contentDesc);
  if (semanticDescription) return semanticDescription[1].replace(/\s+/gu, "");
  if (!/comment[_-]?(?:count|entry)|comment_count/iu.test(resourceId)) return null;
  return compact(text || contentDesc).match(/\d+(?:\.\d+)?\s*(?:\+|[kw\u4e07])?/iu)?.[0]?.replace(/\s+/gu, "") ?? null;
}

export function extractDetailMetadata(snapshot) {
  const nodes = snapshot?.document?.nodes ?? [];
  const count = nodes.map(commentCountValue).find(Boolean) ?? null;
  return {
    title: preferredText(nodes, /note[_-]?title|title_text/iu),
    author: preferredText(nodes, /author|nickname|user[_-]?name/iu),
    count,
  };
}
