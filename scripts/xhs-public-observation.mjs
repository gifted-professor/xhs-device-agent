import { classifyPage, parseUiAutomatorXml } from "./xhs-page-engine.mjs";
import { extractDetailMetadata } from "./detail-perception.mjs";

const XHS_PACKAGE = "com.xingin.xhs";
const MAX_VISIBLE_LABELS = 40;
const MAX_NOTES = 20;
const PRIVATE_OR_CHROME = /^(?:菜单|关注|发现|推荐|首页|市集|发布|消息(?:[,，].*)?|我|搜索|返回|关闭)$/u;

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function boundedPublicText(value, maximum = 300) {
  const normalized = compact(value);
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) return "";
  return normalized;
}

function descriptorNote(value) {
  const descriptor = boundedPublicText(value, 500);
  const kind = /^(笔记|视频)\s+/u.exec(descriptor);
  if (!kind) return null;
  const body = descriptor.slice(kind[0].length);
  const fromIndex = body.lastIndexOf(" 来自");
  if (fromIndex <= 0) return null;
  const title = boundedPublicText(body.slice(0, fromIndex), 300);
  let authorAndMetric = boundedPublicText(body.slice(fromIndex + 3), 160);
  const likesMatch = /\s+(\d[\d,.]*\s*(?:万|[kKwW])?)赞$/u.exec(authorAndMetric);
  const likes = likesMatch ? likesMatch[1].replace(/\s+/gu, "") : null;
  if (likesMatch) authorAndMetric = authorAndMetric.slice(0, likesMatch.index).trim();
  const author = boundedPublicText(authorAndMetric, 120);
  if (!title || !author) return null;
  return {
    title,
    author,
    mediaType: kind[1] === "视频" ? "video" : "image",
    metrics: { likes },
  };
}

function publicNoteId(node) {
  const source = [node.resourceId, node.text, node.contentDesc, ...Object.values(node.attributes ?? {})].join(" ");
  return /(?:note(?:Id|_id|[-_]id)?[=:/'"\s]+)([0-9a-f]{16,32})/iu.exec(source)?.[1]
    ?? /\b[0-9a-f]{24}\b/iu.exec(source)?.[0]
    ?? null;
}

function extractNotes(document) {
  const output = [];
  const seen = new Set();
  for (const node of document.nodes) {
    const note = descriptorNote(node.contentDesc) ?? descriptorNote(node.text);
    if (!note) continue;
    const key = `${note.mediaType}\u0000${note.author}\u0000${note.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const noteId = publicNoteId(node);
    output.push({
      ...(noteId ? { noteId } : {}),
      title: note.title,
      author: note.author,
      mediaType: note.mediaType,
      metrics: note.metrics,
    });
    if (output.length >= MAX_NOTES) break;
  }
  return output;
}

function nodeBounds(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(String(node?.attributes?.bounds ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right - left < 20 || bottom - top < 20) return null;
  return { left, top, right, bottom };
}

export function resolveVisibleXhsNote(hierarchy, ordinal, displaySize) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > MAX_NOTES) {
    throw new Error("XHS visible note ordinal is invalid");
  }
  const width = Number(displaySize?.width);
  const height = Number(displaySize?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("XHS visible note resolution is invalid");
  }
  const document = parseUiAutomatorXml(hierarchy);
  const candidates = [];
  const seen = new Set();
  for (const node of document.nodes) {
    const note = descriptorNote(node.contentDesc) ?? descriptorNote(node.text);
    const bounds = nodeBounds(node);
    if (!note || !bounds) continue;
    const key = `${note.mediaType}\u0000${note.author}\u0000${note.title}`;
    if (seen.has(key)) throw new Error("XHS visible note identity was duplicated");
    seen.add(key);
    const x = (bounds.left + bounds.right) / 2;
    const y = (bounds.top + bounds.bottom) / 2;
    if (x < 0 || y < 0 || x > width || y > height) continue;
    candidates.push({ note, x, y });
    if (candidates.length >= MAX_NOTES) break;
  }
  const selected = candidates[ordinal - 1];
  if (!selected) throw new Error("XHS visible note ordinal is not present in the fresh UI hierarchy");
  const decimal = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
  return {
    note: selected.note,
    point: {
      x: decimal((selected.x / width) * 100),
      y: decimal((selected.y / height) * 100),
    },
  };
}

function preferredByResourceId(nodes, pattern, maximum = 300) {
  for (const node of nodes) {
    if (!pattern.test(String(node.resourceId ?? ""))) continue;
    const value = boundedPublicText(node.text || node.contentDesc, maximum);
    if (value) return value;
  }
  return "";
}

function metricFromNodes(nodes, patterns) {
  for (const node of nodes) {
    const id = String(node.resourceId ?? "");
    const value = boundedPublicText(node.text || node.contentDesc, 80);
    if (!value) continue;
    if (patterns.some((pattern) => pattern.test(id))) return value;
  }
  return null;
}

function semanticMetric(nodes, label) {
  const pattern = new RegExp(`^${label}\\s+(.{1,40})$`, "u");
  for (const node of nodes) {
    const match = pattern.exec(boundedPublicText(node.contentDesc || node.text, 80));
    if (match) return match[1];
  }
  return null;
}

function detailMedia(nodes) {
  for (const node of nodes) {
    const descriptor = boundedPublicText(node.contentDesc, 160);
    const kind = /^(图片|视频)(?:,|$)/u.exec(descriptor);
    if (!kind) continue;
    const count = Number(/共(\d+)张/u.exec(descriptor)?.[1] ?? 1);
    return {
      value: { type: kind[1] === "视频" ? "video" : "image", count: Number.isSafeInteger(count) && count > 0 ? count : 1 },
      bounds: nodeBounds(node),
    };
  }
  return { value: null, bounds: null };
}

function visibleDetailCopy(nodes, author, mediaBounds) {
  if (!mediaBounds) return { title: "", body: "" };
  const copy = [];
  for (const node of nodes) {
    const value = boundedPublicText(node.text, 500);
    const bounds = nodeBounds(node);
    if (!value || !bounds || bounds.top <= mediaBounds.bottom || value === author) continue;
    if (/^(?:猜你想搜|不喜欢|说点什么\.{0,3}|共\s*\d+\s*条评论|关注|评论框)$/u.test(value)
        || /^\d{2}-\d{2}/u.test(value) || /^(?:点赞|收藏|评论)\s+/u.test(value)) break;
    copy.push(value);
    if (copy.length >= 8) break;
  }
  return { title: copy[0] ?? "", body: copy.slice(1).join(" ") };
}

function publishedAtOrRegion(nodes) {
  for (const node of nodes) {
    const value = boundedPublicText(node.contentDesc || node.text, 80);
    if (/^(?:\d{2}-\d{2}|\d+天前|昨天|今天).{0,60}$/u.test(value)) return value;
  }
  return "";
}

function extractDetail(document, state) {
  if (!["IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL"].includes(state)) return null;
  const metadata = extractDetailMetadata({ document });
  const nodes = document.nodes;
  const title = boundedPublicText(metadata.title, 300)
    || preferredByResourceId(nodes, /note[_-]?title|title_text/iu, 300);
  const author = boundedPublicText(metadata.author, 120)
    || preferredByResourceId(nodes, /author|nickname|user[_-]?name/iu, 120);
  const media = detailMedia(nodes);
  const visibleCopy = visibleDetailCopy(nodes, author, media.bounds);
  const resolvedTitle = title || visibleCopy.title;
  const body = preferredByResourceId(nodes, /note[_-]?(?:desc|content)|content[_-]?text|description/iu, 1_000)
    || visibleCopy.body;
  return {
    title: resolvedTitle,
    author,
    body,
    publishedAtOrRegion: publishedAtOrRegion(nodes),
    media: media.value,
    metrics: {
      likes: semanticMetric(nodes, "点赞") || metricFromNodes(nodes, [/like[_-]?count/iu, /like/iu]),
      favorites: semanticMetric(nodes, "收藏") || metricFromNodes(nodes, [/collect[_-]?count/iu, /favorite/iu]),
      comments: semanticMetric(nodes, "评论") || boundedPublicText(metadata.count, 40)
        || metricFromNodes(nodes, [/comment[_-]?count/iu, /comment/iu]),
    },
  };
}

function extractProfile(document, state) {
  if (state !== "PROFILE") return null;
  const nodes = document.nodes;
  return {
    name: preferredByResourceId(nodes, /profile[_-]?name|nickname|user[_-]?name/iu, 120),
    bio: preferredByResourceId(nodes, /bio|signature|profile[_-]?(?:desc|description)/iu, 500),
    metrics: {
      following: metricFromNodes(nodes, [/following[_-]?count|follow_count/iu]),
      followers: metricFromNodes(nodes, [/followers?[_-]?count|fans[_-]?count/iu]),
      likesAndFavorites: metricFromNodes(nodes, [/liked[_-]?count|likes?[_-]?collect/iu]),
      notes: metricFromNodes(nodes, [/note[_-]?count|posts?[_-]?count/iu]),
    },
  };
}

function visibleLabels(document) {
  const labels = [];
  const seen = new Set();
  for (const value of document.nodes.flatMap((node) => [node.text, node.contentDesc])) {
    const label = boundedPublicText(value, 300);
    if (!label || PRIVATE_OR_CHROME.test(label) || descriptorNote(label) || seen.has(label)) continue;
    if (/^\d+(?:[,.]\d+)?(?:万|[kKwW])?$/u.test(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= MAX_VISIBLE_LABELS) break;
  }
  return labels;
}

export function observeXhsHierarchy(hierarchy, rules, context = {}) {
  const document = parseUiAutomatorXml(hierarchy);
  if (!document.nodes.some((node) => node.packageName === XHS_PACKAGE)) {
    throw new Error("XHS observation requires Xiaohongshu in the foreground");
  }
  const classification = classifyPage(document, rules, context);
  if (classification.safety.sensitive || classification.safety.requiresHuman) {
    throw new Error("XHS observation refused a sensitive or human-required page");
  }
  if (!classification.accepted || classification.state === "UNKNOWN") {
    throw new Error("XHS observation could not classify the current page");
  }
  return {
    page: {
      state: classification.state,
      score: classification.score,
      margin: classification.margin,
    },
    notes: extractNotes(document),
    detail: extractDetail(document, classification.state),
    profile: extractProfile(document, classification.state),
    visibleLabels: visibleLabels(document),
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

export function intersectXhsObservations(first, second) {
  if (!first || !second || first.page?.state !== second.page?.state) {
    throw new Error("XHS page state was not stable across fresh UI observations");
  }
  const secondNotes = new Map(second.notes.map((note) => [
    `${note.mediaType}\u0000${note.author}\u0000${note.title}`,
    note,
  ]));
  const notes = first.notes
    .filter((note) => secondNotes.has(`${note.mediaType}\u0000${note.author}\u0000${note.title}`))
    .map((note) => {
      const current = secondNotes.get(`${note.mediaType}\u0000${note.author}\u0000${note.title}`);
      return stableJson(note) === stableJson(current) ? note : {
        title: note.title,
        author: note.author,
        mediaType: note.mediaType,
        metrics: { likes: null },
      };
    });
  const labelSet = new Set(second.visibleLabels);
  const detail = stableJson(first.detail) === stableJson(second.detail) ? first.detail : null;
  const profile = stableJson(first.profile) === stableJson(second.profile) ? first.profile : null;
  return {
    page: {
      state: first.page.state,
      score: Math.min(first.page.score, second.page.score),
      margin: Math.min(first.page.margin, second.page.margin),
    },
    notes,
    detail,
    profile,
    visibleLabels: first.visibleLabels.filter((label) => labelSet.has(label)),
    stability: "two_fresh_ui_intersection",
  };
}
