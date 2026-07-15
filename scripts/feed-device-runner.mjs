import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  classifyPage,
  createNormalizedFingerprint,
  loadRules,
  normalizeDynamicText,
  parseUiAutomatorXml,
} from "./xhs-page-engine.mjs";
import {
  FeedWorkflowError,
  normalizeFeedSpec,
  runFeedWorkflow,
} from "./feed-workflow.mjs";
import {
  assertBatchControlActiveSync,
  batchControlPaths,
  tripBatchFuse,
} from "./feed-batch-control.mjs";
import { classifyFeedBatchFailure } from "./feed-batch-core.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const XHS_PACKAGE = "com.xingin.xhs";
const DETAIL_STATES = new Set(["IMAGE_NOTE", "VIDEO_NOTE"]);
const STARTUP_BACK_ATTEMPTS = 4;
const STARTUP_LAUNCH_ATTEMPTS = 2;
const DETAIL_TRANSITION_ATTEMPTS = 5;
const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const CHROME_TEXT = new Set(["首页", "发现", "关注", "消息", "我", "搜索", "推荐", "购物", "发布", "直播"]);

class FeedDeviceError extends FeedWorkflowError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = "FeedDeviceError";
  }
}

function parseCli(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = String(argv[index] ?? "");
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) throw new Error("Feed runner requires named option/value pairs");
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error("--" + key + " may be provided only once");
    options[key] = String(value);
  }
  return options;
}

function requireOption(options, name) {
  const value = String(options[name] ?? "").trim();
  if (!value) throw new Error("--" + name + " is required");
  return value;
}

function parseBounds(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(String(value ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function center(bounds) {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function extractHierarchyXml(raw) {
  const value = String(raw ?? "");
  const hierarchyStart = value.indexOf("<hierarchy");
  const hierarchyEnd = value.lastIndexOf("</hierarchy>");
  if (hierarchyStart < 0 || hierarchyEnd < hierarchyStart) return null;
  const declarationStart = value.lastIndexOf("<?xml", hierarchyStart);
  const start = declarationStart >= 0 ? declarationStart : hierarchyStart;
  return value.slice(start, hierarchyEnd + "</hierarchy>".length);
}

export function countUiDumpBytes(raw) {
  const value = String(raw ?? "");
  if (value.length === 0) return 0;
  return new TextEncoder().encode(value).length;
}

function stablePublicText(value) {
  const text = compact(value);
  if (!text || text.length < 2 || text.length > 120 || CHROME_TEXT.has(text)) return "";
  if (/^(?:\d+(?:[.,]\d+)?(?:万|千|w|k)?|\d{1,2}:\d{2}|刚刚|昨天|前天|\d+\s*(?:秒|分钟|小时|天|周|月|年)前)$/iu.test(text)) return "";
  if (/^(?:点赞|收藏|评论|分享|更多|播放|暂停|Like|Favorite|Comment|Share)$/iu.test(text)) return "";
  return normalizeDynamicText(text);
}

function stablePublicTokens(node) {
  const tokens = [];
  const text = stablePublicText(node.text);
  if (text) tokens.push(text);
  const description = compact(node.contentDesc);
  const cardDescription = /^(?:笔记|视频)\s+(.+?)\s+来自\s*(.+?)(?:\s+\d+(?:[.,]\d+)?(?:万|千|w|k)?赞)?$/iu.exec(description);
  if (cardDescription) {
    for (const value of cardDescription.slice(1)) {
      const token = stablePublicText(value);
      if (token) tokens.push(token);
    }
  } else {
    const token = stablePublicText(description);
    if (token) tokens.push(token);
  }
  return tokens;
}

function descendants(document, root, maximumDepth = 5) {
  const values = [];
  const queue = [{ node: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    values.push(current.node);
    if (current.depth >= maximumDepth) continue;
    for (const childIndex of current.node.children ?? []) {
      const child = document.nodes[childIndex];
      if (child) queue.push({ node: child, depth: current.depth + 1 });
    }
  }
  return values;
}

function overlapRatio(left, right) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const intersection = width * height;
  const smaller = Math.min(left.width * left.height, right.width * right.height);
  return smaller > 0 ? intersection / smaller : 0;
}

function isDescendantOf(document, node, ancestor) {
  let current = node;
  while (current?.parentIndex !== null && current?.parentIndex !== undefined) {
    if (current.parentIndex === ancestor.nodeIndex) return true;
    current = document.nodes[current.parentIndex];
  }
  return false;
}

function nearbyCardNodes(document, node, bounds, containerNode) {
  const values = [...descendants(document, node)];
  let current = node.parentIndex === null ? null : document.nodes[node.parentIndex];
  while (current && current.nodeIndex !== containerNode.nodeIndex) {
    const currentBounds = parseBounds(current.attributes.bounds);
    if (currentBounds && overlapRatio(bounds, currentBounds) >= 0.85) values.push(current);
    current = current.parentIndex === null ? null : document.nodes[current.parentIndex];
  }
  return values;
}

function cardIdentityTokens(document, node, bounds, containerNode) {
  const nearby = nearbyCardNodes(document, node, bounds, containerNode);
  const descriptor = nearby.find((entry) => /^(?:笔记|视频)\s+/u.test(compact(entry.contentDesc)));
  const source = descriptor ? [descriptor] : nearby;
  return [...new Set(source.flatMap((entry) => stablePublicTokens(entry)).filter(Boolean))].slice(0, 8);
}

function cardActionableNode(document, node, bounds) {
  if (node.clickable && node.enabled !== false) return node;
  const child = descendants(document, node, 4)
    .map((candidate) => ({ candidate, bounds: parseBounds(candidate.attributes.bounds) }))
    .filter(({ candidate, bounds: candidateBounds }) =>
      candidate.clickable &&
      candidate.enabled !== false &&
      candidateBounds &&
      overlapRatio(bounds, candidateBounds) >= 0.85)
    .sort((left, right) =>
      (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height))[0]?.candidate;
  if (child) return child;
  const ancestor = actionableAncestor(document, node);
  if (!ancestor) return null;
  const ancestorBounds = parseBounds(ancestor.attributes.bounds);
  return ancestorBounds && overlapRatio(bounds, ancestorBounds) >= 0.85 ? ancestor : null;
}

function actionableAncestor(document, node, maximumDepth = 4) {
  let current = node;
  for (let depth = 0; current && depth <= maximumDepth; depth += 1) {
    if (current.enabled !== false && current.clickable && parseBounds(current.attributes.bounds)) return current;
    current = current.parentIndex === null ? null : document.nodes[current.parentIndex];
  }
  return null;
}

function evidencePath(runDir, filePath) {
  return path.relative(runDir, filePath).replaceAll("\\", "/");
}

function itemIdentity(tokens) {
  return createHash("sha256")
    .update(tokens.join("\n"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function visibleFeedCards(document) {
  const containers = document.nodes
    .map((node) => ({ node, bounds: parseBounds(node.attributes.bounds) }))
    .filter(({ node, bounds }) => node.scrollable && bounds)
    .sort((left, right) => {
      const leftPreferred = /home[_-]?feed|feed[_-]?list|note[_-]?list/iu.test(left.node.resourceId) ? 1 : 0;
      const rightPreferred = /home[_-]?feed|feed[_-]?list|note[_-]?list/iu.test(right.node.resourceId) ? 1 : 0;
      return rightPreferred - leftPreferred || (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height);
    });
  const container = containers[0];
  if (!container) return { container: null, cards: [] };
  const containerArea = container.bounds.width * container.bounds.height;
  const candidates = [];
  for (const node of document.nodes) {
    const bounds = parseBounds(node.attributes.bounds);
    if (!bounds || node.enabled === false || !isDescendantOf(document, node, container.node)) continue;
    const area = bounds.width * bounds.height;
    if (area < containerArea * 0.04 || area > containerArea * 0.82) continue;
    const publicTokens = cardIdentityTokens(document, node, bounds, container.node);
    const semanticId = /(?:^|[/_])(?:note|feed|card|item)(?:$|[/_])/iu.test(node.resourceId);
    const semanticDescription = /^(?:笔记|视频)\s+/u.test(compact(node.contentDesc));
    if (!semanticId && !semanticDescription && publicTokens.length < 2) continue;
    const actionable = cardActionableNode(document, node, bounds);
    if (!actionable) continue;
    candidates.push({
      node: actionable,
      bounds,
      tokens: publicTokens,
      identity: itemIdentity(publicTokens),
      semanticId: semanticId || semanticDescription,
    });
  }
  candidates.sort((left, right) =>
    left.bounds.top - right.bounds.top ||
    left.bounds.left - right.bounds.left ||
    Number(right.semanticId) - Number(left.semanticId) ||
    (right.bounds.width * right.bounds.height) - (left.bounds.width * left.bounds.height));
  const unique = [];
  const identities = new Set();
  for (const candidate of candidates) {
    if (!candidate.tokens.length || identities.has(candidate.identity)) continue;
    identities.add(candidate.identity);
    unique.push(candidate);
  }
  return { container, cards: unique };
}

export function dominantPackage(document) {
  const counts = new Map();
  for (const node of document.nodes ?? []) {
    const packageName = compact(node.packageName);
    if (packageName) counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "";
}

export function openedPageSkipReason(snapshot) {
  if (snapshot?.classification?.state === "HOME_FEED") return "card_did_not_open";
  const labels = (snapshot?.document?.nodes ?? [])
    .flatMap((node) => [compact(node.text), compact(node.contentDesc)])
    .filter(Boolean);
  const commercialCta = /\u7acb\u5373(?:\u4e0b\u8f7d|\u8d2d\u4e70|\u6253\u5f00)|\u53bb(?:\u4e0b\u8f7d|\u8d2d\u4e70|\u5546\u57ce)|(?:download|shop|buy)\s+now/iu;
  if (labels.some((label) => commercialCta.test(label))) return "commercial_cta";
  if (snapshot?.classification?.state === "UNKNOWN") return "unsupported_unknown_page";
  return "unsupported_page_type";
}

export function feedSurfaceStable(left, right) {
  if (!left?.document || !right?.document) return false;
  if (dominantPackage(left.document) !== XHS_PACKAGE || dominantPackage(right.document) !== XHS_PACKAGE) return false;
  const leftCards = visibleFeedCards(left.document).cards;
  const rightCards = visibleFeedCards(right.document).cards;
  if (!leftCards.length || !rightCards.length) return false;
  const leftPositions = new Map(leftCards.map((card) => [card.identity, card.node.attributes.bounds]));
  return rightCards.some((card) => leftPositions.get(card.identity) === card.node.attributes.bounds);
}

function detailIdentitySignals(document) {
  const preferredId = /(?:nick|author|note[_-]?(?:title|content)|noteContent|matrixNickName)/iu;
  const values = [];
  for (const node of document?.nodes ?? []) {
    if (!preferredId.test(node.resourceId) && !/^\s*作者/u.test(compact(node.contentDesc))) continue;
    for (const value of [node.text, node.contentDesc]) {
      const signal = stablePublicText(value);
      if (signal.length >= 3) values.push(signal);
    }
  }
  return new Set(values);
}

export function detailSurfaceStable(left, right) {
  if (!left?.document || !right?.document) return false;
  if (dominantPackage(left.document) !== XHS_PACKAGE || dominantPackage(right.document) !== XHS_PACKAGE) return false;
  const leftState = left.classification?.state;
  const rightState = right.classification?.state;
  if (leftState !== rightState || !DETAIL_STATES.has(leftState)) return false;
  if (left.classification?.safety?.sensitive || right.classification?.safety?.sensitive) return false;
  const leftSignals = detailIdentitySignals(left.document);
  const rightSignals = detailIdentitySignals(right.document);
  return [...leftSignals].some((signal) => rightSignals.has(signal));
}

export function interactionMatch(document, action) {
  const patterns = action === "like"
    ? {
        id: /(?:^|[/_])(like|liked|heart|praise)(?:$|[/_])/iu,
        label: /^(?:点赞|已点赞|取消点赞|Like|Liked)(?:\s*\d.*)?$/iu,
        active: /已点赞|取消点赞|Liked/iu,
      }
    : {
        id: /(?:^|[/_])(favorite|favourite|collect|bookmark|save)(?:$|[/_])/iu,
        label: /^(?:收藏|已收藏|取消收藏|Favorite|Favorited|Collect|Collected|Save|Saved)(?:\s*\d.*)?$/iu,
        active: /已收藏|取消收藏|Favorited|Collected|Saved/iu,
      };
  for (const node of document.nodes) {
    const text = compact(node.text);
    const description = compact(node.contentDesc);
    if (!patterns.id.test(node.resourceId) && !patterns.label.test(text) && !patterns.label.test(description)) continue;
    const actionable = actionableAncestor(document, node) ?? (node.clickable ? node : null);
    const bounds = actionable ? parseBounds(actionable.attributes.bounds) : null;
    if (!actionable || !bounds) continue;
    const state = [text, description, compact(actionable.text), compact(actionable.contentDesc)].join(" ");
    return {
      node: actionable,
      bounds,
      active: node.checked || node.selected || actionable.checked || actionable.selected || patterns.active.test(state),
      count: interactionCount(document, actionable, action),
    };
  }
  if (action === "like") return inferredLikeMatch(document);
  return null;
}

function parseInteractionCount(value, action) {
  const normalized = compact(value);
  const actionPrefix = action === "like"
    ? /^(?:点赞|已点赞|取消点赞|Like|Liked)?\s*/iu
    : /^(?:收藏|已收藏|取消收藏|Favorite|Favorited|Collect|Collected|Save|Saved)?\s*/iu;
  const match = /^(\d+(?:\.\d+)?)\s*(万|千|w|k)?$/iu.exec(normalized.replace(actionPrefix, ""));
  if (!match) return null;
  const multiplier = /^(?:万|w)$/iu.test(match[2] ?? "") ? 10000 : /^(?:千|k)$/iu.test(match[2] ?? "") ? 1000 : 1;
  return Number(match[1]) * multiplier;
}

function interactionCount(document, node, action) {
  for (const candidate of descendants(document, node, 3)) {
    for (const value of [candidate.text, candidate.contentDesc]) {
      const count = parseInteractionCount(value, action);
      if (count !== null) return count;
    }
  }
  return null;
}

function inferredLikeMatch(document) {
  const favoriteLabel = /^(?:收藏|Favorite|Collect|Save)\s*\d/iu;
  const commentLabel = /^(?:评论|Comment)\s*\d/iu;
  for (const favoriteNode of document.nodes ?? []) {
    if (![favoriteNode.text, favoriteNode.contentDesc].some((value) => favoriteLabel.test(compact(value)))) continue;
    const favorite = actionableAncestor(document, favoriteNode) ?? (favoriteNode.clickable ? favoriteNode : null);
    if (!favorite || favorite.parentIndex === null || favorite.parentIndex === undefined) continue;
    const parent = document.nodes[favorite.parentIndex];
    const siblings = (parent?.children ?? []).map((index) => document.nodes[index]).filter(Boolean);
    const favoriteIndex = siblings.findIndex((node) => node.nodeIndex === favorite.nodeIndex);
    if (favoriteIndex < 1) continue;
    const commentAfter = siblings.slice(favoriteIndex + 1).some((node) =>
      [node.text, node.contentDesc].some((value) => commentLabel.test(compact(value))));
    if (!commentAfter) continue;
    const candidate = siblings[favoriteIndex - 1];
    const bounds = parseBounds(candidate?.attributes.bounds);
    const count = candidate ? interactionCount(document, candidate, "like") : null;
    if (!candidate?.clickable || candidate.enabled === false || !bounds || count === null) continue;
    return {
      node: candidate,
      bounds,
      active: candidate.checked || candidate.selected,
      count,
      inferred: true,
    };
  }
  return null;
}

export function interactionVerifiedAfterActivation(inspected, match) {
  if (!match) return false;
  if (match.active) return true;
  return Number.isFinite(inspected?.count) && Number.isFinite(match.count) && match.count > inspected.count;
}

export function transientOverlayKind(document) {
  const labels = (document?.nodes ?? [])
    .flatMap((node) => [compact(node.text), compact(node.contentDesc)])
    .filter(Boolean);
  if (
    labels.some((label) => /您对小红书的评分如何/u.test(label)) &&
    labels.some((label) => /1\s*到\s*5\s*颗星/u.test(label))
  ) return "app_rating";
  return null;
}

export function extractPlaybackProgressSeconds(document) {
  const values = [];
  for (const node of document.nodes ?? []) {
    const source = [compact(node.text), compact(node.contentDesc)].filter(Boolean);
    const semanticId = /(?:video[_-]?)?(?:progress|current[_-]?time|play[_-]?time|position)/iu.test(node.resourceId);
    for (const value of source) {
      if (!semanticId && !/\d{1,2}:[0-5]\d\s*[/|]\s*\d{1,2}:[0-5]\d/u.test(value)) continue;
      const match = /(?:^|\D)(\d{1,2}):([0-5]\d)(?:\D|$)/u.exec(value);
      if (match) values.push(Number(match[1]) * 60 + Number(match[2]));
    }
  }
  return values.length ? values[0] : null;
}

function packageFocusStatus(windowState, packageName = XHS_PACKAGE) {
  const focusedLines = String(windowState ?? "")
    .split(/\r?\n/u)
    .filter((line) => /mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity|ResumedActivity/u.test(line));
  const componentLines = focusedLines.filter((line) => /[A-Za-z0-9._]+\/[A-Za-z0-9.$_]+/u.test(line));
  if (!componentLines.length) return null;
  return componentLines.some((line) => line.includes(String(packageName)));
}

export function isPackageFocused(windowState, packageName = XHS_PACKAGE) {
  return packageFocusStatus(windowState, packageName) === true;
}

export function probePackageFocus(runAdb, packageName = XHS_PACKAGE) {
  const probes = [
    ["shell", "dumpsys", "window"],
    ["shell", "dumpsys", "activity", "activities"],
    ["shell", "dumpsys", "window", "windows"],
  ];
  for (const args of probes) {
    try {
      const focused = packageFocusStatus(runAdb(args), packageName);
      if (focused !== null) return { focused, probe: args.join(" ") };
    } catch {
      // Some Android versions do not expose every dumpsys subcommand. Try the next semantic focus probe.
    }
  }
  throw new FeedDeviceError(
    "FOREGROUND_STATE_UNAVAILABLE",
    "Android did not expose a current foreground component through any supported focus probe",
  );
}

export class AdbFeedAdapter {
  constructor({ adbPath, serial, deviceAlias, rules, runDir, batchControl = null }) {
    this.adbPath = adbPath;
    this.serial = serial;
    this.deviceAlias = deviceAlias;
    this.rules = rules;
    this.runDir = runDir;
    this.captureSequence = 0;
    this.context = { deviceAlias, xhsVersion: "", androidSdk: "", resolution: "", dpi: "" };
    this.currentDetailSnapshot = null;
    this.batchControl = batchControl;
  }

  sanitize(value) {
    return String(value ?? "").replaceAll(this.serial, "[device]");
  }

  adb(args, { binary = false, sent = false, timeout = 30000, allowFailureWithOutput = false } = {}) {
    if (sent) this.assertBatchActive();
    const result = spawnSync(this.adbPath, ["-s", this.serial, ...args], {
      encoding: binary ? null : "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = binary ? result.stdout : String(result.stdout ?? "");
    if (result.error || (result.status !== 0 && !(allowFailureWithOutput && output.includes("</hierarchy>")))) {
      const detail = result.error?.message || (binary ? result.stderr?.toString("utf8") : result.stderr) || "ADB command failed";
      throw new FeedDeviceError("ADB_COMMAND_FAILED", this.sanitize(detail).trim(), { sent });
    }
    return result.stdout;
  }

  assertBatchActive() {
    if (!this.batchControl) return;
    assertBatchControlActiveSync(this.batchControl.paths, {
      attemptId: this.batchControl.attemptId,
      requireStart: true,
    });
  }

  async initializeContext() {
    const packageDump = this.adb(["shell", "dumpsys", "package", XHS_PACKAGE]);
    this.context.xhsVersion = /versionName=([^\s]+)/u.exec(packageDump)?.[1] ?? "";
    this.context.androidSdk = compact(this.adb(["shell", "getprop", "ro.build.version.sdk"]));
    const size = this.adb(["shell", "wm", "size"]);
    this.context.resolution = /(?:Physical|Override) size:\s*(\d+x\d+)/iu.exec(size)?.[1] ?? "";
    const density = this.adb(["shell", "wm", "density"]);
    this.context.dpi = /(?:Physical|Override) density:\s*(\d+)/iu.exec(density)?.[1] ?? "";
  }

  async captureUiHierarchy() {
    const remote = "/sdcard/xhs_feed_window.xml";
    const attempts = [
      {
        name: "direct-primary",
        run: () => this.adb(
          ["exec-out", "uiautomator", "dump", "/dev/tty"],
          { timeout: 10000, allowFailureWithOutput: true },
        ),
      },
      {
        name: "remote-file",
        run: () => {
          try {
            this.adb(["shell", "rm", "-f", remote]);
            this.adb(["shell", "uiautomator", "dump", remote], { timeout: 15000 });
            return this.adb(["exec-out", "cat", remote], { timeout: 5000 });
          } finally {
            try { this.adb(["shell", "rm", "-f", remote]); } catch {}
          }
        },
      },
      {
        name: "direct-final",
        run: () => this.adb(
          ["exec-out", "uiautomator", "dump", "/dev/tty"],
          { timeout: 10000, allowFailureWithOutput: true },
        ),
      },
    ];
    let lastCauseCode = "invalid_xml";
    let lastRawBytes = null;
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      try {
        const raw = attempt.run();
        lastRawBytes = countUiDumpBytes(raw);
        const xml = extractHierarchyXml(raw);
        if (!xml) throw new FeedDeviceError("UI_DUMP_INVALID", attempt.name + " returned incomplete hierarchy output");
        const document = parseUiAutomatorXml(xml);
        return { xml, document, source: attempt.name, rawBytes: lastRawBytes };
      } catch (error) {
        lastCauseCode = String(error?.code ?? error?.name ?? "unknown");
      }
      if (index < attempts.length - 1) await this.pause(index === 0 ? 400 : 750);
    }
    throw new FeedDeviceError(
      "UI_DUMP_INVALID",
      "UI hierarchy remained unavailable after three bounded dump attempts",
      { attempts: attempts.length, lastCauseCode, rawBytes: lastRawBytes },
    );
  }

  async readUi(stage) {
    const { xml, document, rawBytes } = await this.captureUiHierarchy();
    const classification = classifyPage(document, this.rules, this.context);
    const suffix = String(++this.captureSequence).padStart(3, "0");
    const safeStage = String(stage).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 48);
    const xmlPath = path.join(this.runDir, "evidence", suffix + "-" + safeStage + ".xml");
    await writeFile(xmlPath, xml, "utf8");
    return {
      xml,
      document,
      classification,
      fingerprint: createNormalizedFingerprint(document).hash,
      foregroundPackage: dominantPackage(document),
      path: xmlPath,
      rawBytes,
    };
  }

  async stableUi(stage, timeoutMs = 8000) {
    const started = Date.now();
    let previous = null;
    let samples = 0;
    const maximumSamples = 4;
    while (samples < maximumSamples && (samples < 2 || Date.now() - started < timeoutMs)) {
      const current = await this.readUi(stage);
      samples += 1;
      if (current.foregroundPackage !== XHS_PACKAGE) {
        throw new FeedDeviceError(
          "APP_LEFT_FOREGROUND",
          "XHS left the foreground while the workflow was waiting for a stable UI",
        );
      }
      if (
        previous?.fingerprint === current.fingerprint ||
        feedSurfaceStable(previous, current) ||
        detailSurfaceStable(previous, current)
      ) return current;
      previous = current;
      if (Date.now() - started < timeoutMs) await this.pause(500);
    }
    throw new FeedDeviceError("UI_NOT_STABLE", "UI did not produce two semantically stable hierarchy samples");
  }

  async readUiTransition(stage) {
    try {
      return await this.readUi(stage);
    } catch (error) {
      if (error?.code !== "UI_DUMP_INVALID") throw error;
      return {
        error: true,
        code: "UI_DUMP_INVALID",
        message: error.message,
        rawBytes: Number.isInteger(error?.rawBytes) ? error.rawBytes : null,
        parseError: String(error?.lastCauseCode ?? error?.message ?? error?.name ?? "unknown"),
      };
    }
  }

  async stableUiWhileTransitioning(stage, { maxAttempts = DETAIL_TRANSITION_ATTEMPTS, pauseMs = 600 } = {}) {
    let lastFailure = null;
    let lastReadable = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const current = await this.readUiTransition(stage);
      if (current.error) {
        lastFailure = current;
      } else {
        if (current.foregroundPackage !== XHS_PACKAGE) {
          throw new FeedDeviceError(
            "APP_LEFT_FOREGROUND",
            "XHS left the foreground while the workflow was waiting for a detail transition",
          );
        }
        const readable = {
          sample: current,
          attempts: attempt,
          rawBytes: Number.isInteger(current.rawBytes) ? current.rawBytes : countUiDumpBytes(current.xml),
          parseError: null,
        };
        if (DETAIL_STATES.has(current.classification.state)) return readable;
        lastReadable = readable;
      }
      if (attempt < maxAttempts) await this.pause(pauseMs);
    }
    if (lastReadable) return { ...lastReadable, attempts: maxAttempts };
    throw new FeedDeviceError(
      "UI_DUMP_INVALID",
      "UI hierarchy remained unavailable during detail transition after " + maxAttempts + " bounded attempts",
      {
        attempts: maxAttempts,
        rawBytes: lastFailure?.rawBytes ?? null,
        lastCauseCode: lastFailure?.parseError ?? "unknown",
      },
    );
  }

  assertOperable(snapshot, expectedStates = null) {
    if (snapshot.classification.safety?.sensitive || snapshot.classification.state === "LOGIN_OR_CHALLENGE") {
      throw new FeedDeviceError("SENSITIVE_PAGE", "Feed workflow stopped on a login, challenge, or sensitive page");
    }
    if (expectedStates && !expectedStates.has(snapshot.classification.state)) {
      throw new FeedDeviceError(
        "UNEXPECTED_PAGE",
        "Expected " + [...expectedStates].join("/") + " but found " + snapshot.classification.state,
      );
    }
  }

  tapNode(node, { sent = true } = {}) {
    const bounds = parseBounds(node.attributes.bounds);
    if (!bounds) throw new FeedDeviceError("SEMANTIC_BOUNDS_MISSING", "A semantic UI control had no current bounds", { sent: false });
    const point = center(bounds);
    this.adb(["shell", "input", "tap", String(point.x), String(point.y)], { sent });
  }

  async pause(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async stableUiWhileStarting(stage) {
    try {
      return await this.stableUi(stage);
    } catch (error) {
      if (error?.code === "APP_LEFT_FOREGROUND") return null;
      throw error;
    }
  }

  async recoverHomeWithBack(snapshot, stage) {
    let current = snapshot;
    for (let attempt = 1; current && attempt <= STARTUP_BACK_ATTEMPTS; attempt += 1) {
      this.assertOperable(current);
      if (current.classification.state === "HOME_FEED") return current;
      this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
      current = await this.stableUiWhileStarting(stage + "-back-" + attempt);
    }
    return current;
  }

  async recoverHomeWithTab(snapshot, stage) {
    if (!snapshot) return null;
    this.assertOperable(snapshot);
    if (snapshot.classification.state === "HOME_FEED") return snapshot;
    const homeNode = snapshot.document.nodes.find((node) =>
      /tab[_-]?home|home[_-]?tab|bottom[_-]?home/iu.test(node.resourceId) ||
      compact(node.text) === "首页" ||
      compact(node.contentDesc) === "首页");
    const actionable = homeNode ? actionableAncestor(snapshot.document, homeNode) : null;
    if (!actionable) return null;
    this.tapNode(actionable);
    const after = await this.stableUi(stage + "-home-tab");
    this.assertOperable(after, new Set(["HOME_FEED"]));
    return after;
  }

  async captureFailure() {
    const imagePath = path.join(this.runDir, "failure.png");
    try {
      const png = this.adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 15000 });
      await writeFile(imagePath, png);
      return evidencePath(this.runDir, imagePath);
    } catch {
      return null;
    }
  }

  async captureScreenshot(stage) {
    const imagePath = path.join(
      this.runDir,
      "evidence",
      String(++this.captureSequence).padStart(3, "0") + "-" +
      String(stage).replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 48) + ".png",
    );
    try {
      const png = this.adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 15000 });
      await writeFile(imagePath, png);
      return evidencePath(this.runDir, imagePath);
    } catch {
      return null;
    }
  }

  async ensureFeed() {
    await this.initializeContext();
    let snapshot = await this.stableUiWhileStarting("feed-entry-current");
    let sawXhsPage = Boolean(snapshot);
    if (snapshot) {
      if (DETAIL_STATES.has(snapshot.classification.state)) {
        this.assertOperable(snapshot);
        this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
        const recovered = await this.stableUiWhileStarting("feed-entry-current-back-1");
        if (recovered?.classification.state !== "HOME_FEED") {
          throw new FeedDeviceError(
            "RESIDUAL_DETAIL",
            "Task started on a residual detail page and one Back did not return to the feed",
          );
        }
        return { verified: true, evidence: { feedEntry: evidencePath(this.runDir, recovered.path) } };
      }
      snapshot = await this.recoverHomeWithBack(snapshot, "feed-entry-current");
      if (snapshot?.classification.state === "HOME_FEED") {
        return { verified: true, evidence: { feedEntry: evidencePath(this.runDir, snapshot.path) } };
      }
      if (snapshot) {
        const tabRecovered = await this.recoverHomeWithTab(snapshot, "feed-entry-current");
        if (tabRecovered) {
          return { verified: true, evidence: { feedEntry: evidencePath(this.runDir, tabRecovered.path) } };
        }
      }
    }

    for (let attempt = 1; attempt <= STARTUP_LAUNCH_ATTEMPTS; attempt += 1) {
      this.adb(["shell", "monkey", "-p", XHS_PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"], { sent: true });
      await this.pause(900);
      snapshot = await this.stableUiWhileStarting("feed-entry-launch-" + attempt);
      sawXhsPage ||= Boolean(snapshot);
      if (!snapshot) continue;
      snapshot = await this.recoverHomeWithBack(snapshot, "feed-entry-launch-" + attempt);
      if (snapshot?.classification.state === "HOME_FEED") {
        return { verified: true, evidence: { feedEntry: evidencePath(this.runDir, snapshot.path) } };
      }
      const tabRecovered = await this.recoverHomeWithTab(snapshot, "feed-entry-launch-" + attempt);
      if (tabRecovered) {
        return { verified: true, evidence: { feedEntry: evidencePath(this.runDir, tabRecovered.path) } };
      }
    }
    if (!sawXhsPage) throw new FeedDeviceError("APP_ENTRY_FAILED", "XHS did not produce a stable foreground page after relaunch");
    throw new FeedDeviceError(
      "HOME_TAB_NOT_FOUND",
      "XHS home could not be recovered with BACK, relaunch, or the semantic home tab",
    );
  }

  async scrollFeed(snapshot, container) {
    const bounds = container?.bounds;
    if (!bounds) throw new FeedDeviceError("FEED_CONTAINER_NOT_FOUND", "No semantic scrollable feed container was found");
    const x = Math.round((bounds.left + bounds.right) / 2);
    const startY = Math.round(bounds.top + bounds.height * 0.78);
    const endY = Math.round(bounds.top + bounds.height * 0.28);
    this.adb(["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"], { sent: true });
    return this.stableUi("feed-scroll");
  }

  async backToFeed(stage) {
    this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
    const after = await this.stableUi(stage);
    this.assertOperable(after, new Set(["HOME_FEED"]));
    this.currentDetailSnapshot = null;
    return after;
  }

  async backToFeedOptional(stage) {
    this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
    const after = await this.stableUi(stage);
    this.assertOperable(after);
    const returnedToFeed = after.classification.state === "HOME_FEED";
    if (returnedToFeed) this.currentDetailSnapshot = null;
    return { snapshot: after, returnedToFeed };
  }

  async openNextUnique(seen, index) {
    let snapshot = await this.stableUi("item-" + index + "-feed");
    this.assertOperable(snapshot, new Set(["HOME_FEED"]));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const found = visibleFeedCards(snapshot.document);
      const candidate = found.cards.find((entry) => !seen.has(entry.identity));
      if (candidate) {
        const feedPath = snapshot.path;
        this.tapNode(candidate.node);

        let detailTransitionAttempts = 0;
        let uiDumpRawBytes = null;
        let uiDumpParseError = null;
        let detail;
        const transitionResult = await this.stableUiWhileTransitioning("item-" + index + "-detail");
        detailTransitionAttempts = transitionResult.attempts;
        detail = transitionResult.sample;
        uiDumpRawBytes = transitionResult.rawBytes;
        uiDumpParseError = transitionResult.parseError;

        const screenshotAvailable = await this.captureScreenshot("item-" + index + "-detail");
        this.assertOperable(detail);
        if (!DETAIL_STATES.has(detail.classification.state)) {
          const returned = detail.classification.state === "HOME_FEED"
            ? { snapshot: detail, returnedToFeed: true }
            : await this.backToFeedOptional("item-" + index + "-skip-returned");
          if (!returned.returnedToFeed) {
            throw new FeedDeviceError(
              "RETURN_TO_FEED_FAILED",
              "One Back did not verify a return to HOME_FEED after an unsupported detail",
            );
          }
          return {
            skipped: true,
            identity: candidate.identity,
            pageState: detail.classification.state,
            reason: openedPageSkipReason(detail),
            evidence: {
              feedBefore: evidencePath(this.runDir, feedPath),
              unsupported: evidencePath(this.runDir, detail.path),
              returned: evidencePath(this.runDir, returned.snapshot.path),
              detailTransitionAttempts,
              uiDumpRawBytes,
              uiDumpParseError,
              contentKind: detail.classification.state,
              videoSkipped: false,
              detailVisited: detail.classification.state !== "HOME_FEED",
              returnedToList: returned.returnedToFeed,
              screenshotAvailable,
            },
          };
        }
        const detailText = detail.document.nodes
          .flatMap((node) => [stablePublicText(node.text), stablePublicText(node.contentDesc)])
          .filter(Boolean)
          .join(" ");
        const identityVerified = candidate.tokens.some((token) => token.length >= 3 && detailText.includes(token));
        if (!identityVerified) {
          const returned = await this.backToFeedOptional("item-" + index + "-identity-mismatch-returned");
          if (!returned.returnedToFeed) {
            throw new FeedDeviceError(
              "RETURN_TO_FEED_FAILED",
              "One Back did not verify a return to HOME_FEED after an identity mismatch",
            );
          }
          return {
            skipped: true,
            identity: candidate.identity,
            pageState: detail.classification.state,
            reason: "identity_mismatch",
            evidence: {
              feedBefore: evidencePath(this.runDir, feedPath),
              unsupported: evidencePath(this.runDir, detail.path),
              returned: evidencePath(this.runDir, returned.snapshot.path),
              detailTransitionAttempts,
              uiDumpRawBytes,
              uiDumpParseError,
              contentKind: detail.classification.state,
              videoSkipped: false,
              detailVisited: true,
              returnedToList: returned.returnedToFeed,
              screenshotAvailable,
            },
          };
        }
        this.currentDetailSnapshot = detail;
        return {
          identity: candidate.identity,
          pageType: detail.classification.state,
          evidence: {
            feedBefore: evidencePath(this.runDir, feedPath),
            detail: evidencePath(this.runDir, detail.path),
            detailTransitionAttempts,
            uiDumpRawBytes,
            uiDumpParseError,
            contentKind: detail.classification.state,
            videoSkipped: false,
            detailVisited: true,
            returnedToList: false,
            screenshotAvailable,
          },
        };
      }
      snapshot = await this.scrollFeed(snapshot, found.container);
      this.assertOperable(snapshot, new Set(["HOME_FEED"]));
    }
    throw new FeedDeviceError("FEED_EXHAUSTED", "No new verified feed item appeared within the bounded scroll budget");
  }

  async dwell(item, { plannedSeconds }) {
    const before = this.currentDetailSnapshot ?? await this.readUi("item-" + item.index + "-dwell-before");
    this.assertOperable(before, DETAIL_STATES);
    const video = item.pageType === "VIDEO_NOTE";
    const beforeProgress = video ? extractPlaybackProgressSeconds(before.document) : null;
    const started = performance.now();
    const deadline = started + Number(plannedSeconds) * 1000;
    while (performance.now() < deadline) {
      const remaining = deadline - performance.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, remaining))));
      this.assertBatchActive();
      const focus = probePackageFocus((args) => this.adb(args));
      if (!focus.focused) {
        throw new FeedDeviceError("APP_LEFT_FOREGROUND", "XHS left the foreground during the dwell interval");
      }
    }
    const after = await this.readUi("item-" + item.index + "-dwell-after");
    this.assertOperable(after, DETAIL_STATES);
    const afterProgress = video ? extractPlaybackProgressSeconds(after.document) : null;
    let playbackProgressVerified = null;
    if (video && (beforeProgress !== null || afterProgress !== null)) {
      if (beforeProgress === null || afterProgress === null) {
        throw new FeedDeviceError(
          "VIDEO_PLAYBACK_PROGRESS_INCONSISTENT",
          "Video progress was exposed on only one side of the dwell interval",
        );
      }
      playbackProgressVerified = afterProgress !== beforeProgress;
      if (!playbackProgressVerified) {
        throw new FeedDeviceError("VIDEO_PLAYBACK_NOT_PROGRESSING", "Video progress was exposed but did not change during the dwell interval");
      }
    }
    this.currentDetailSnapshot = after;
    return {
      verified: true,
      actualSeconds: Math.round(((performance.now() - started) / 1000) * 10) / 10,
      foregroundVerified: true,
      playbackProgressVerified,
      beforeProgressSeconds: beforeProgress,
      afterProgressSeconds: afterProgress,
      evidence: {
        before: evidencePath(this.runDir, before.path),
        after: evidencePath(this.runDir, after.path),
      },
    };
  }

  async inspectAction(action, item) {
    const snapshot = await this.stableUi("item-" + item.index + "-" + action + "-before");
    this.assertOperable(snapshot, DETAIL_STATES);
    const match = interactionMatch(snapshot.document, action);
    if (!match) throw new FeedDeviceError("ACTION_CONTROL_NOT_FOUND", "The " + action + " control was not found on the current detail");
    return {
      active: match.active,
      count: match.count,
      node: match.node,
      evidence: { before: evidencePath(this.runDir, snapshot.path) },
    };
  }

  async activateActionOnce(action, item, inspected) {
    try {
      this.tapNode(inspected.node, { sent: true });
      let after = await this.stableUi("item-" + item.index + "-" + action + "-after");
      if (after.classification.state === "UNKNOWN" && transientOverlayKind(after.document)) {
        this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
        after = await this.stableUi("item-" + item.index + "-" + action + "-overlay-dismissed");
      }
      this.assertOperable(after, DETAIL_STATES);
      const match = interactionMatch(after.document, action);
      return {
        verified: interactionVerifiedAfterActivation(inspected, match),
        evidence: { after: evidencePath(this.runDir, after.path) },
      };
    } catch (error) {
      error.sent = true;
      throw error;
    }
  }

  async returnToFeed(item) {
    const after = await this.backToFeed("item-" + item.index + "-returned");
    return {
      verified: true,
      evidence: {
        returned: evidencePath(this.runDir, after.path),
        returnedToList: true,
      },
    };
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, filePath);
}

async function runCli(argv) {
  const options = parseCli(argv);
  const deviceAlias = requireOption(options, "device-alias");
  if (!SAFE_ALIAS.test(deviceAlias)) throw new Error("device-alias is invalid");
  const spec = normalizeFeedSpec({
    taskId: requireOption(options, "task-id"),
    count: requireOption(options, "count"),
    likeAt: options["like-at"],
    favoriteAt: options["favorite-at"],
    imageMinSeconds: options["image-min-seconds"],
    imageMaxSeconds: options["image-max-seconds"],
    videoMinSeconds: options["video-min-seconds"],
    videoMaxSeconds: options["video-max-seconds"],
    videoPolicy: options["video-policy"],
    videoDwellMs: options["video-dwell-ms"],
  });
  const adbPath = path.resolve(requireOption(options, "adb-path"));
  const serial = requireOption(options, "serial");
  const outputRoot = path.resolve(options["output-root"] || path.join(PROJECT_ROOT, "data", "feed"));
  const rulesPath = path.resolve(options.rules || path.join(PROJECT_ROOT, "config", "xhs-page-rules.json"));
  const batchRootOption = options["batch-root"];
  const batchAttemptId = options["batch-attempt-id"];
  if (Boolean(batchRootOption) !== Boolean(batchAttemptId)) {
    throw new Error("--batch-root and --batch-attempt-id must be supplied together");
  }
  const batchControl = batchRootOption
    ? { paths: batchControlPaths(path.resolve(batchRootOption), batchAttemptId), attemptId: batchAttemptId }
    : null;
  if (batchControl && (spec.likeAt || spec.favoriteAt)) {
    throw new Error("Feed batch V1 is read-only and rejects interactions");
  }
  if (batchControl && (spec.count > 10 || spec.videoPolicy !== "skip_and_count" || spec.videoDwellMs !== 0)) {
    throw new Error("Feed batch V1 requires count<=10 and zero-dwell video skip policy");
  }
  const runDir = path.resolve(outputRoot, spec.taskId);
  if (path.dirname(runDir) !== outputRoot) throw new Error("task-id escaped the feed output root");
  await mkdir(path.join(runDir, "evidence"), { recursive: true });

  const checkpointPath = path.join(runDir, "checkpoint.json");
  const summaryPath = path.join(runDir, "summary.json");
  const eventsPath = path.join(runDir, "events.jsonl");
  const checkpoint = existsSync(checkpointPath)
    ? JSON.parse(await readFile(checkpointPath, "utf8"))
    : null;
  const rules = await loadRules(rulesPath);
  const adapter = new AdbFeedAdapter({ adbPath, serial, deviceAlias, rules, runDir, batchControl });
  let eventSequence = 0;
  const emit = async (event) => {
    await appendFile(eventsPath, JSON.stringify({ seq: ++eventSequence, at: new Date().toISOString(), ...event }) + "\n", "utf8");
  };

  try {
    const summary = await runFeedWorkflow({
      spec,
      deviceAlias,
      adapter,
      checkpoint,
      saveCheckpoint: (value) => writeJsonAtomic(checkpointPath, value),
      emit,
    });
    await writeJsonAtomic(summaryPath, summary);
    process.stdout.write(JSON.stringify({
      taskId: summary.taskId,
      status: summary.status,
      duplicate: summary.duplicate,
      viewedCount: summary.viewedCount,
      skippedCount: summary.skippedCount,
      summaryPath,
      checkpointPath,
      eventsPath,
    }, null, 2) + "\n");
  } catch (error) {
    if (batchControl) {
      const code = String(error?.code ?? "FEED_WORKER_FAILED").toUpperCase();
      const category = classifyFeedBatchFailure(code);
      if (category === "global_safety" || category === "batch_integrity") {
        tripBatchFuse(batchControl.paths, {
          attemptId: batchAttemptId,
          category,
          code,
          taskId: spec.taskId,
        });
      }
    }
    const failureScreenshot = await adapter.captureFailure();
    const persisted = existsSync(checkpointPath)
      ? JSON.parse(await readFile(checkpointPath, "utf8"))
      : null;
    const failure = {
      schemaVersion: 1,
      taskId: spec.taskId,
      deviceAlias,
      status: persisted?.status ?? "failed",
      viewedCount: persisted?.items?.length ?? 0,
      skippedCount: persisted?.skipped?.length ?? 0,
      failureSignature: persisted?.failureSignature ?? "feed:startup",
      message: adapter.sanitize(error?.message ?? error),
      failureScreenshot,
      checkpointPath,
      eventsPath,
    };
    await writeJsonAtomic(summaryPath, failure);
    process.stderr.write(JSON.stringify(failure, null, 2) + "\n");
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(JSON.stringify({ status: "failed", message: String(error?.message ?? error) }) + "\n");
    process.exitCode = 2;
  });
}
