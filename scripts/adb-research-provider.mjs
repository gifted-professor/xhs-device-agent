import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

import {
  classifyPage,
  loadRules,
  parseUiAutomatorXml,
  resolveSemanticTarget,
} from "./xhs-page-engine.mjs";

const DEFAULT_PACKAGE = "com.xingin.xhs";
const DEFAULT_RULES_PATH = fileURLToPath(new URL("../config/xhs-page-rules.json", import.meta.url));
const ALLOWED_SOURCES = new Set(["search", "suggestions", "trending", "recommended"]);
const LIST_STATES = new Set(["HOME_FEED", "SEARCH_SUGGESTIONS", "SEARCH_RESULTS", "TRENDING", "RECOMMENDED"]);
const KNOWN_STATES = new Set([
  "HOME_FEED", "SEARCH_ENTRY", "SEARCH_SUGGESTIONS", "SEARCH_RESULTS", "TRENDING", "RECOMMENDED",
  "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL", "NETWORK_ERROR", "UPDATE_MODAL", "LOGIN_OR_CHALLENGE", "UNKNOWN",
]);
const FORBIDDEN_INTERACTION = /(?:^|[_\s-])(like|favorite|favourite|collect|follow|comment|message|publish|post|delete|send)(?:$|[_\s-])|点赞|收藏|关注|评论|私信|发布|删除|发送/iu;
const SAFE_IME_SERVICE = /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/u;
const BRIDGE_IME_SERVICE = /(?:com\.android\.xwkeyboard|com\.xueren|com\.truedian\.dragon)/iu;
const NATIVE_IME_SUBTYPE_EVIDENCE = [
  [/com\.sohu\.inputmethod\.sogou/iu, /mImeName=[^\r\n]*搜狗[^\r\n]*mSubtypeName=中文（中国）/u],
  [/com\.baidu\.input/iu, /mImeName=[^\r\n]*百度[^\r\n]*mSubtypeName=中文（中国）/u],
  [/com\.iflytek\.inputmethod/iu, /mImeName=[^\r\n]*讯飞[^\r\n]*mSubtypeName=中文（中国）/u],
];
const PAGE_TARGET_ALIASES = new Map([
  ["search_entry", "search_entry"], ["search field", "search_entry"], ["search box", "search_entry"], ["搜索框", "search_entry"],
  ["home_tab", "home_tab"], ["home tab", "home_tab"], ["首页", "home_tab"],
  ["trending_entry", "trending_entry"], ["trending", "trending_entry"], ["热搜入口", "trending_entry"],
  ["recommendation_entry", "recommendation_entry"], ["recommendations", "recommendation_entry"], ["推荐入口", "recommendation_entry"],
  ["search_submit", "search_submit"], ["submit search", "search_submit"], ["提交搜索", "search_submit"],
  ["retry", "retry"], ["重试", "retry"], ["dismiss_update", "dismiss_update"], ["关闭更新", "dismiss_update"],
]);

class ProviderStop extends Error {
  constructor(status, failureSignature, reason, options = {}) {
    super(reason);
    this.name = "ProviderStop";
    this.status = status;
    this.failureSignature = failureSignature;
    this.reason = reason;
    this.stopAll = Boolean(options.stopAll);
    this.humanReview = options.humanReview ?? [];
    this.affectsDeviceHealth = options.affectsDeviceHealth !== false;
  }
}

function defaultCommandRunner({ file, args, timeoutMs = 15_000, encoding = "utf8" }) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (Number.isInteger(error.code) ? error.code : -1) : 0,
        stdout: stdout ?? (encoding ? "" : Buffer.alloc(0)),
        stderr: stderr ?? (encoding ? "" : Buffer.alloc(0)),
        signal: error?.signal ?? null,
      });
    });
  });
}

function text(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value ?? "");
}

function normalizeRunnerResult(value, encoding) {
  if (typeof value === "string" || Buffer.isBuffer(value)) return { exitCode: 0, stdout: value, stderr: encoding ? "" : Buffer.alloc(0) };
  return {
    exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : Number.isInteger(value?.code) ? value.code : 0,
    stdout: value?.stdout ?? (encoding ? "" : Buffer.alloc(0)),
    stderr: value?.stderr ?? (encoding ? "" : Buffer.alloc(0)),
  };
}

function hash(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function parseBounds(value) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(String(value ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (left < 0 || top < 0 || right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function nodeAtPath(document, path) {
  if (!/^\/(?:\d+)(?:\/\d+)*$/.test(String(path ?? ""))) return null;
  const parts = path.slice(1).split("/").map(Number);
  let node = document.nodes[document.roots[parts[0]]];
  for (const childOffset of parts.slice(1)) {
    if (!node || childOffset >= node.children.length) return null;
    node = document.nodes[node.children[childOffset]];
  }
  return node ?? null;
}

function descendants(document, root) {
  const output = [];
  const queue = [...root.children];
  while (queue.length) {
    const node = document.nodes[queue.shift()];
    if (!node) continue;
    output.push(node);
    queue.push(...node.children);
  }
  return output;
}

function allNodeValues(node) {
  return [node.text, node.contentDesc, node.resourceId, ...Object.values(node.attributes ?? {})].filter(Boolean).join(" ");
}

function publicNoteId(nodes) {
  const source = nodes.map(allNodeValues).join(" ");
  const explicit = /(?:note(?:Id|_id|[-_]id)?[=:/'"\s]+)([0-9a-f]{16,32})/iu.exec(source)?.[1];
  return explicit ?? /\b[0-9a-f]{24}\b/iu.exec(source)?.[0] ?? null;
}

function mediaType(nodes) {
  const source = nodes.map(allNodeValues).join(" ").toLowerCase();
  if (/video|player|视频|播放/.test(source)) return "video";
  if (/image|photo|picture|图文|图片/.test(source)) return "image";
  return "unknown";
}

function descriptorNoteMetadata(value) {
  const descriptor = compact(value);
  const kind = /^(?:\u7b14\u8bb0|\u89c6\u9891)\s+/u.exec(descriptor);
  if (!kind) return null;
  const body = descriptor.slice(kind[0].length);
  const fromIndex = body.lastIndexOf(" \u6765\u81ea");
  if (fromIndex <= 0) return null;
  const title = compact(body.slice(0, fromIndex));
  let author = compact(body.slice(fromIndex + 3));
  author = author.replace(/\s+\d[\d,.]*\s*\u8d5e(?:\s|$).*$/u, "").trim();
  if (!title || !author) return null;
  return { title, author, mediaType: kind[0].startsWith("\u89c6") ? "video" : "image" };
}

function firstText(nodes, idPattern, excluded = new Set()) {
  const preferred = nodes.find((node) => idPattern.test(node.resourceId) && compact(node.text) && !excluded.has(compact(node.text)));
  if (preferred) return compact(preferred.text);
  const fallback = nodes.find((node) => {
    const value = compact(node.text);
    return value.length >= 2 && value.length <= 200 && !excluded.has(value) && !/^\d+(?:[.,]\d+)?(?:万|w|k)?$/iu.test(value);
  });
  return compact(fallback?.text);
}

function noteCardEntries(document) {
  const roots = [];
  for (const node of document.nodes) {
    if (/(?:note|feed|result)[_-]?(?:card|item)(?:$|[_/])/iu.test(node.resourceId)) roots.push(node);
  }
  if (!roots.length) {
    for (const titleNode of document.nodes.filter((node) => /note[_-]?title|title_text/iu.test(node.resourceId) && compact(node.text))) {
      let current = titleNode;
      for (let depth = 0; depth < 4 && current.parentIndex !== null; depth += 1) {
        const parent = document.nodes[current.parentIndex];
        current = parent;
        if (parent.clickable || /item|card/iu.test(parent.resourceId)) break;
      }
      roots.push(current);
    }
  }
  for (const node of document.nodes) {
    if (descriptorNoteMetadata(node.contentDesc)) roots.push(node);
  }
  const chrome = new Set(["综合", "最新", "用户", "商品", "搜索", "关注", "发现", "推荐", "首页"]);
  const output = [];
  const seenRoots = new Set();
  for (const root of roots) {
    if (seenRoots.has(root.nodeIndex)) continue;
    seenRoots.add(root.nodeIndex);
    const nodes = [root, ...descendants(document, root)];
    const descriptor = descriptorNoteMetadata(root.contentDesc);
    const title = descriptor?.title || firstText(nodes, /note[_-]?title|title_text/iu, chrome);
    if (!title) continue;
    const author = descriptor?.author || firstText(nodes, /author|nickname|user[_-]?name/iu, new Set([title])) || "";
    const type = descriptor?.mediaType ?? mediaType(nodes);
    const noteId = publicNoteId(nodes);
    const metrics = {};
    for (const node of nodes) {
      const value = compact(node.text || node.contentDesc);
      if (!value) continue;
      if (/like|赞/iu.test(node.resourceId)) metrics.likes = value.slice(0, 40);
      else if (/collect|favorite|收藏/iu.test(node.resourceId)) metrics.favorites = value.slice(0, 40);
      else if (/comment|评论/iu.test(node.resourceId)) metrics.comments = value.slice(0, 40);
    }
    output.push({ root, nodes, title, author, mediaType: type, noteId, metrics });
  }
  return output;
}

function noteCandidates(snapshot, source, keyword) {
  const output = [];
  for (const entry of noteCardEntries(snapshot.document)) {
    const { title, author, noteId, metrics } = entry;
    const type = entry.mediaType;
    const fallback = `${author}\u0000${title}\u0000${type}`;
    output.push({
      candidateId: `adb-${hash(noteId || fallback).slice(0, 20)}`,
      noteId,
      author,
      title,
      mediaType: type,
      source,
      keyword,
      ...(Object.keys(metrics).length ? { publicMetrics: metrics } : {}),
    });
  }
  return output;
}

function exactCardMatches(snapshot, candidate) {
  const entries = noteCardEntries(snapshot.document);
  const wantedId = compact(candidate?.noteId).toLocaleLowerCase();
  const wantedTitle = compact(candidate?.title);
  if (wantedId) {
    const idMatches = entries.filter((entry) => compact(entry.noteId).toLocaleLowerCase() === wantedId);
    if (idMatches.length) return { matches: idMatches, matchedBy: "noteId" };
  }
  if (wantedTitle) return { matches: entries.filter((entry) => entry.title === wantedTitle), matchedBy: "title" };
  return { matches: [], matchedBy: null };
}

const QUERY_CHROME = new Set([
  "搜索", "取消", "搜索发现", "猜你想搜", "历史搜索", "大家都在搜", "热搜榜", "小红书热搜", "热点榜", "实时热点",
]);

function queryCandidates(snapshot, source, keyword) {
  const statePattern = source === "trending" ? /hot|trend|rank|topic|keyword/iu : /suggest|query|keyword|history/iu;
  const containers = snapshot.document.nodes.filter((node) => node.scrollable && parseBounds(node.attributes.bounds));
  const pool = containers.length ? containers.flatMap((node) => descendants(snapshot.document, node)) : snapshot.document.nodes;
  let nodes = pool.filter((node) => statePattern.test(node.resourceId) && compact(node.text));
  if (!nodes.length) nodes = pool.filter((node) => node.clickable && compact(node.text));
  const seen = new Set();
  const output = [];
  for (const node of nodes) {
    const value = compact(node.text);
    if (value.length < 2 || value.length > 100 || QUERY_CHROME.has(value) || /^\d+[.、]?$/.test(value) || value === compact(keyword)) continue;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      candidateId: `adb-query-${hash(`${source}\u0000${value}`).slice(0, 16)}`,
      noteId: null,
      author: "",
      title: value,
      query: value,
      mediaType: "query",
      source,
      keyword,
    });
  }
  return output;
}

function extractCandidates(snapshot, source, keyword) {
  return source === "suggestions" || source === "trending"
    ? queryCandidates(snapshot, source, keyword)
    : noteCandidates(snapshot, source, keyword);
}

function containerPattern(state) {
  if (state === "SEARCH_RESULTS") return /search[_-]?result|result[_-]?list|note[_-]?list/iu;
  if (state === "SEARCH_SUGGESTIONS") return /suggest|history|query/iu;
  if (state === "TRENDING") return /hot|trend/iu;
  if (state === "RECOMMENDED") return /recommend|related|note[_-]?list/iu;
  if (state === "HOME_FEED") return /home[_-]?feed|feed[_-]?list|note[_-]?list/iu;
  return /$a/;
}

function currentScrollableContainer(snapshot) {
  if (!LIST_STATES.has(snapshot.classification.state)) return null;
  const pattern = containerPattern(snapshot.classification.state);
  return snapshot.document.nodes
    .filter((node) => node.scrollable && pattern.test(node.resourceId) && parseBounds(node.attributes.bounds))
    .map((node) => ({ node, bounds: parseBounds(node.attributes.bounds) }))
    .sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height)[0] ?? null;
}

function noteContentContainer(snapshot) {
  if (snapshot.classification.state !== "IMAGE_NOTE") return null;
  return snapshot.document.nodes
    .filter((node) => node.scrollable && /note[_-]?content|content[_-]?scroll|detail[_-]?scroll|article[_-]?content/iu.test(node.resourceId) && parseBounds(node.attributes.bounds))
    .map((node) => ({ node, bounds: parseBounds(node.attributes.bounds) }))
    .sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height)[0] ?? null;
}

function deidentifyComment(value) {
  return compact(value)
    .replace(/@[\p{L}\p{N}_.-]+/gu, "@用户")
    .replace(/(?:\+?86[-\s]?)?1[3-9]\d{9}/g, "[手机号已脱敏]")
    .replace(/https?:\/\/\S+/giu, "[链接已脱敏]")
    .replace(/\b\d{6,}\b/g, "[数字已脱敏]")
    .slice(0, 240);
}

function detailMetadata(snapshot) {
  const nodes = snapshot.document.nodes;
  const countNode = nodes.find((node) => /comment[_-]?(?:count|entry)|comment_count/iu.test(node.resourceId));
  const countSource = compact(countNode?.text || countNode?.contentDesc);
  const parsedCount = /(?:共\s*)?(\d+)\s*(?:条)?评论/iu.exec(countSource)?.[1];
  const count = parsedCount ?? (/^\d+$/.test(countSource) ? countSource : null);
  return {
    title: firstText(nodes, /note[_-]?title|title_text/iu),
    author: firstText(nodes, /author|nickname|user[_-]?name/iu),
    count,
  };
}

function commentSnippets(snapshot, maximum) {
  const output = [];
  const seen = new Set();
  for (const node of snapshot.document.nodes) {
    if (!/comment[_-]?(?:content|text|body)/iu.test(node.resourceId) || /input|editor/iu.test(node.resourceId)) continue;
    const value = deidentifyComment(node.text || node.contentDesc);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= maximum) break;
  }
  return output;
}

function hasForbiddenCoordinate(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenCoordinate);
  return Object.entries(value).some(([key, child]) => /^(?:x|y|bounds?|coordinates?|point|tap)$/iu.test(key) || hasForbiddenCoordinate(child));
}

function semanticTargetFromDescription(value) {
  const normalized = compact(value).toLocaleLowerCase();
  return PAGE_TARGET_ALIASES.get(normalized) ?? null;
}

function forbiddenRequest(task, unit) {
  const inspect = (object) => {
    if (!object || typeof object !== "object") return false;
    for (const [key, value] of Object.entries(object)) {
      if (/^(?:actions?|interactionAction|suggestedAction|semanticTarget)$/iu.test(key)) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some((entry) => FORBIDDEN_INTERACTION.test(String(entry)))) return true;
      }
      if (FORBIDDEN_INTERACTION.test(key) && value !== false && value !== null && value !== undefined) return true;
      if (value && typeof value === "object" && inspect(value)) return true;
    }
    return false;
  };
  return inspect(task) || inspect(unit);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function visibleTexts(snapshot) {
  return [...new Set(snapshot.document.nodes.flatMap((node) => [compact(node.text), compact(node.contentDesc)]).filter(Boolean))].slice(0, 40);
}

export function createAdbResearchProvider(options = {}) {
  const adbPath = options.adbPath ?? "adb";
  const packageName = options.packageName ?? DEFAULT_PACKAGE;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const stablePollMs = clampInteger(options.stablePollMs, 500, 100, 2_000);
  const stableTimeoutMs = clampInteger(options.stableTimeoutMs, 8_000, stablePollMs, 30_000);
  const pageRecovery = typeof options.pageRecovery === "function" ? options.pageRecovery : null;
  const localOcr = typeof options.localOcr === "function" ? options.localOcr : null;
  const unicodeInput = options.unicodeInput ?? {};
  const nativeIme = options.nativeIme ?? {};
  const xiaoweiTextInput = typeof options.xiaoweiTextInput === "function" ? options.xiaoweiTextInput : null;
  const xiaoweiTextApprovedAliases = new Set(options.xiaoweiTextApprovedAliases ?? []);
  const onResourceUsage = typeof options.onResourceUsage === "function" ? options.onResourceUsage : null;
  const records = (options.devices ?? []).map((device, index) => {
    if (!device || typeof device.alias !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(device.alias.trim()) || typeof device.serial !== "string" || !device.serial.trim()) {
      throw new TypeError(`devices[${index}] must contain non-empty alias and serial strings`);
    }
    return {
      alias: device.alias.trim(),
      serial: device.serial,
      groups: [...new Set([...(Array.isArray(device.groups) ? device.groups : []), ...(device.group ? [device.group] : [])].map(String))],
      context: { ...(device.context ?? {}) },
    };
  });
  if (new Set(records.map((record) => record.alias)).size !== records.length) throw new TypeError("device aliases must be unique");
  const recordByAlias = new Map(records.map((record) => [record.alias, record]));
  const contextCache = new Map();
  const calibratedNativeIme = new Map();
  const commentPanelsByTask = new Map();
  for (const [taskId, count] of Object.entries(options.initialCommentPanelsByTask ?? {})) {
    const normalizedTaskId = compact(taskId);
    const used = clampInteger(count, 0, 0, 15);
    if (normalizedTaskId && used > 0) commentPanelsByTask.set(`id:${normalizedTaskId}`, used);
  }
  const anonymousTaskKeys = new WeakMap();
  let anonymousTaskOrdinal = 0;
  const rulesPromise = options.rules ? Promise.resolve(options.rules) : loadRules(options.rulesPath ?? DEFAULT_RULES_PATH);

  function taskCounterKey(task) {
    if (typeof task?.taskId === "string" && task.taskId) return `id:${task.taskId}`;
    if (task && typeof task === "object") {
      if (!anonymousTaskKeys.has(task)) anonymousTaskKeys.set(task, `anonymous:${++anonymousTaskOrdinal}`);
      return anonymousTaskKeys.get(task);
    }
    return "anonymous:none";
  }

  async function reserveCommentPanel(session, maximum) {
    const key = session.taskCounterKey;
    const used = commentPanelsByTask.get(key) ?? 0;
    if (used >= maximum) return false;
    commentPanelsByTask.set(key, used + 1);
    if (onResourceUsage) {
      try {
        await onResourceUsage({ taskId: session.task?.taskId ?? null, commentPanelsUsed: used + 1 });
      } catch (error) {
        commentPanelsByTask.set(key, used);
        throw error;
      }
    }
    return true;
  }

  function recordFor({ device, deviceAlias } = {}) {
    const alias = compact(deviceAlias || (typeof device === "string" ? device : device?.alias));
    const record = recordByAlias.get(alias);
    if (!record) throw new ProviderStop("failed", "device:unknown_alias", "Unknown configured device alias");
    return record;
  }

  async function runAdb(record, args, operation, runOptions = {}) {
    let raw;
    try {
      raw = await commandRunner({
        file: adbPath,
        args: ["-s", record.serial, ...args],
        timeoutMs: runOptions.timeoutMs ?? 15_000,
        encoding: runOptions.encoding === null ? null : "utf8",
        operation,
        deviceAlias: record.alias,
      });
    } catch {
      throw new ProviderStop("failed", `adb:${operation}:runner_error`, `ADB ${operation} failed`);
    }
    const result = normalizeRunnerResult(raw, runOptions.encoding !== null);
    if (result.exitCode !== 0 && !runOptions.allowFailure) {
      throw new ProviderStop("failed", `adb:${operation}:exit_${result.exitCode}`, `ADB ${operation} failed`);
    }
    return result;
  }

  async function online(record) {
    try {
      const result = await runAdb(record, ["get-state"], "get_state", { allowFailure: true, timeoutMs: 5_000 });
      return result.exitCode === 0 && text(result.stdout).trim() === "device";
    } catch {
      return false;
    }
  }

  async function deviceContext(record) {
    if (contextCache.has(record.alias)) return contextCache.get(record.alias);
    const optional = async (args, operation) => {
      try {
        const result = await runAdb(record, args, operation, { allowFailure: true, timeoutMs: 8_000 });
        return result.exitCode === 0 ? text(result.stdout) : "";
      } catch { return ""; }
    };
    const [sdk, packageDump, size, density] = await Promise.all([
      optional(["shell", "getprop", "ro.build.version.sdk"], "android_sdk"),
      optional(["shell", "dumpsys", "package", packageName], "package_info"),
      optional(["shell", "wm", "size"], "screen_size"),
      optional(["shell", "wm", "density"], "screen_density"),
    ]);
    const context = {
      androidSdk: sdk.trim(),
      xhsVersion: /versionName=([^\s]+)/.exec(packageDump)?.[1] ?? "",
      resolution: /Override size:\s*(\d+x\d+)/iu.exec(size)?.[1] ?? /Physical size:\s*(\d+x\d+)/iu.exec(size)?.[1] ?? "",
      dpi: /Override density:\s*(\d+)/iu.exec(density)?.[1] ?? /Physical density:\s*(\d+)/iu.exec(density)?.[1] ?? "",
      deviceAlias: record.alias,
      ...record.context,
    };
    contextCache.set(record.alias, context);
    return context;
  }

  async function dumpXml(record) {
    let result = await runAdb(record, ["exec-out", "uiautomator", "dump", "/dev/tty"], "ui_dump", { allowFailure: true, timeoutMs: 15_000 });
    let output = text(result.stdout);
    let start = output.indexOf("<?xml");
    if (start < 0) start = output.indexOf("<hierarchy");
    let end = output.lastIndexOf("</hierarchy>");
    if (result.exitCode !== 0 || start < 0 || end < start) {
      await runAdb(record, ["shell", "uiautomator", "dump", "/sdcard/xhs-window.xml"], "ui_dump_file", { timeoutMs: 15_000 });
      result = await runAdb(record, ["exec-out", "cat", "/sdcard/xhs-window.xml"], "ui_dump_read", { timeoutMs: 10_000 });
      output = text(result.stdout);
      start = output.indexOf("<?xml");
      if (start < 0) start = output.indexOf("<hierarchy");
      end = output.lastIndexOf("</hierarchy>");
    }
    if (start < 0 || end < start) throw new ProviderStop("failed", "ui:invalid_dump", "UI hierarchy could not be read");
    return output.slice(start, end + "</hierarchy>".length);
  }

  async function captureFailureArtifacts(record, task, unit, signature) {
    if (!options.failureArtifactsRoot) return null;
    const directory = join(options.failureArtifactsRoot, record.alias);
    const stem = hash(`${task?.taskId ?? "task"}\u0000${unit?.unitId ?? unit?.source ?? "unit"}\u0000${signature}`).slice(0, 20);
    await mkdir(directory, { recursive: true });
    const output = {};
    try {
      const xml = await dumpXml(record);
      output.hierarchyPath = join(directory, `${stem}.xml`);
      await writeFile(output.hierarchyPath, xml, "utf8");
    } catch { /* ADB failure may prevent hierarchy capture. */ }
    try {
      const capture = await runAdb(record, ["exec-out", "screencap", "-p"], "failure_screenshot", { allowFailure: true, encoding: null, timeoutMs: 15_000 });
      if (capture.exitCode === 0 && Buffer.isBuffer(capture.stdout) && capture.stdout.length > 8) {
        output.screenshotPath = join(directory, `${stem}.png`);
        await writeFile(output.screenshotPath, capture.stdout);
      }
    } catch { /* ADB failure may prevent screenshot capture. */ }
    return Object.keys(output).length ? output : null;
  }

  function assertSafe(classification) {
    if (!classification.safety.requiresHuman && !classification.safety.sensitive) return;
    const reasons = classification.safety.reasons.length ? classification.safety.reasons.join("+") : classification.state;
    throw new ProviderStop("human_required", `safety:${reasons}`, "Sensitive or challenge screen requires a human", {
      stopAll: true,
      humanReview: [{ reason: `Safety stop: ${reasons}` }],
    });
  }

  async function snapshot(session) {
    const xml = await dumpXml(session.record);
    const document = parseUiAutomatorXml(xml);
    const classification = classifyPage(document, session.rules, session.context);
    assertSafe(classification);
    return { xml, document, classification };
  }

  async function stableSnapshot(session) {
    let previous = null;
    for (let elapsed = 0; elapsed <= stableTimeoutMs; elapsed += stablePollMs) {
      const current = await snapshot(session);
      if (previous && previous.classification.fingerprint.hash === current.classification.fingerprint.hash) return current;
      previous = current;
      if (elapsed + stablePollMs <= stableTimeoutMs) await sleep(stablePollMs);
    }
    throw new ProviderStop("failed", "ui:unstable_timeout", "UI did not reach two matching fingerprints within the stability timeout");
  }

  async function tapCurrentNode(session, current, node, key, operation, allowEditText = false) {
    const bounds = parseBounds(node?.attributes?.bounds);
    if (!node || !bounds || node.enabled === false) throw new ProviderStop("partial", `selector:${key}:invalid_bounds`, `Semantic target ${key} has no current enabled bounds`);
    if (!allowEditText && (/(?:^|\.)EditText$/u.test(node.className) || /input|editor/iu.test(node.resourceId))) {
      throw new ProviderStop("human_required", `safety:${key}:input_target`, `Semantic target ${key} unexpectedly resolved to an input control`, {
        humanReview: [{ reason: `${key} resolved to an input control; no tap was performed` }],
      });
    }
    const tapKey = `${current.classification.fingerprint.hash}:${key}:${node.nodeIndex}`;
    if (session.taps.has(tapKey)) throw new ProviderStop("partial", `selector:${key}:at_most_once`, `Semantic target ${key} was already tapped on this page`);
    session.taps.add(tapKey);
    const x = Math.floor((bounds.left + bounds.right) / 2);
    const y = Math.floor((bounds.top + bounds.bottom) / 2);
    await runAdb(session.record, ["shell", "input", "tap", String(x), String(y)], operation);
  }

  async function tapSemantic(session, current, target) {
    const resolved = resolveSemanticTarget(current.document, session.rules, target, session.context);
    if (!resolved.found) throw new ProviderStop("partial", `selector:${target}:missing`, `Semantic target ${target} is unavailable`);
    const node = nodeAtPath(current.document, resolved.node.path);
    await tapCurrentNode(session, current, node, target, `tap_${target}`, target === "search_entry");
  }

  async function recoveryArtifacts(session, current) {
    const directory = await mkdtemp(join(tmpdir(), "xhs-page-recovery-"));
    const xmlPath = join(directory, "hierarchy.xml");
    const imagePath = join(directory, "screen.png");
    await writeFile(xmlPath, current.xml, "utf8");
    let hasImage = false;
    let imageHash = null;
    try {
      const capture = await runAdb(session.record, ["exec-out", "screencap", "-p"], "screenshot", { allowFailure: true, encoding: null, timeoutMs: 15_000 });
      if (capture.exitCode === 0 && Buffer.isBuffer(capture.stdout) && capture.stdout.length > 8) {
        await writeFile(imagePath, capture.stdout);
        hasImage = true;
        imageHash = hashBytes(capture.stdout);
      }
    } catch { /* XML-only recovery remains available. */ }
    return { directory, xmlPath, imagePath: hasImage ? imagePath : null, imageHash };
  }

  async function recoverUnknown(session, current, allowedTargets) {
    if (current.classification.state !== "UNKNOWN") return { current, recoveredTarget: null };
    const tryResolve = async (recovery) => {
      if (!recovery || typeof recovery !== "object" || hasForbiddenCoordinate(recovery)) return null;
      if (!KNOWN_STATES.has(recovery.pageType) || Number(recovery.confidence) < 0.9) return null;
      const recoveredTarget = semanticTargetFromDescription(recovery.targetDescription);
      if (!recoveredTarget || !allowedTargets.includes(recoveredTarget)) return null;
      const refreshed = await stableSnapshot(session);
      if (refreshed.classification.state !== "UNKNOWN" && refreshed.classification.state !== recovery.pageType) return null;
      const resolved = resolveSemanticTarget(refreshed.document, session.rules, recoveredTarget, session.context);
      if (!resolved.found) return null;
      return { current: refreshed, recoveredTarget };
    };

    let pageRecoveryArtifacts = null;
    let safeLocalOcrChecks = 0;
    if (localOcr) {
      const localArtifacts = await recoveryArtifacts(session, current);
      let retainForPageRecovery = false;
      try {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const localResult = await localOcr({
              deviceAlias: session.record.alias,
              xmlPath: localArtifacts.xmlPath,
              imagePath: localArtifacts.imagePath,
              imageHash: localArtifacts.imageHash,
              attempt,
              visibleTexts: visibleTexts(current),
            });
            if (localResult?.humanRequired === true || localResult?.suggestedAction === "STOP_FOR_HUMAN" || localResult?.pageType === "LOGIN_OR_CHALLENGE") {
              throw new ProviderStop("human_required", "safety:local_ocr_sensitive", "Local OCR detected a sensitive page", {
                stopAll: true,
                humanReview: [{ reason: "Local OCR detected login, verification, permission, order, privacy, payment, messaging, contacts, or another sensitive screen" }],
              });
            }
            if (localResult?.ocrAvailable === true && localResult?.safeForCloud === true) safeLocalOcrChecks += 1;
            const resolved = await tryResolve(localResult);
            if (resolved) return resolved;
          } catch (error) {
            if (error instanceof ProviderStop) throw error;
            /* Both deterministic local OCR passes must succeed on this exact file. */
          }
        }
        if (safeLocalOcrChecks === 2 && localArtifacts.imagePath && localArtifacts.imageHash) {
          pageRecoveryArtifacts = localArtifacts;
          retainForPageRecovery = true;
        }
      } finally {
        if (!retainForPageRecovery) await rm(localArtifacts.directory, { recursive: true, force: true });
      }
    }

    if (!pageRecovery || session.task?.aiPolicy?.pageFallback === false || session.recoveryCalls >= 1) {
      if (pageRecoveryArtifacts) await rm(pageRecoveryArtifacts.directory, { recursive: true, force: true });
      throw new ProviderStop("human_required", "page:unknown", "Unknown page requires a human", { humanReview: [{ reason: "Unknown page after two local fingerprint reads and available local OCR" }] });
    }
    if (safeLocalOcrChecks !== 2 || !pageRecoveryArtifacts?.imagePath || !pageRecoveryArtifacts.imageHash) {
      if (pageRecoveryArtifacts) await rm(pageRecoveryArtifacts.directory, { recursive: true, force: true });
      throw new ProviderStop("human_required", "page:privacy_check_unavailable", "Cloud page recovery is blocked because two local OCR privacy checks did not pass", {
        stopAll: true,
        humanReview: [{ reason: "Two successful local OCR privacy checks are required before any screenshot can be uploaded" }],
      });
    }
    if (current.classification.safety.blockCloudUpload) {
      await rm(pageRecoveryArtifacts.directory, { recursive: true, force: true });
      throw new ProviderStop("human_required", "page:unknown_sensitive", "Unknown sensitive page cannot be sent to page recovery", { stopAll: true, humanReview: [{ reason: "Sensitive unknown page" }] });
    }
    session.recoveryCalls += 1;
    const artifacts = pageRecoveryArtifacts;
    let recovery;
    try {
      recovery = await pageRecovery({
        deviceAlias: session.record.alias,
        xmlPath: artifacts.xmlPath,
        imagePath: artifacts.imagePath,
        classification: current.classification,
        visibleTexts: visibleTexts(current),
        privacyAttestation: {
          schemaVersion: 1,
          method: "windows_local_ocr",
          checks: safeLocalOcrChecks,
          safeForCloud: true,
          screenshotSha256: artifacts.imageHash,
        },
      });
    } finally {
      await rm(artifacts.directory, { recursive: true, force: true });
    }
    if (!recovery || typeof recovery !== "object" || hasForbiddenCoordinate(recovery)) {
      throw new ProviderStop("human_required", "page:recovery_invalid", "Page recovery returned coordinates or an invalid result", { humanReview: [{ reason: "Invalid page recovery result" }] });
    }
    if (recovery.humanRequired === true || recovery.suggestedAction === "STOP_FOR_HUMAN") {
      throw new ProviderStop("human_required", "page:recovery_requested_human", "Page recovery explicitly requested a human", { humanReview: [{ reason: "Page recovery requested human review" }] });
    }
    if (!KNOWN_STATES.has(recovery.pageType) || Number(recovery.confidence) < 0.9) {
      throw new ProviderStop("human_required", "page:recovery_low_confidence", "Page recovery confidence is insufficient", { humanReview: [{ reason: "Low-confidence page recovery" }] });
    }
    const resolvedRecovery = await tryResolve(recovery);
    if (!resolvedRecovery) {
      throw new ProviderStop("human_required", "page:recovery_unmapped_target", "Page recovery target is not an allowed semantic target", { humanReview: [{ reason: "Unmapped recovery target" }] });
    }
    return resolvedRecovery;
  }

  async function settleBlocking(session, current) {
    if (current.classification.state === "NETWORK_ERROR") {
      await tapSemantic(session, current, "retry");
      return stableSnapshot(session);
    }
    if (current.classification.state === "UPDATE_MODAL") {
      await tapSemantic(session, current, "dismiss_update");
      return stableSnapshot(session);
    }
    return current;
  }

  async function launch(session) {
    await runAdb(session.record, ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], "launch_xhs", { timeoutMs: 20_000 });
    return settleBlocking(session, await stableSnapshot(session));
  }

  async function goHome(session, current) {
    if (current.classification.state === "HOME_FEED") return current;
    if (current.classification.state === "UNKNOWN") {
      const recovered = await recoverUnknown(session, current, ["home_tab"]);
      current = recovered.current;
      await tapSemantic(session, current, recovered.recoveredTarget);
      const next = await stableSnapshot(session);
      if (next.classification.state === "HOME_FEED") return next;
    }
    const home = resolveSemanticTarget(current.document, session.rules, "home_tab", session.context);
    if (home.found) {
      await tapSemantic(session, current, "home_tab");
      const next = await stableSnapshot(session);
      if (next.classification.state === "HOME_FEED") return next;
      current = next;
    }
    for (let failure = 0; failure < 2; failure += 1) {
      await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_BACK"], "navigate_back");
      current = await stableSnapshot(session);
      if (current.classification.state === "HOME_FEED") return current;
    }
    throw new ProviderStop("partial", `navigation:home:${current.classification.state}`, "Home navigation failed twice");
  }

  function focusedEditText(current) {
    return current.document.nodes.find((node) => /(?:^|\.)EditText$/u.test(node.className) && node.focused);
  }

  function normalizedSearchEcho(nodeText) {
    const text = String(nodeText ?? "").trim();
    // Some current XHS builds expose the localized search hint together with
    // the entered value in EditText.text (for example, "搜索, sneakers").
    // Strip only that known hint prefix; never accept an arbitrary suffix.
    const hintPrefix = /^(?:搜索|search)[\s,，:：]+/iu;
    return hintPrefix.test(text) ? text.replace(hintPrefix, "") : text;
  }

  function searchEchoMatches(nodeText, requestedValue) {
    return normalizedSearchEcho(nodeText) === String(requestedValue ?? "").trim();
  }

  function searchResultEchoMatches(current, requestedValue) {
    if (current.classification.state !== "SEARCH_RESULTS") return false;
    const value = compact(requestedValue);
    if (!value) return false;
    const hasQuery = current.document.nodes.some((node) =>
      node.clickable && String(node.className).endsWith(".TextView") && compact(node.text) === value,
    );
    const hasSearchAction = current.document.nodes.some((node) => node.clickable && compact(node.text) === "搜索");
    const tabs = new Set(["全部", "综合", "最新", "用户", "商品"]);
    const tabCount = new Set(current.document.nodes.filter((node) => tabs.has(compact(node.text))).map((node) => compact(node.text))).size;
    return hasQuery && hasSearchAction && tabCount >= 2;
  }

  async function clearSearchField(session, current, value) {
    const existingText = String(focusedEditText(current)?.text ?? "");
    const deleteCount = Math.min(128, Math.max(16, existingText.length + String(value ?? "").length + 4));
    await runAdb(
      session.record,
      ["shell", "input", "keycombination", "KEYCODE_CTRL_LEFT", "KEYCODE_A"],
      "select_all_search",
    );
    await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_DEL"], "delete_selected_search");
    await runAdb(
      session.record,
      ["shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(deleteCount).fill("KEYCODE_DEL")],
      "clear_search",
    );
  }

  function searchFieldIsEmpty(nodeText) {
    const value = compact(nodeText);
    return value === "" || value === "搜索" || value.toLowerCase() === "search";
  }

  async function clearAndVerifySearchField(session, current, value) {
    await clearSearchField(session, current, value);
    const cleared = await stableSnapshot(session);
    const field = focusedEditText(cleared);
    if (!field || !searchFieldIsEmpty(field.text)) {
      throw nativeImeStop("input:native_ime_clear_failed", "Existing search text could not be cleared before native input");
    }
    return cleared;
  }

  async function inputAsciiBySegments(session, value) {
    const segments = String(value).split(" ");
    for (let index = 0; index < segments.length; index += 1) {
      if (index > 0) await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_SPACE"], "input_ascii_space");
      if (segments[index]) {
        await runAdb(session.record, ["shell", "input", "text", shellQuote(segments[index])], "input_ascii_segment");
      }
    }
  }

  function nativeImeApproved(alias) {
    return Boolean(
      nativeIme.enabled === true &&
      nativeIme.humanApproved === true &&
      Array.isArray(nativeIme.approvedAliases) && nativeIme.approvedAliases.includes(alias),
    );
  }

  function nativeImeProfile(alias) {
    return nativeIme.perDevice && typeof nativeIme.perDevice === "object" ? nativeIme.perDevice[alias] : null;
  }

  function nativeImePreferences(alias) {
    const perDevice = nativeImeProfile(alias);
    const preferred = [
      perDevice?.preferredService,
      ...(Array.isArray(perDevice?.preferredServices) ? perDevice.preferredServices : []),
      ...(Array.isArray(nativeIme.preferredServices) ? nativeIme.preferredServices : []),
    ].filter((service) => typeof service === "string" && SAFE_IME_SERVICE.test(service) && !BRIDGE_IME_SERVICE.test(service));
    return [...new Set(preferred)];
  }

  function verifiedFirstCandidateApproved(alias) {
    return nativeImeProfile(alias)?.allowVerifiedFirstCandidate === true;
  }

  function calibratedChineseModeToggle(alias, service) {
    const toggle = nativeImeProfile(alias)?.chineseModeToggle;
    if (!toggle || toggle.humanApproved !== true || toggle.imeService !== service) return null;
    return toggle;
  }

  function nativeImeHasChineseSubtype(service, dumpsys) {
    const known = NATIVE_IME_SUBTYPE_EVIDENCE.find(([servicePattern]) => servicePattern.test(service));
    return Boolean(known && known[1].test(dumpsys));
  }

  function nativeImeStop(signature, reason) {
    return new ProviderStop("human_required", signature, reason, {
      humanReview: [{ reason }],
      affectsDeviceHealth: false,
    });
  }

  async function restoreNativeIme(session, previousDefault) {
    if (!previousDefault || !SAFE_IME_SERVICE.test(previousDefault)) {
      throw nativeImeStop("input:native_ime_restore_invalid", "Previous default input method could not be safely restored");
    }
    await runAdb(session.record, ["shell", "ime", "set", previousDefault], "native_ime_restore");
    const restored = await runAdb(session.record, ["shell", "settings", "get", "secure", "default_input_method"], "native_ime_restore_verify");
    if (text(restored.stdout).trim() !== previousDefault) {
      throw nativeImeStop("input:native_ime_restore_failed", "Previous default input method was not restored");
    }
  }

  async function activateNativeIme(session) {
    const [defaultResult, enabledResult, dumpResult] = await Promise.all([
      runAdb(session.record, ["shell", "settings", "get", "secure", "default_input_method"], "native_ime_default"),
      runAdb(session.record, ["shell", "ime", "list", "-s"], "native_ime_inventory"),
      runAdb(session.record, ["shell", "dumpsys", "input_method"], "native_ime_subtypes"),
    ]);
    const previousDefault = text(defaultResult.stdout).trim();
    const enabled = new Set(text(enabledResult.stdout).split(/\r?\n/u).map((value) => value.trim()).filter(Boolean));
    const dumpsys = text(dumpResult.stdout);
    const service = nativeImePreferences(session.record.alias).find((candidate) =>
      enabled.has(candidate) && nativeImeHasChineseSubtype(candidate, dumpsys),
    );
    if (!service) {
      throw nativeImeStop("input:native_ime_unavailable", "No approved native input method with a Chinese subtype is available on this device");
    }
    if (service === previousDefault) return { previousDefault, service };
    try {
      await runAdb(session.record, ["shell", "ime", "set", service], "native_ime_select");
      const selected = await runAdb(session.record, ["shell", "settings", "get", "secure", "default_input_method"], "native_ime_select_verify");
      if (text(selected.stdout).trim() !== service) {
        throw nativeImeStop("input:native_ime_select_failed", "Approved native input method could not be selected");
      }
      return { previousDefault, service };
    } catch (error) {
      if (SAFE_IME_SERVICE.test(previousDefault)) {
        try { await restoreNativeIme(session, previousDefault); } catch { /* Preserve the original selection failure. */ }
      }
      throw error;
    }
  }

  function exactImeNode(current, expected, imePackage) {
    const candidates = current.document.nodes.filter((node) =>
      node.enabled !== false &&
      node.packageName === imePackage &&
      !/(?:^|\.)EditText$/u.test(node.className) &&
      (compact(node.text) === expected || compact(node.contentDesc) === expected) &&
      parseBounds(node.attributes?.bounds),
    );
    return candidates.find((node) => node.clickable) ?? candidates[0] ?? null;
  }

  function chineseModeToggle(current, imePackage) {
    const exact = new Set(["中/英", "中英", "中文", "切换到中文"]);
    return current.document.nodes.find((node) =>
      node.enabled !== false &&
      node.packageName === imePackage &&
      !/(?:^|\.)EditText$/u.test(node.className) &&
      (exact.has(compact(node.text)) || exact.has(compact(node.contentDesc))) &&
      parseBounds(node.attributes?.bounds),
    ) ?? null;
  }

  function lastIntegerMatch(value, pattern) {
    const matches = [...String(value ?? "").matchAll(pattern)];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  }

  async function tapCalibratedChineseModeToggle(session, current, service) {
    const toggle = calibratedChineseModeToggle(session.record.alias, service);
    if (!toggle || !focusedEditText(current) || !new Set(["SEARCH_ENTRY", "SEARCH_SUGGESTIONS"]).has(current.classification.state)) {
      return false;
    }
    const [sizeResult, densityResult, defaultResult, inputMethodResult] = await Promise.all([
      runAdb(session.record, ["shell", "wm", "size"], "native_ime_toggle_size"),
      runAdb(session.record, ["shell", "wm", "density"], "native_ime_toggle_density"),
      runAdb(session.record, ["shell", "settings", "get", "secure", "default_input_method"], "native_ime_toggle_default"),
      runAdb(session.record, ["shell", "dumpsys", "input_method"], "native_ime_toggle_visibility"),
    ]);
    const sizeMatches = [...text(sizeResult.stdout).matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/giu)];
    const size = sizeMatches.at(-1);
    const density = lastIntegerMatch(text(densityResult.stdout), /(?:Physical|Override) density:\s*(\d+)/giu);
    const visible = /(?:mInputShown|mIsInputViewShown)=true\b/u.test(text(inputMethodResult.stdout));
    if (!size || Number(size[1]) !== toggle.displayWidth || Number(size[2]) !== toggle.displayHeight ||
        density !== toggle.densityDpi || text(defaultResult.stdout).trim() !== service || !visible) {
      throw nativeImeStop("input:native_ime_toggle_profile_mismatch", "Per-device Chinese-mode calibration no longer matches the active keyboard or display");
    }
    await runAdb(session.record, ["shell", "input", "tap", String(toggle.x), String(toggle.y)], "native_ime_chinese_mode_coordinate");
    return true;
  }

  async function enterNativePhrase(session, current, expected, romanized, allowModeToggle, service) {
    const safeRomanized = compact(romanized).replace(/\s+/gu, "");
    const imePackage = String(service).split("/")[0];
    if (!safeRomanized || !/^[a-z]+$/u.test(safeRomanized)) {
      throw nativeImeStop("input:native_ime_invalid_pinyin", "Native input transliteration is unavailable for this phrase");
    }
    const tryCandidate = async () => {
      const keyCodes = [...safeRomanized].map((letter) => `KEYCODE_${letter.toUpperCase()}`);
      await runAdb(session.record, ["shell", "input", "keyevent", ...keyCodes], "native_ime_pinyin");
      let snapshotAfterPinyin = await stableSnapshot(session);
      if (snapshotAfterPinyin.document.nodes.some((node) => /(?:^|\.)EditText$/u.test(node.className) && searchEchoMatches(node.text, expected))) {
        return snapshotAfterPinyin;
      }
      const candidate = exactImeNode(snapshotAfterPinyin, expected, imePackage);
      if (!candidate) return { current: snapshotAfterPinyin, missing: true };
      await tapCurrentNode(session, snapshotAfterPinyin, candidate, `ime_candidate_${hash(expected).slice(0, 10)}`, "native_ime_candidate");
      snapshotAfterPinyin = await stableSnapshot(session);
      return snapshotAfterPinyin;
    };

    const tryVerifiedFirstCandidate = async (candidateResult) => {
      if (!candidateResult?.missing || !verifiedFirstCandidateApproved(session.record.alias)) return candidateResult;
      await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_SPACE"], "native_ime_first_candidate");
      const committed = await stableSnapshot(session);
      if (committed.document.nodes.some((node) => /(?:^|\.)EditText$/u.test(node.className) && searchEchoMatches(node.text, expected))) {
        return committed;
      }
      if (focusedEditText(committed)) await clearSearchField(session, committed, safeRomanized);
      return { current: await stableSnapshot(session), missing: true };
    };

    let result = await tryVerifiedFirstCandidate(await tryCandidate());
    if (result?.missing && allowModeToggle) {
      await clearSearchField(session, result.current, safeRomanized);
      const cleared = await stableSnapshot(session);
      const toggle = chineseModeToggle(cleared, imePackage);
      if (toggle) {
        await tapCurrentNode(session, cleared, toggle, "ime_chinese_mode", "native_ime_chinese_mode");
      } else if (!(await tapCalibratedChineseModeToggle(session, cleared, service))) {
        throw nativeImeStop("input:native_ime_chinese_mode", "Native input method is not in Chinese mode and no semantic language toggle is available");
      }
      const toggled = await stableSnapshot(session);
      await clearSearchField(session, toggled, safeRomanized);
      result = await tryVerifiedFirstCandidate(await tryCandidate());
    }
    if (result?.missing || !result.document.nodes.some((node) => /(?:^|\.)EditText$/u.test(node.className) && searchEchoMatches(node.text, expected))) {
      throw nativeImeStop("input:native_ime_candidate_missing", "Native input method did not expose the exact requested Chinese candidate");
    }
    if (result.classification.state === "SEARCH_RESULTS") {
      throw nativeImeStop("input:native_ime_unexpected_submission", "Native input calibration unexpectedly left the editable search page");
    }
    return result;
  }

  function phrasePinyin(value) {
    if (!/^[\p{Script=Han}\s]+$/u.test(value)) return "";
    return pinyin(value, { toneType: "none", type: "array" }).join("").replace(/\s+/gu, "").toLowerCase();
  }

  async function enterWithNativeIme(session, current, value) {
    const activation = await activateNativeIme(session);
    try {
      // Switching IMEs can restore the editor's previous composing value on
      // some Xiaomi builds. Clear again after selection and verify the live
      // field before any calibration or requested text is entered.
      current = await clearAndVerifySearchField(session, current, value);
      if (calibratedNativeIme.get(session.record.alias) !== activation.service) {
        const probe = compact(nativeIme.calibrationProbe || "测试");
        const probePinyin = compact(nativeIme.calibrationPinyin || "ceshi");
        current = await enterNativePhrase(session, current, probe, probePinyin, true, activation.service);
        calibratedNativeIme.set(session.record.alias, activation.service);
        current = await clearAndVerifySearchField(session, current, probe);
      }
      current = await enterNativePhrase(session, current, value, phrasePinyin(value), false, activation.service);
    } catch (error) {
      try {
        const cleanup = await stableSnapshot(session);
        if (focusedEditText(cleanup)) await clearSearchField(session, cleanup, value);
      } catch { /* Preserve the original input failure; restoration still runs below. */ }
      throw error;
    } finally {
      await restoreNativeIme(session, activation.previousDefault);
    }
    return stableSnapshot(session);
  }

  async function navigateToSearch(session, current) {
    const searchStates = new Set(["SEARCH_ENTRY", "SEARCH_SUGGESTIONS", "SEARCH_RESULTS"]);
    if (searchStates.has(current.classification.state)) {
      if (focusedEditText(current)) return current;
      await tapSemantic(session, current, "search_entry");
      return stableSnapshot(session);
    }
    if (current.classification.state === "UNKNOWN") {
      const recovered = await recoverUnknown(session, current, ["search_entry"]);
      current = recovered.current;
      await tapSemantic(session, current, recovered.recoveredTarget);
    } else {
      current = await goHome(session, current);
      await tapSemantic(session, current, "search_entry");
    }
    const next = await stableSnapshot(session);
    if (!searchStates.has(next.classification.state)) {
      throw new ProviderStop("partial", `navigation:search:${next.classification.state}`, "Search navigation did not reach a search page");
    }
    return next;
  }

  function unicodeApproved(alias) {
    return Boolean(
      unicodeInput.enabled === true &&
      typeof unicodeInput.action === "string" && /^[A-Za-z0-9._-]+$/.test(unicodeInput.action) &&
      typeof (unicodeInput.extraKey ?? "msg") === "string" && /^[A-Za-z0-9._-]+$/.test(unicodeInput.extraKey ?? "msg") &&
      Array.isArray(unicodeInput.approvedAliases) && unicodeInput.approvedAliases.includes(alias),
    );
  }

  async function enterKeyword(session, current, keyword) {
    const value = String(keyword ?? "");
    if (!value) throw new ProviderStop("failed", "input:empty_keyword", "Search keyword is empty");
    const ascii = /^[\x20-\x7e]+$/.test(value);
    const nativeApproved = !ascii && nativeImeApproved(session.record.alias);
    const xiaoweiApproved = Boolean(xiaoweiTextInput && xiaoweiTextApprovedAliases.has(session.record.alias));
    if (!ascii && !nativeApproved && !xiaoweiApproved && !unicodeApproved(session.record.alias)) {
      throw new ProviderStop("human_required", "input:unicode_requires_human", "Unicode input is not configured and approved", {
        humanReview: [{ reason: "Paste the Unicode topic manually in Xiaowei, then resume" }],
        affectsDeviceHealth: false,
      });
    }
    if (!focusedEditText(current)) {
      await tapSemantic(session, current, "search_entry");
      current = await stableSnapshot(session);
    }
    let next;
    await clearSearchField(session, current, value);
    if (nativeApproved) {
      next = await enterWithNativeIme(session, current, value);
    } else if (ascii) {
      const encoded = value.replace(/ /g, "%s");
      await runAdb(session.record, ["shell", "input", "text", shellQuote(encoded)], "input_ascii");
    } else if (xiaoweiApproved) {
      await xiaoweiTextInput({ deviceAlias: session.record.alias, text: value });
    } else {
      const payload = Buffer.from(value, "utf8").toString("base64");
      await runAdb(session.record, ["shell", "am", "broadcast", "-a", unicodeInput.action, "--es", unicodeInput.extraKey ?? "msg", payload], "input_unicode_b64");
    }
    if (!next) next = await stableSnapshot(session);
    let verified = next.document.nodes.some((node) => /(?:^|\.)EditText$/u.test(node.className) && searchEchoMatches(node.text, value));
    if (!verified && ascii && value.includes(" ")) {
      const observed = next.document.nodes.find((node) => /(?:^|\.)EditText$/u.test(node.className) && node.focused);
      if (normalizedSearchEcho(observed?.text) === value.replace(/ /g, "")) {
        // A few Android builds drop `%s` in `input text`; retry once with
        // explicit SPACE key events inside the already-focused search field.
        await clearSearchField(session, next, value);
        await inputAsciiBySegments(session, value);
        next = await stableSnapshot(session);
        verified = next.document.nodes.some((node) => /(?:^|\.)EditText$/u.test(node.className) && searchEchoMatches(node.text, value));
      }
    }
    if (!verified) {
      throw new ProviderStop("human_required", "input:verification_failed", "Search text did not exactly match the requested keyword", {
        humanReview: [{ reason: "Search input did not exactly match; manual correction required" }],
        affectsDeviceHealth: false,
      });
    }
    return next;
  }

  async function submitSearch(session, current) {
    const submit = resolveSemanticTarget(current.document, session.rules, "search_submit", session.context);
    if (submit.found) await tapSemantic(session, current, "search_submit");
    else {
      if (session.searchSubmitted) throw new ProviderStop("partial", "search:at_most_once", "Search was already submitted once");
      session.searchSubmitted = true;
      await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_ENTER"], "submit_search");
    }
    const next = await stableSnapshot(session);
    if (next.classification.state !== "SEARCH_RESULTS") {
      throw new ProviderStop("partial", `navigation:search_results:${next.classification.state}`, "Search submission did not reach results");
    }
    return next;
  }

  async function routeSource(session, current, source, keyword) {
    if (source === "search" || source === "suggestions") {
      if (source === "search" && searchResultEchoMatches(current, keyword)) return current;
      current = await navigateToSearch(session, current);
      current = await enterKeyword(session, current, keyword);
      return source === "search" ? submitSearch(session, current) : current;
    }
    if (source === "trending") {
      if (current.classification.state === "TRENDING") return current;
      let target = resolveSemanticTarget(current.document, session.rules, "trending_entry", session.context);
      if (!target.found) {
        current = await navigateToSearch(session, current);
        target = resolveSemanticTarget(current.document, session.rules, "trending_entry", session.context);
      }
      if (!target.found) throw new ProviderStop("partial", "source_unavailable:trending", "Trending entry is unavailable");
      await tapSemantic(session, current, "trending_entry");
      const next = await stableSnapshot(session);
      if (next.classification.state !== "TRENDING") throw new ProviderStop("partial", `navigation:trending:${next.classification.state}`, "Trending entry did not reach trending page");
      return next;
    }
    if (source === "recommended") {
      if (current.classification.state !== "HOME_FEED" && current.classification.state !== "RECOMMENDED") current = await goHome(session, current);
      if (current.classification.state === "RECOMMENDED") return current;
      const target = resolveSemanticTarget(current.document, session.rules, "recommendation_entry", session.context);
      if (!target.found) return current; // The home feed itself is the recommendation source.
      await tapSemantic(session, current, "recommendation_entry");
      const next = await stableSnapshot(session);
      if (next.classification.state !== "RECOMMENDED") throw new ProviderStop("partial", `navigation:recommended:${next.classification.state}`, "Recommendation entry did not reach recommendations");
      return next;
    }
    throw new ProviderStop("failed", `source:unsupported:${source}`, "Unsupported research source");
  }

  async function returnToList(session, current, expectedState) {
    await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_BACK"], "return_to_list");
    const next = await stableSnapshot(session);
    if (next.classification.state !== expectedState) {
      throw new ProviderStop("human_required", `detail:return_mismatch:${next.classification.state}`, "Detail sampling did not return to the original list", {
        humanReview: [{ reason: "Could not verify return to the original result list" }],
      });
    }
    return next;
  }

  async function sampleOneDetail(session, listSnapshot, candidate) {
    const expectedListState = listSnapshot.classification.state;
    const review = [];
    const target = resolveSemanticTarget(listSnapshot.document, session.rules, "note_card", session.context);
    if (!target.found) {
      return {
        current: listSnapshot,
        candidate,
        humanReview: [{ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: "No semantic note-card target was available; detail sampling was skipped" }],
        failureSignature: "detail:note_card_missing",
      };
    }

    await tapSemantic(session, listSnapshot, "note_card");
    let current = await stableSnapshot(session);
    if (!new Set(["IMAGE_NOTE", "VIDEO_NOTE"]).has(current.classification.state)) {
      const recoveredList = await returnToList(session, current, expectedListState);
      return {
        current: recoveredList,
        candidate,
        humanReview: [{ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: `Note card opened ${current.classification.state}, not a readable note detail` }],
        failureSignature: `detail:unexpected_state:${current.classification.state}`,
      };
    }

    const metadata = detailMetadata(current);
    const enriched = {
      ...candidate,
      title: metadata.title || candidate.title,
      author: metadata.author || candidate.author,
      mediaType: current.classification.state === "VIDEO_NOTE" ? "video" : "image",
      commentMetadata: { ...(candidate.commentMetadata ?? {}), count: metadata.count, panelOpened: false },
    };

    const maxNoteScrolls = clampInteger(session.task?.budgets?.maxNoteScrolls, 0, 0, 20);
    if (current.classification.state === "IMAGE_NOTE") {
      for (let index = 0; index < maxNoteScrolls; index += 1) {
        const container = noteContentContainer(current);
        if (!container) break;
        const { bounds } = container;
        const x = Math.floor((bounds.left + bounds.right) / 2);
        const startY = Math.floor(bounds.top + bounds.height * 0.75);
        const endY = Math.floor(bounds.top + bounds.height * 0.25);
        await runAdb(session.record, ["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"], "scroll_note_content");
        current = await stableSnapshot(session);
        if (current.classification.state !== "IMAGE_NOTE") {
          throw new ProviderStop("human_required", `detail:image_scroll_state:${current.classification.state}`, "Image-note content scroll left the note detail", {
            humanReview: [{ candidateKey: candidate.candidateId, title: candidate.title, reason: "Image-note scroll left the expected detail page" }],
          });
        }
      }
    }

    const commentMode = session.task?.commentMode ?? "none";
    const maxPanels = clampInteger(session.task?.budgets?.maxCommentPanels, 0, 0, 15);
    const maxComments = clampInteger(session.task?.budgets?.maxCommentsPerNote, 0, 0, 20);
    if (commentMode !== "none" && maxPanels > 0 && (commentPanelsByTask.get(session.taskCounterKey) ?? 0) < maxPanels) {
      const comments = resolveSemanticTarget(current.document, session.rules, "comments_entry", session.context);
      if (!comments.found) {
        review.push({ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: "Comment metadata was requested but no semantic comments entry was available" });
      } else {
        if (!await reserveCommentPanel(session, maxPanels)) {
          current = await returnToList(session, current, expectedListState);
          return { current, candidate: enriched, humanReview: review, failureSignature: null };
        }
        await tapSemantic(session, current, "comments_entry");
        const panel = await stableSnapshot(session);
        if (panel.classification.state !== "COMMENT_PANEL") {
          await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_BACK"], "close_unverified_comments");
          current = await stableSnapshot(session);
          if (!new Set(["IMAGE_NOTE", "VIDEO_NOTE"]).has(current.classification.state)) {
            throw new ProviderStop("human_required", `detail:comment_return:${current.classification.state}`, "Unverified comments view did not return to note detail", {
              humanReview: [{ candidateKey: candidate.candidateId, title: candidate.title, reason: "Could not recover from an unverified comments view" }],
            });
          }
          review.push({ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: `Comments entry opened ${panel.classification.state}, not a comment panel` });
        } else {
          const panelCount = detailMetadata(panel).count;
          enriched.commentMetadata = {
            count: panelCount ?? enriched.commentMetadata.count,
            panelOpened: true,
            ...(commentMode === "deidentified_snippets" ? { snippets: commentSnippets(panel, maxComments) } : {}),
          };
          await runAdb(session.record, ["shell", "input", "keyevent", "KEYCODE_BACK"], "close_comments");
          current = await stableSnapshot(session);
          if (!new Set(["IMAGE_NOTE", "VIDEO_NOTE"]).has(current.classification.state)) {
            throw new ProviderStop("human_required", `detail:comment_return:${current.classification.state}`, "Comments panel did not return to note detail", {
              humanReview: [{ candidateKey: candidate.candidateId, title: candidate.title, reason: "Comments panel did not return to note detail" }],
            });
          }
        }
      }
    }

    current = await returnToList(session, current, expectedListState);
    return {
      current,
      candidate: enriched,
      humanReview: review,
      failureSignature: review.length ? "detail:comments_entry_missing_or_unverified" : null,
    };
  }

  async function collectWithScrolls(session, current, source, keyword) {
    const maximum = clampInteger(session.task?.budgets?.maxNotesPerQuery, 5, 1, 100);
    const maxScrolls = clampInteger(session.task?.budgets?.maxResultScrollsPerQuery, 0, 0, 20);
    const maxNoNew = clampInteger(session.task?.budgets?.maxNoNewScrolls, 2, 1, 10);
    const collected = new Map();
    const humanReview = [];
    let detailFailureSignature = null;
    let noNew = 0;
    const add = (values) => {
      const before = collected.size;
      for (const candidate of values) if (!collected.has(candidate.candidateId) && collected.size < maximum) collected.set(candidate.candidateId, candidate);
      return collected.size - before;
    };
    const initial = extractCandidates(current, source, keyword);
    add(initial);
    const shouldSampleDetail = (source === "search" || source === "recommended") && initial.length > 0 && (
      clampInteger(session.task?.budgets?.maxNoteScrolls, 0, 0, 20) > 0 ||
      ((session.task?.commentMode ?? "none") !== "none" && clampInteger(session.task?.budgets?.maxCommentPanels, 0, 0, 15) > 0)
    );
    if (shouldSampleDetail) {
      const sampled = await sampleOneDetail(session, current, initial[0]);
      current = sampled.current;
      collected.set(sampled.candidate.candidateId, sampled.candidate);
      humanReview.push(...sampled.humanReview);
      detailFailureSignature = sampled.failureSignature;
    }
    for (let index = 0; index < maxScrolls && collected.size < maximum && noNew < maxNoNew; index += 1) {
      if (current.classification.state === "VIDEO_NOTE") break;
      const container = currentScrollableContainer(current);
      if (!container) break;
      const { bounds } = container;
      const x = Math.floor((bounds.left + bounds.right) / 2);
      const startY = Math.floor(bounds.top + bounds.height * 0.75);
      const endY = Math.floor(bounds.top + bounds.height * 0.25);
      await runAdb(session.record, ["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"], "scroll_results");
      current = await stableSnapshot(session);
      if (current.classification.state === "VIDEO_NOTE") {
        throw new ProviderStop("human_required", "navigation:unexpected_video_after_list_scroll", "A list scroll unexpectedly entered a video note", { humanReview: [{ reason: "Unexpected video page after list scroll" }] });
      }
      noNew = add(extractCandidates(current, source, keyword)) ? 0 : noNew + 1;
    }
    return { candidates: [...collected.values()], current, humanReview, detailFailureSignature };
  }

  async function createSession(record, task, unit) {
    if (!await online(record)) {
      const error = new Error("Device is offline before work started");
      error.code = "DEVICE_OFFLINE";
      error.failureSignature = "device:offline";
      error.notStarted = true;
      throw error;
    }
    return {
      record,
      task,
      unit,
      rules: await rulesPromise,
      context: await deviceContext(record),
      taps: new Set(),
      searchSubmitted: false,
      recoveryCalls: 0,
      taskCounterKey: taskCounterKey(task),
    };
  }

  function stopResult(stop, alias, source, keyword, diagnostics = null) {
    return {
      status: stop.status,
      deviceAlias: alias,
      source,
      keyword,
      candidates: [],
      humanReview: stop.humanReview,
      failureSignature: stop.failureSignature,
      ...(diagnostics ? { diagnostics } : {}),
      ...(stop.stopAll ? { stopAll: true } : {}),
      ...(stop.affectsDeviceHealth === false ? { affectsDeviceHealth: false } : {}),
    };
  }

  function selectedRecords(deviceGroup) {
    if (!deviceGroup) return [];
    const configuredGroup = options.deviceGroups?.[deviceGroup];
    const configuredAliases = new Set(Array.isArray(configuredGroup) ? configuredGroup.map(String) : []);
    return records.filter((record) => record.groups.includes(deviceGroup) || configuredAliases.has(record.alias));
  }

  async function handoffToCandidate(record, task, candidate) {
    const query = compact(candidate?.title || candidate?.noteId || candidate?.keyword || task?.topic);
    if (!query || (!compact(candidate?.noteId) && !compact(candidate?.title))) {
      throw new ProviderStop("human_required", "handoff:candidate_identity_missing", "Candidate handoff requires an exact noteId or title", {
        humanReview: [{ candidateKey: candidate?.candidateId, title: compact(candidate?.title), reason: "Candidate has no exact noteId or title for safe handoff" }],
      });
    }
    const session = await createSession(record, task, { source: "search", keyword: query });
    let current = await launch(session);
    current = await navigateToSearch(session, current);
    current = await enterKeyword(session, current, query);
    current = await submitSearch(session, current);

    const maxScrolls = clampInteger(task?.budgets?.maxResultScrollsPerQuery, 4, 0, 20);
    let selected = null;
    let matchedBy = null;
    for (let page = 0; page <= maxScrolls; page += 1) {
      const exact = exactCardMatches(current, candidate);
      if (exact.matches.length > 1) {
        throw new ProviderStop("human_required", `handoff:ambiguous_${exact.matchedBy}`, "More than one exact candidate card matched", {
          humanReview: [{ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: `Multiple cards matched exact ${exact.matchedBy}` }],
        });
      }
      if (exact.matches.length === 1) {
        selected = exact.matches[0];
        matchedBy = exact.matchedBy;
        break;
      }
      if (page === maxScrolls) break;
      const container = currentScrollableContainer(current);
      if (!container || current.classification.state !== "SEARCH_RESULTS") break;
      const { bounds } = container;
      const x = Math.floor((bounds.left + bounds.right) / 2);
      const startY = Math.floor(bounds.top + bounds.height * 0.75);
      const endY = Math.floor(bounds.top + bounds.height * 0.25);
      await runAdb(session.record, ["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"], "handoff_scroll_results");
      current = await stableSnapshot(session);
      if (current.classification.state !== "SEARCH_RESULTS") {
        throw new ProviderStop("human_required", `handoff:results_state:${current.classification.state}`, "Candidate search left results while scanning", {
          humanReview: [{ candidateKey: candidate.candidateId, title: candidate.title, reason: "Candidate search left the results list" }],
        });
      }
    }
    if (!selected) {
      throw new ProviderStop("human_required", "handoff:candidate_missing", "No exact candidate card was found", {
        humanReview: [{ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: "Exact candidate card was not found; no card was opened" }],
      });
    }

    await tapCurrentNode(session, current, selected.root, `exact_candidate:${candidate.candidateId ?? hash(query).slice(0, 12)}`, "tap_exact_candidate");
    const detail = await stableSnapshot(session);
    if (!new Set(["IMAGE_NOTE", "VIDEO_NOTE"]).has(detail.classification.state)) {
      throw new ProviderStop("human_required", `handoff:unexpected_state:${detail.classification.state}`, "Exact card did not open a note detail", {
        humanReview: [{ candidateKey: candidate.candidateId, title: candidate.title, reason: `Exact card opened ${detail.classification.state}` }],
      });
    }
    const metadata = detailMetadata(detail);
    const detailId = publicNoteId(detail.document.nodes);
    const idVerified = Boolean(compact(candidate.noteId) && compact(detailId).toLocaleLowerCase() === compact(candidate.noteId).toLocaleLowerCase());
    const titleVerified = Boolean(compact(candidate.title) && metadata.title === compact(candidate.title));
    if (!idVerified && !titleVerified) {
      throw new ProviderStop("human_required", "handoff:detail_identity_mismatch", "Opened detail could not be verified against the candidate", {
        humanReview: [{ candidateKey: candidate.candidateId, noteId: candidate.noteId, title: candidate.title, reason: "Opened note identity did not match the selected candidate" }],
      });
    }
    return {
      status: "paused",
      deviceAlias: record.alias,
      pageState: detail.classification.state,
      verifiedBy: idVerified ? "noteId" : "title",
      candidate: {
        candidateId: candidate.candidateId ?? null,
        noteId: detailId ?? candidate.noteId ?? null,
        title: metadata.title || compact(candidate.title),
        author: metadata.author || compact(candidate.author),
        mediaType: detail.classification.state === "VIDEO_NOTE" ? "video" : "image",
      },
      pausedForHuman: true,
    };
  }

  const provider = {
    async listDevices({ deviceGroup } = {}) {
      return Promise.all(selectedRecords(deviceGroup).map(async (record) => ({
        alias: record.alias,
        online: await online(record),
        ...(record.groups.length ? { groups: [...record.groups] } : {}),
      })));
    },

    async getDeviceProfiles({ deviceGroup } = {}) {
      return Promise.all(selectedRecords(deviceGroup).map(async (record) => {
        const isOnline = await online(record);
        if (!isOnline) return { alias: record.alias, online: false };
        const context = await deviceContext(record);
        return {
          alias: record.alias,
          online: true,
          xhsVersion: context.xhsVersion,
          androidSdk: context.androidSdk,
          resolution: context.resolution,
          dpi: context.dpi,
        };
      }));
    },

    async isDeviceOnline(input = {}) {
      try { return online(recordFor(input)); } catch { return false; }
    },

    async executeWorkUnit({ task, unit, device, deviceAlias, attempt = 0 } = {}) {
      const record = recordFor({ device, deviceAlias });
      const source = String(unit?.source ?? "");
      const keyword = String(unit?.keyword ?? task?.topic ?? "");
      if (forbiddenRequest(task, unit)) return stopResult(new ProviderStop("failed", "safety:forbidden_interaction", "External interactions are never supported"), record.alias, source, keyword);
      if (!ALLOWED_SOURCES.has(source)) return stopResult(new ProviderStop("failed", `source:unsupported:${source}`, "Unsupported source"), record.alias, source, keyword);
      try {
        const session = await createSession(record, task, unit);
        let current = await launch(session);
        current = await routeSource(session, current, source, keyword);
        const collected = await collectWithScrolls(session, current, source, keyword);
        if (!collected.candidates.length) {
          if (source === "suggestions" || source === "trending") {
            return {
              status: "skipped", deviceAlias: record.alias, source, keyword, attempt,
              candidates: [], humanReview: [], failureSignature: null, sourceSkipped: true, skipReason: `source_empty:${source}`,
            };
          }
          return {
            status: "partial", deviceAlias: record.alias, source, keyword, attempt,
            candidates: [], humanReview: [], failureSignature: `extraction:no_candidates:${source}`,
          };
        }
        return {
          status: collected.humanReview.length ? "partial" : "completed", deviceAlias: record.alias, source, keyword, attempt,
          pageState: collected.current.classification.state,
          candidates: collected.candidates,
          humanReview: collected.humanReview,
          failureSignature: collected.detailFailureSignature,
        };
      } catch (error) {
        if (error?.code === "DEVICE_OFFLINE") throw error;
        const stop = error instanceof ProviderStop
          ? error
          : new ProviderStop("failed", "provider:unexpected", "Unexpected provider failure");
        if (stop.failureSignature.startsWith("source_unavailable:")) {
          return {
            status: "skipped", deviceAlias: record.alias, source, keyword, attempt,
            candidates: [], humanReview: [], failureSignature: null, sourceSkipped: true, skipReason: stop.failureSignature,
          };
        }
        const diagnostics = await captureFailureArtifacts(record, task, unit, stop.failureSignature);
        return stopResult(stop, record.alias, source, keyword, diagnostics);
      }
    },

    async collectTopicSuggestions({ task, device, deviceAlias } = {}) {
      const record = recordFor({ device, deviceAlias });
      const topic = String(task?.topic ?? "");
      try {
        const session = await createSession(record, task, { source: "suggestions", keyword: topic });
        let current = await launch(session);
        current = await navigateToSearch(session, current);
        current = await enterKeyword(session, current, topic);
        return queryCandidates(current, "suggestions", topic).map((candidate) => candidate.query);
      } catch (error) {
        if (error?.code === "DEVICE_OFFLINE") throw error;
        const stop = error instanceof ProviderStop
          ? error
          : new ProviderStop("failed", "provider:unexpected", "Unexpected provider failure");
        if (stop.status === "human_required") {
          return {
            status: "human_required",
            suggestions: [],
            failureSignature: stop.failureSignature,
            humanReview: stop.humanReview,
            affectsDeviceHealth: stop.affectsDeviceHealth,
            stopAll: stop.stopAll,
          };
        }
        throw stop;
      }
    },

    async collectTrendingKeywords({ task, device, deviceAlias } = {}) {
      const record = recordFor({ device, deviceAlias });
      const topic = String(task?.topic ?? "");
      try {
        const session = await createSession(record, task, { source: "trending", keyword: topic });
        let current = await launch(session);
        current = await routeSource(session, current, "trending", topic);
        return queryCandidates(current, "trending", topic).map((candidate) => candidate.query);
      } catch (error) {
        if (error?.code === "DEVICE_OFFLINE") throw error;
        const stop = error instanceof ProviderStop
          ? error
          : new ProviderStop("failed", "provider:unexpected", "Unexpected provider failure");
        if (stop.failureSignature.startsWith("source_unavailable:")) {
          return { status: "skipped", trendingKeywords: [], failureSignature: null };
        }
        if (stop.status === "human_required") {
          return {
            status: "human_required",
            trendingKeywords: [],
            failureSignature: stop.failureSignature,
            humanReview: stop.humanReview,
            affectsDeviceHealth: stop.affectsDeviceHealth,
            stopAll: stop.stopAll,
          };
        }
        throw stop;
      }
    },

    async navigateToCandidate({ task, candidate, device, deviceAlias } = {}) {
      const record = recordFor({ device, deviceAlias });
      if (forbiddenRequest(task, candidate)) {
        return stopResult(new ProviderStop("failed", "safety:forbidden_interaction", "External interactions are never supported"), record.alias, "handoff", compact(candidate?.keyword));
      }
      try {
        return await handoffToCandidate(record, task ?? {}, candidate ?? {});
      } catch (error) {
        if (error?.code === "DEVICE_OFFLINE") throw error;
        const stop = error instanceof ProviderStop
          ? error
          : new ProviderStop("failed", "provider:unexpected", "Unexpected provider failure");
        return stopResult(stop, record.alias, "handoff", compact(candidate?.keyword));
      }
    },
  };
  return provider;
}

let defaultProvider;

/** Configure module-level convenience exports without ever exposing configured serials. */
export function configureAdbResearchProvider(options) {
  defaultProvider = createAdbResearchProvider(options);
  return defaultProvider;
}

function configured() {
  if (!defaultProvider) throw new Error("Call configureAdbResearchProvider(options) before using module-level provider methods");
  return defaultProvider;
}

export async function listDevices(input) { return configured().listDevices(input); }
export async function getDeviceProfiles(input) { return configured().getDeviceProfiles(input); }
export async function isDeviceOnline(input) { return configured().isDeviceOnline(input); }
export async function executeWorkUnit(input) { return configured().executeWorkUnit(input); }
export async function collectTopicSuggestions(input) { return configured().collectTopicSuggestions(input); }
export async function collectTrendingKeywords(input) { return configured().collectTrendingKeywords(input); }
export async function navigateToCandidate(input) { return configured().navigateToCandidate(input); }
