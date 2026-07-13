import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_THRESHOLDS = Object.freeze({ minimumScore: 0.85, minimumMargin: 0.15 });
const ATTRIBUTE_ALIASES = Object.freeze({
  resourceId: "resource-id",
  contentDesc: "content-desc",
  className: "class",
  longClickable: "long-clickable",
});
const BOOLEAN_ATTRIBUTES = new Set([
  "checkable",
  "checked",
  "clickable",
  "enabled",
  "focusable",
  "focused",
  "scrollable",
  "long-clickable",
  "password",
  "selected",
]);

function decodeXml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(source) {
  const attributes = {};
  const expression = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = expression.exec(source)) !== null) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function asBoolean(value) {
  return String(value).toLowerCase() === "true";
}

function nodeFromAttributes(attributes, nodeIndex, parentIndex, depth) {
  const node = {
    nodeIndex,
    parentIndex,
    depth,
    children: [],
    attributes,
    text: attributes.text ?? "",
    resourceId: attributes["resource-id"] ?? "",
    className: attributes.class ?? "",
    packageName: attributes.package ?? "",
    contentDesc: attributes["content-desc"] ?? "",
  };
  for (const name of BOOLEAN_ATTRIBUTES) {
    const field = name === "long-clickable" ? "longClickable" : name;
    node[field] = asBoolean(attributes[name]);
  }
  return node;
}

/** Parse Android uiautomator XML into a small hierarchy without retaining bounds. */
export function parseUiAutomatorXml(xml) {
  if (typeof xml !== "string" || !xml.trim()) throw new TypeError("UI XML must be a non-empty string");

  const nodes = [];
  const roots = [];
  const stack = [];
  const tokenExpression = /<node\b([^>]*?)(\/?)>|<\/node\s*>/gi;
  let match;

  while ((match = tokenExpression.exec(xml)) !== null) {
    if (match[0].toLowerCase().startsWith("</node")) {
      if (stack.length) stack.pop();
      continue;
    }

    const attributes = parseAttributes(match[1] ?? "");
    const parentIndex = stack.length ? stack[stack.length - 1] : null;
    const node = nodeFromAttributes(attributes, nodes.length, parentIndex, stack.length);
    nodes.push(node);
    if (parentIndex === null) roots.push(node.nodeIndex);
    else nodes[parentIndex].children.push(node.nodeIndex);

    const selfClosing = match[2] === "/" || /\/\s*>$/.test(match[0]);
    if (!selfClosing) stack.push(node.nodeIndex);
  }

  if (!nodes.length) throw new Error("UI XML does not contain any <node> elements");
  return { nodes, roots };
}

function compactWhitespace(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Replace volatile counters/timestamps while preserving stable surrounding labels. */
export function normalizeDynamicText(value) {
  let normalized = compactWhitespace(value).toLowerCase();
  if (!normalized) return "";

  if (/^(?:刚刚|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前)$/.test(normalized)) return "";
  if (/^[\d.,]+\s*(?:万|千|百|w|k)?\s*(?:赞|收藏|评论|条|次|人|浏览|播放)?$/iu.test(normalized)) return "";

  normalized = normalized
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>")
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "<date>")
    .replace(/\d+(?:[.,]\d+)?\s*(?:万|千|百|w|k)?/giu, "<n>")
    .replace(/(?:<n>\s*)+/g, "<n>");
  return normalized;
}

function classSuffix(className) {
  const parts = String(className ?? "").split(".");
  return parts[parts.length - 1] ?? "";
}

function stableNodeToken(node) {
  const fields = [
    node.resourceId ? `id:${node.resourceId}` : "",
    node.className ? `class:${classSuffix(node.className)}` : "",
    normalizeDynamicText(node.text) ? `text:${normalizeDynamicText(node.text)}` : "",
    normalizeDynamicText(node.contentDesc) ? `desc:${normalizeDynamicText(node.contentDesc)}` : "",
    node.clickable ? "clickable" : "",
    node.scrollable ? "scrollable" : "",
    node.password ? "password" : "",
  ].filter(Boolean);
  return fields.join("|");
}

function asDocument(input) {
  if (typeof input === "string") return parseUiAutomatorXml(input);
  if (input && Array.isArray(input.nodes)) return input;
  throw new TypeError("Expected uiautomator XML or a parsed UI document");
}

/** Produce an order-insensitive structural hash that omits bounds and volatile numbers. */
export function createNormalizedFingerprint(input) {
  const document = asDocument(input);
  const tokens = [];
  for (const node of document.nodes) {
    const own = stableNodeToken(node);
    if (own) tokens.push(`node:${own}`);
    if (node.parentIndex !== null) {
      const parent = document.nodes[node.parentIndex];
      const parentToken = stableNodeToken(parent);
      if (parentToken && own) tokens.push(`relation:${parentToken}>${own}`);
    }
  }
  tokens.sort();
  const hash = createHash("sha256").update(tokens.join("\n"), "utf8").digest("hex");
  return { algorithm: "sha256", hash, nodeCount: document.nodes.length };
}

function nodeAttribute(node, attribute) {
  const sourceName = ATTRIBUTE_ALIASES[attribute] ?? attribute;
  if (BOOLEAN_ATTRIBUTES.has(sourceName)) {
    const field = sourceName === "long-clickable" ? "longClickable" : sourceName;
    return node[field];
  }
  if (sourceName in node.attributes) return node.attributes[sourceName];
  if (attribute in node) return node[attribute];
  return undefined;
}

function safeRegex(pattern, flags = "iu") {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Invalid rule regular expression ${JSON.stringify(pattern)}: ${error.message}`);
  }
}

function scalarMatches(actual, signal) {
  if (Object.hasOwn(signal, "equals")) {
    if (typeof signal.equals === "boolean") return Boolean(actual) === signal.equals;
    return String(actual ?? "") === String(signal.equals);
  }
  const values = Array.isArray(signal.values) ? signal.values : [];
  const actualText = compactWhitespace(actual);
  if (!actualText && signal.match !== "exists") return false;

  switch (signal.match) {
    case "exists":
      return actual !== undefined && actual !== null && actualText !== "";
    case "exact":
      return values.some((value) => actualText === compactWhitespace(value));
    case "exactIgnoreCase": {
      const folded = actualText.toLocaleLowerCase();
      return values.some((value) => folded === compactWhitespace(value).toLocaleLowerCase());
    }
    case "includes":
      return values.some((value) => actualText.includes(compactWhitespace(value)));
    case "regex":
      return values.some((value) => safeRegex(value).test(actualText));
    default:
      throw new Error(`Unsupported rule match type: ${signal.match}`);
  }
}

function matchingNodes(document, signal) {
  if (!signal || typeof signal !== "object") return [];
  if (signal.kind === "relation") return relationMatches(document, signal).map((entry) => entry.node);
  if (!signal.attribute) throw new Error("Rule signal is missing attribute");
  return document.nodes.filter((node) => scalarMatches(nodeAttribute(node, signal.attribute), signal));
}

function descendants(document, node, maxDepth) {
  const found = [];
  const queue = node.children.map((nodeIndex) => ({ nodeIndex, distance: 1 }));
  while (queue.length) {
    const current = queue.shift();
    if (current.distance > maxDepth) continue;
    const child = document.nodes[current.nodeIndex];
    found.push(child);
    for (const nodeIndex of child.children) queue.push({ nodeIndex, distance: current.distance + 1 });
  }
  return found;
}

function ancestors(document, node, maxDepth) {
  const found = [];
  let parentIndex = node.parentIndex;
  let distance = 1;
  while (parentIndex !== null && distance <= maxDepth) {
    const parent = document.nodes[parentIndex];
    found.push(parent);
    parentIndex = parent.parentIndex;
    distance += 1;
  }
  return found;
}

function relationMatches(document, signal) {
  const anchorMatches = matchingNodes(document, signal.anchor);
  const direction = signal.direction ?? "descendant";
  const maxDepth = Number(signal.maxDepth ?? 3);
  const found = [];

  for (const anchor of anchorMatches) {
    let related = [];
    if (direction === "descendant") related = descendants(document, anchor, maxDepth);
    else if (direction === "ancestor") related = ancestors(document, anchor, maxDepth);
    else if (direction === "sibling" && anchor.parentIndex !== null) {
      related = document.nodes[anchor.parentIndex].children
        .filter((nodeIndex) => nodeIndex !== anchor.nodeIndex)
        .map((nodeIndex) => document.nodes[nodeIndex]);
    } else if (direction !== "sibling") {
      throw new Error(`Unsupported relation direction: ${direction}`);
    }
    for (const node of related) {
      if (matchingNodes({ nodes: [node], roots: [0] }, signal.node).length) found.push({ anchor, node });
    }
  }
  return found;
}

function signalMatches(document, signal) {
  return matchingNodes(document, signal).length > 0;
}

function groupMatches(document, group) {
  const signals = group.any ?? (group.all ? [] : [group]);
  if (group.all) return group.all.every((signal) => signalMatches(document, signal));
  return signals.some((signal) => signalMatches(document, signal));
}

function matchProfile(match = {}, context = {}) {
  return Object.entries(match).every(([key, expected]) => {
    if (expected === "*" || expected === null) return true;
    if (Array.isArray(expected)) return expected.map(String).includes(String(context[key] ?? ""));
    return String(context[key] ?? "") === String(expected);
  });
}

function profileSpecificity(profile) {
  return Object.values(profile.match ?? {}).filter((value) => value !== "*" && value !== null).length;
}

function mergeNamedRules(base = [], additions = []) {
  const merged = new Map(base.map((rule) => [rule.state, { ...rule }]));
  for (const rule of additions) merged.set(rule.state, { ...(merged.get(rule.state) ?? {}), ...rule });
  return [...merged.values()];
}

function mergeTargetRules(base = {}, additions = {}) {
  const merged = { ...base };
  for (const [target, selectors] of Object.entries(additions)) merged[target] = selectors;
  return merged;
}

/** Select common app/SDK rules and an optional explicitly calibrated device override. */
export function resolveRuleProfile(config, context = {}) {
  const profiles = Array.isArray(config.profiles) ? config.profiles : [];
  const matchingProfiles = profiles
    .filter((profile) => matchProfile(profile.match, context))
    .sort((left, right) => profileSpecificity(right) - profileSpecificity(left));
  const profile = matchingProfiles[0] ?? { id: "top-level", states: config.states ?? [], semanticTargets: config.semanticTargets ?? {} };

  let states = profile.states ?? [];
  let semanticTargets = profile.semanticTargets ?? {};
  let overrideId = null;
  const override = (config.deviceOverrides ?? []).find((candidate) => {
    if (!matchProfile(candidate.match, context)) return false;
    return candidate.calibratedXhsVersion && String(candidate.calibratedXhsVersion) === String(context.xhsVersion ?? "");
  });
  if (override) {
    states = mergeNamedRules(states, override.states);
    semanticTargets = mergeTargetRules(semanticTargets, override.semanticTargets);
    overrideId = override.id ?? null;
  }
  return { profileId: profile.id ?? "default", overrideId, states, semanticTargets };
}

function roundScore(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;
}

function scoreRule(document, rule) {
  if (rule.fallback) return null;
  const evidence = Array.isArray(rule.evidence) ? rule.evidence : [];
  const denominator = evidence.reduce((sum, group) => sum + Number(group.weight ?? 0), 0);
  if (denominator <= 0) return { state: rule.state, score: 0, matchedEvidence: [], penalties: [] };

  const matchedEvidence = [];
  let earned = 0;
  for (const group of evidence) {
    if (groupMatches(document, group)) {
      earned += Number(group.weight ?? 0);
      matchedEvidence.push(group.id ?? "unnamed");
    }
  }

  const penalties = [];
  let penalty = 0;
  for (const group of rule.penalties ?? []) {
    if (groupMatches(document, group)) {
      penalty += Number(group.weight ?? 0);
      penalties.push(group.id ?? "unnamed");
    }
  }
  return { state: rule.state, score: roundScore(earned / denominator - penalty), matchedEvidence, penalties };
}

/** Score every non-fallback state from deterministic UI evidence. */
export function scorePageStates(input, config, context = {}) {
  const document = asDocument(input);
  const selected = resolveRuleProfile(config, context);
  return selected.states
    .map((rule) => scoreRule(document, rule))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.state.localeCompare(right.state));
}

/** Detect screens that must never be sent to cloud vision or operated automatically. */
export function classifySafety(input, config, classifiedState = "UNKNOWN") {
  const document = asDocument(input);
  const reasons = [];
  let challenge = false;
  for (const pattern of config.safety?.patterns ?? []) {
    if (groupMatches(document, pattern)) {
      reasons.push(pattern.id);
      challenge ||= Boolean(pattern.challenge);
    }
  }
  if ((config.safety?.humanRequiredStates ?? []).includes(classifiedState)) reasons.push(`state:${classifiedState}`);
  const uniqueReasons = [...new Set(reasons)].sort();
  const sensitive = uniqueReasons.length > 0;
  return {
    sensitive,
    challenge,
    requiresHuman: sensitive || (config.safety?.humanRequiredStates ?? []).includes(classifiedState),
    blockCloudUpload: sensitive || (config.safety?.blockCloudStates ?? []).includes(classifiedState),
    reasons: uniqueReasons,
  };
}

/** Classify a page; UNKNOWN is returned unless both score and margin gates pass. */
export function classifyPage(input, config, context = {}) {
  const document = asDocument(input);
  const selected = resolveRuleProfile(config, context);
  const scored = scorePageStates(document, config, context);
  const top = scored[0] ?? { state: "UNKNOWN", score: 0, matchedEvidence: [], penalties: [] };
  const runnerUp = scored[1] ?? { state: "UNKNOWN", score: 0 };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
  const margin = roundScore(top.score - runnerUp.score);
  const accepted = top.score >= thresholds.minimumScore && margin >= thresholds.minimumMargin;
  const state = accepted ? top.state : "UNKNOWN";
  const safety = classifySafety(document, config, state);
  const fingerprint = createNormalizedFingerprint(document);

  return {
    schemaVersion: 1,
    state,
    accepted,
    score: top.score,
    margin,
    matchedEvidence: accepted ? top.matchedEvidence : [],
    topCandidate: top.state,
    candidates: scored.slice(0, 3).map(({ state: candidateState, score }) => ({ state: candidateState, score })),
    thresholds,
    profile: { id: selected.profileId, overrideId: selected.overrideId },
    fingerprint,
    safety,
  };
}

function selectorPriority(selector) {
  return { "resource-id": 1, text: 2, "content-desc": 2, relation: 3 }[selector.strategy] ?? 99;
}

function selectorSignal(selector) {
  if (selector.strategy === "resource-id") {
    return { attribute: "resourceId", match: selector.match ?? "exact", values: selector.values ?? [] };
  }
  if (selector.strategy === "text") return { attribute: "text", match: "exact", values: selector.values ?? [] };
  if (selector.strategy === "content-desc") return { attribute: "contentDesc", match: "exact", values: selector.values ?? [] };
  return null;
}

function nodePath(document, node) {
  const path = [];
  let current = node;
  while (current) {
    if (current.parentIndex === null) {
      path.push(document.roots.indexOf(current.nodeIndex));
      break;
    }
    const parent = document.nodes[current.parentIndex];
    path.push(parent.children.indexOf(current.nodeIndex));
    current = parent;
  }
  return `/${path.reverse().join("/")}`;
}

function semanticSelectorReference(selector, node) {
  if (selector.strategy === "resource-id") return { resourceId: node.resourceId };
  if (selector.strategy === "text") return { text: selector.values.find((value) => compactWhitespace(value) === compactWhitespace(node.text)) };
  if (selector.strategy === "content-desc") {
    return { contentDesc: selector.values.find((value) => compactWhitespace(value) === compactWhitespace(node.contentDesc)) };
  }
  return { relation: selector.id ?? "stable-relation" };
}

/** Resolve a named target using semantic selectors only. Coordinates are never accepted or returned. */
export function resolveSemanticTarget(input, config, semanticTarget, context = {}) {
  const document = asDocument(input);
  const selected = resolveRuleProfile(config, context);
  const selectors = [...(selected.semanticTargets[semanticTarget] ?? [])].sort(
    (left, right) => selectorPriority(left) - selectorPriority(right),
  );

  for (const selector of selectors) {
    if (selectorPriority(selector) === 99) continue;
    let node;
    if (selector.strategy === "relation") node = relationMatches(document, { kind: "relation", ...selector })[0]?.node;
    else node = matchingNodes(document, selectorSignal(selector))[0];
    if (!node || node.enabled === false) continue;
    return {
      semanticTarget,
      found: true,
      strategy: selector.strategy,
      selector: semanticSelectorReference(selector, node),
      node: { className: node.className, clickable: node.clickable, enabled: node.enabled, path: nodePath(document, node) },
    };
  }
  return { semanticTarget, found: false, reason: selectors.length ? "no-semantic-match" : "unknown-semantic-target" };
}

export async function loadRules(path) {
  const content = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.profiles) && !Array.isArray(parsed.states)) throw new Error("Rules must define profiles or states");
  return parsed;
}

function getArgument(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

async function runCli(argv) {
  const command = argv[0];
  if (command !== "classify") throw new Error("Usage: node scripts/xhs-page-engine.mjs classify --xml <path> [--rules <path>]");
  const xmlPath = getArgument(argv, "--xml");
  if (!xmlPath) throw new Error("classify requires --xml <path>");
  const defaultRules = resolve(fileURLToPath(new URL("../config/xhs-page-rules.json", import.meta.url)));
  const rulesPath = getArgument(argv, "--rules", defaultRules);
  const context = {
    xhsVersion: getArgument(argv, "--xhs-version", ""),
    androidSdk: getArgument(argv, "--android-sdk", ""),
    deviceAlias: getArgument(argv, "--device-alias", ""),
    resolution: getArgument(argv, "--resolution", ""),
    dpi: getArgument(argv, "--dpi", ""),
  };
  const [xml, rules] = await Promise.all([readFile(resolve(xmlPath), "utf8"), loadRules(rulesPath)]);
  const result = classifyPage(xml, rules, context);
  const target = getArgument(argv, "--target");
  if (target) result.semanticTarget = resolveSemanticTarget(xml, rules, target, context);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
