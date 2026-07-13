import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAdbResearchProvider } from "../scripts/adb-research-provider.mjs";

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function node(attributes = {}, children = "") {
  const complete = {
    index: "0", text: "", "resource-id": "", class: "android.view.View", package: "com.xingin.xhs",
    "content-desc": "", clickable: "false", enabled: "true", focused: "false", scrollable: "false",
    password: "false", bounds: "[0,0][100,100]", ...attributes,
  };
  const serialized = Object.entries(complete).map(([key, value]) => `${key}="${escapeXml(value)}"`).join(" ");
  return children ? `<node ${serialized}>${children}</node>` : `<node ${serialized} />`;
}

function hierarchy(...children) {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${children.join("")}</hierarchy>`;
}

function noteCard(id, title, author, kind = "image") {
  return node({
    "resource-id": `com.xingin.xhs:id/note_card_${id}`, clickable: "true", bounds: "[20,400][1060,900]",
    "content-desc": `noteId=${id.padEnd(24, "a")}`,
  }, [
    node({ "resource-id": "com.xingin.xhs:id/note_title", text: title, bounds: "[40,420][900,520]" }),
    node({ "resource-id": "com.xingin.xhs:id/note_author", text: author, bounds: "[40,540][500,610]" }),
    node({ "resource-id": `com.xingin.xhs:id/note_${kind}`, "content-desc": kind === "video" ? "视频" : "图片" }),
    node({ "resource-id": "com.xingin.xhs:id/like_count", text: "18" }),
  ].join(""));
}

const home = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/tab_home", text: "首页", clickable: "true", bounds: "[0,2200][300,2400]" }),
  node({ text: "关注" }),
  node({ "resource-id": "com.xingin.xhs:id/home_search_box", "content-desc": "搜索", clickable: "true", bounds: "[800,50][1080,180]" }),
  node({ "resource-id": "com.xingin.xhs:id/home_feed", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true", bounds: "[0,200][1080,2200]" },
    noteCard("1111111111111111", "首页推荐", "作者甲")),
);

const searchEntry = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", text: "搜索", focused: "true", clickable: "true", bounds: "[80,50][800,180]" }),
  node({ "resource-id": "com.xingin.xhs:id/search_submit", text: "搜索", clickable: "true", bounds: "[850,50][1060,180]" }),
);

function suggestions(keyword, values = ["summer commute capsule", "summer office outfit"]) {
  return hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", text: keyword, focused: "true", clickable: "true", bounds: "[80,50][800,180]" }),
    node({ text: "搜索发现" }),
    node({ "resource-id": "com.xingin.xhs:id/search_suggestion_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true", bounds: "[0,200][1080,2200]" },
      values.map((value, index) => node({ "resource-id": `com.xingin.xhs:id/search_suggestion_${index}`, text: value, clickable: "true", bounds: `[20,${250 + index * 120}][1060,${350 + index * 120}]` })).join("")),
  );
}

function results(keyword, cards) {
  return hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/search_input", class: "android.widget.EditText", text: keyword, bounds: "[80,50][800,180]" }),
    node({ text: "综合" }),
    node({ "resource-id": "com.xingin.xhs:id/search_result_list", class: "androidx.recyclerview.widget.RecyclerView", scrollable: "true", bounds: "[0,300][1080,2200]" }, cards.join("")),
  );
}

const login = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/login_title", text: "登录" }),
  node({ "resource-id": "com.xingin.xhs:id/verification_code", text: "验证码", class: "android.widget.EditText" }),
  node({ text: "其他登录方式" }),
);

const video = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/video_player", "content-desc": "播放", bounds: "[0,0][1080,2000]" }),
  node({ "resource-id": "com.xingin.xhs:id/note_title", text: "视频笔记" }),
  node({ "resource-id": "com.xingin.xhs:id/comment_entry", text: "评论", clickable: "true" }),
);

function imageDetail(title, noteId) {
  return hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/image_pager", "content-desc": `第1张图片 noteId=${noteId}`, bounds: "[0,0][1080,500]" }),
    node({ "resource-id": "com.xingin.xhs:id/note_title", text: title, bounds: "[30,220][1000,320]" }),
    node({ "resource-id": "com.xingin.xhs:id/note_author", text: "Detail Author", bounds: "[30,330][700,390]" }),
    node({ "resource-id": "com.xingin.xhs:id/note_content_scroll", class: "android.widget.ScrollView", scrollable: "true", bounds: "[0,400][1080,1800]" },
      node({ "resource-id": "com.xingin.xhs:id/note_content", text: "A public note excerpt" })),
    node({ "resource-id": "com.xingin.xhs:id/comment_entry", text: "共12条评论", clickable: "true", bounds: "[780,1900][1060,2050]" }),
  );
}

function videoDetail(title, noteId) {
  return hierarchy(
    node({ "resource-id": "com.xingin.xhs:id/video_player", "content-desc": `播放 noteId=${noteId}`, bounds: "[0,0][1080,1800]" }),
    node({ "resource-id": "com.xingin.xhs:id/note_title", text: title }),
    node({ "resource-id": "com.xingin.xhs:id/note_author", text: "Video Author" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_entry", text: "评论", clickable: "true", bounds: "[800,1900][1060,2050]" }),
  );
}

const commentsPanel = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/comment_count_title", text: "共12条评论" }),
  node({ "resource-id": "com.xingin.xhs:id/comment_input", text: "说点什么...", class: "android.widget.EditText", clickable: "true", bounds: "[20,2100][1060,2250]" }),
  node({ "resource-id": "com.xingin.xhs:id/comment_panel", class: "android.app.Dialog", bounds: "[0,600][1080,2300]" }, [
    node({ "resource-id": "com.xingin.xhs:id/comment_text_1", text: "@小明 可以看看 13800138000" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_text_2", text: "更多信息 https://example.test/a" }),
    node({ "resource-id": "com.xingin.xhs:id/comment_text_3", text: "第三条不会被采集" }),
  ].join("")),
);

const safeUnknownLocalOcr = Object.freeze({
  pageType: "UNKNOWN",
  confidence: 0,
  targetDescription: "",
  suggestedAction: "NONE",
  humanRequired: false,
  ocrAvailable: true,
  safeForCloud: true,
});

const unknownWithSearch = hierarchy(
  node({ "resource-id": "com.xingin.xhs:id/search_box", clickable: "true", bounds: "[700,40][1050,180]" }),
  node({ text: "未标定页面" }),
);

function mockAdb(dumps = []) {
  const calls = [];
  const queue = [...dumps];
  const runner = async (spec) => {
    calls.push({ ...spec, args: [...spec.args] });
    if (spec.operation === "get_state") return { exitCode: 0, stdout: "device\n" };
    if (spec.operation === "android_sdk") return { exitCode: 0, stdout: "34\n" };
    if (spec.operation === "package_info") return { exitCode: 0, stdout: "versionName=9.5.45\n" };
    if (spec.operation === "screen_size") return { exitCode: 0, stdout: "Physical size: 1080x2400\n" };
    if (spec.operation === "screen_density") return { exitCode: 0, stdout: "Physical density: 420\n" };
    if (spec.operation === "ui_dump") {
      const value = queue.length > 1 ? queue.shift() : queue[0];
      return value ? { exitCode: 0, stdout: value } : { exitCode: 1, stdout: "" };
    }
    if (/screenshot$/.test(spec.operation)) return { exitCode: 0, stdout: Buffer.from("89504e470d0a1a0a00", "hex") };
    return { exitCode: 0, stdout: "" };
  };
  return { calls, runner, remaining: queue };
}

function task(overrides = {}) {
  return {
    taskId: "provider-test-task",
    topic: "summer commute",
    deviceGroup: "content",
    commentMode: "none",
    aiPolicy: { pageFallback: true },
    budgets: {
      maxNotesPerQuery: 5, maxResultScrollsPerQuery: 1, maxNoNewScrolls: 2,
      maxNoteScrolls: 0, maxCommentPanels: 0, maxCommentsPerNote: 0,
    },
    ...overrides,
  };
}

function providerFor(mock, options = {}) {
  const waits = [];
  const provider = createAdbResearchProvider({
    devices: [{ alias: "content-01", serial: "REAL-SERIAL-NEVER-RETURN", group: "content" }],
    commandRunner: mock.runner,
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    ...options,
  });
  return { provider, waits };
}

test("inventory and online checks use opaque aliases and never return a device serial", async () => {
  const mock = mockAdb();
  const { provider } = providerFor(mock);
  const devices = await provider.listDevices({ deviceGroup: "content" });
  assert.deepEqual(devices, [{ alias: "content-01", online: true, groups: ["content"] }]);
  assert.equal(await provider.isDeviceOnline({ deviceAlias: "content-01" }), true);
  const profiles = await provider.getDeviceProfiles({ deviceGroup: "content" });
  assert.deepEqual(profiles, [{
    alias: "content-01", online: true, xhsVersion: "9.5.45", androidSdk: "34", resolution: "1080x2400", dpi: "420",
  }]);
  assert.equal(JSON.stringify(devices).includes("REAL-SERIAL"), false);
  assert.equal(JSON.stringify(profiles).includes("REAL-SERIAL"), false);
  assert(mock.calls.every((call) => call.deviceAlias === "content-01"));
});

test("provider never falls back to all devices when a task group is not explicitly mapped", async () => {
  const mock = mockAdb();
  const provider = createAdbResearchProvider({
    devices: [{ alias: "content-01", serial: "REAL-SERIAL-NEVER-RETURN", groups: [] }],
    commandRunner: mock.runner,
  });
  assert.deepEqual(await provider.listDevices({ deviceGroup: "content" }), []);
  assert.equal(mock.calls.length, 0);
});

test("ASCII search uses semantic per-device bounds, exact verification, stable waits, extraction, and in-container scroll", async () => {
  const keyword = "summer commute";
  const first = results(keyword, [noteCard("2222222222222222", "Five office outfits", "Alice")]);
  const second = results(keyword, [noteCard("3333333333333333", "Lightweight workwear", "Bob", "video")]);
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), first, first, second, second]);
  const { provider, waits } = providerFor(mock);
  const result = await provider.executeWorkUnit({
    task: task(), unit: { source: "search", keyword }, device: { alias: "content-01" }, deviceAlias: "content-01", attempt: 0,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.candidates.map((candidate) => candidate.title), ["Five office outfits", "Lightweight workwear"]);
  assert.equal(result.candidates[1].mediaType, "video");
  assert(waits.length >= 4 && waits.every((value) => value === 500));
  const searchTap = mock.calls.find((call) => call.operation === "tap_search_entry");
  assert.deepEqual(searchTap.args.slice(-2), ["940", "115"]);
  const input = mock.calls.find((call) => call.operation === "input_ascii");
  assert.equal(input.args.at(-1), "'summer%scommute'");
  const scroll = mock.calls.find((call) => call.operation === "scroll_results");
  assert.deepEqual(scroll.args.slice(-5), ["540", "1725", "540", "775", "350"]);
  assert.equal(JSON.stringify(result).includes("REAL-SERIAL-NEVER-RETURN"), false);
  assert.equal(mock.calls.filter((call) => call.operation === "tap_search_entry").length, 1);
});

test("bounded image-detail sampling scrolls only a semantic content container and reads deidentified comments", async () => {
  const keyword = "office capsule";
  const rawId = "4444444444444444";
  const noteId = rawId.padEnd(24, "a");
  const list = results(keyword, [noteCard(rawId, "Office capsule guide", "List Author")]);
  const detail = imageDetail("Office capsule guide", noteId);
  const mock = mockAdb([
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, detail, detail, commentsPanel, commentsPanel, detail, detail, list, list,
  ]);
  const { provider } = providerFor(mock);
  const detailedTask = task({
    topic: keyword,
    commentMode: "deidentified_snippets",
    budgets: {
      maxNotesPerQuery: 5, maxResultScrollsPerQuery: 0, maxNoNewScrolls: 2,
      maxNoteScrolls: 1, maxCommentPanels: 1, maxCommentsPerNote: 2,
    },
  });
  const result = await provider.executeWorkUnit({ task: detailedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  assert.equal(result.status, "completed");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].author, "Detail Author");
  assert.equal(result.candidates[0].commentMetadata.count, "12");
  assert.deepEqual(result.candidates[0].commentMetadata.snippets, [
    "@用户 可以看看 [手机号已脱敏]",
    "更多信息 [链接已脱敏]",
  ]);
  const noteScroll = mock.calls.find((call) => call.operation === "scroll_note_content");
  assert.deepEqual(noteScroll.args.slice(-5), ["540", "1450", "540", "750", "350"]);
  assert.equal(mock.calls.filter((call) => call.operation === "tap_comments_entry").length, 1);
  assert.equal(mock.calls.some((call) => /comment_input|tap_.*input/.test(call.operation)), false);
  assert.equal(mock.calls.filter((call) => call.operation === "return_to_list").length, 1);
});

test("maxCommentPanels is reserved across all work units in the same task", async () => {
  const keyword = "budgeted comments";
  const rawId = "9999999999999999";
  const noteId = rawId.padEnd(24, "a");
  const list = results(keyword, [noteCard(rawId, "Budgeted comments note", "List Author")]);
  const detail = imageDetail("Budgeted comments note", noteId);
  const firstRun = [
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, commentsPanel, commentsPanel, detail, detail, list, list,
  ];
  const secondRun = [
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, list, list,
  ];
  const mock = mockAdb([...firstRun, ...secondRun]);
  const usage = [];
  const { provider } = providerFor(mock, { onResourceUsage: async (value) => { usage.push(value); } });
  const sharedTask = task({
    taskId: "shared-comment-budget",
    topic: keyword,
    commentMode: "metadata",
    budgets: {
      maxNotesPerQuery: 5, maxResultScrollsPerQuery: 0, maxNoNewScrolls: 2,
      maxNoteScrolls: 0, maxCommentPanels: 1, maxCommentsPerNote: 2,
    },
  });
  const first = await provider.executeWorkUnit({ task: sharedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  const second = await provider.executeWorkUnit({ task: sharedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(mock.calls.filter((call) => call.operation === "tap_comments_entry").length, 1);
  assert.equal(first.candidates[0].commentMetadata.panelOpened, true);
  assert.equal(second.candidates[0].commentMetadata.panelOpened, false);
  assert.deepEqual(usage, [{ taskId: "shared-comment-budget", commentPanelsUsed: 1 }]);
});

test("a comment-panel attempt remains counted when the destination cannot be verified", async () => {
  const keyword = "conservative comment budget";
  const rawId = "8888888888888888";
  const noteId = rawId.padEnd(24, "a");
  const list = results(keyword, [noteCard(rawId, "Conservative budget note", "List Author")]);
  const detail = imageDetail("Conservative budget note", noteId);
  const firstRun = [
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, list, list, detail, detail, list, list,
  ];
  const secondRun = [
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, list, list,
  ];
  const usage = [];
  const mock = mockAdb([...firstRun, ...secondRun]);
  const { provider } = providerFor(mock, { onResourceUsage: async (value) => { usage.push(value); } });
  const sharedTask = task({
    taskId: "conservative-comment-budget",
    topic: keyword,
    commentMode: "metadata",
    budgets: {
      maxNotesPerQuery: 5, maxResultScrollsPerQuery: 0, maxNoNewScrolls: 2,
      maxNoteScrolls: 0, maxCommentPanels: 1, maxCommentsPerNote: 2,
    },
  });
  const first = await provider.executeWorkUnit({ task: sharedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  const second = await provider.executeWorkUnit({ task: sharedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  assert.equal(first.status, "partial");
  assert.equal(second.status, "completed");
  assert.equal(mock.calls.filter((call) => call.operation === "tap_comments_entry").length, 1);
  assert.deepEqual(usage, [{ taskId: "conservative-comment-budget", commentPanelsUsed: 1 }]);
});

test("a resumed provider restores the checkpointed task-wide comment budget", async () => {
  const keyword = "resumed comments";
  const taskId = "resumed-comment-budget";
  const rawId = "7777777777777777";
  const noteId = rawId.padEnd(24, "a");
  const list = results(keyword, [noteCard(rawId, "Resumed comments note", "List Author")]);
  const detail = imageDetail("Resumed comments note", noteId);
  const mock = mockAdb([
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, list, list,
  ]);
  const { provider } = providerFor(mock, { initialCommentPanelsByTask: { [taskId]: 1 } });
  const resumedTask = task({
    taskId,
    topic: keyword,
    commentMode: "metadata",
    budgets: {
      maxNotesPerQuery: 5, maxResultScrollsPerQuery: 0, maxNoNewScrolls: 2,
      maxNoteScrolls: 0, maxCommentPanels: 1, maxCommentsPerNote: 2,
    },
  });
  const result = await provider.executeWorkUnit({ task: resumedTask, unit: { source: "search", keyword }, deviceAlias: "content-01" });
  assert.equal(result.status, "completed");
  assert.equal(result.candidates[0].commentMetadata.panelOpened, false);
  assert.equal(mock.calls.some((call) => call.operation === "tap_comments_entry"), false);
});

test("video-detail sampling verifies the note and returns without swiping its main canvas", async () => {
  const keyword = "video capsule";
  const rawId = "5555555555555555";
  const noteId = rawId.padEnd(24, "a");
  const list = results(keyword, [noteCard(rawId, "Video capsule guide", "List Author", "video")]);
  const detail = videoDetail("Video capsule guide", noteId);
  const mock = mockAdb([
    home, home, searchEntry, searchEntry, suggestions(keyword), suggestions(keyword), list, list,
    detail, detail, list, list,
  ]);
  const { provider } = providerFor(mock);
  const result = await provider.executeWorkUnit({
    task: task({
      topic: keyword,
      budgets: {
        maxNotesPerQuery: 5, maxResultScrollsPerQuery: 0, maxNoNewScrolls: 2,
        maxNoteScrolls: 3, maxCommentPanels: 0, maxCommentsPerNote: 0,
      },
    }),
    unit: { source: "search", keyword }, deviceAlias: "content-01",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.candidates[0].mediaType, "video");
  assert.equal(mock.calls.some((call) => call.operation === "scroll_note_content"), false);
  assert.equal(mock.calls.some((call) => call.operation === "scroll_results"), false);
});

test("unavailable optional sources return skipped without a device-failure signature", async () => {
  const mock = mockAdb([home, home, searchEntry, searchEntry]);
  const { provider } = providerFor(mock);
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "trending", keyword: "x" }, deviceAlias: "content-01" });
  assert.equal(result.status, "skipped");
  assert.equal(result.sourceSkipped, true);
  assert.equal(result.failureSignature, null);
  assert.equal(result.skipReason, "source_unavailable:trending");
});

test("human handoff selects an exact fresh card, verifies detail identity, and pauses without interaction", async () => {
  const title = "Exact handoff title";
  const rawId = "6666666666666666";
  const noteId = rawId.padEnd(24, "a");
  const list = results(title, [noteCard(rawId, title, "List Author")]);
  const detail = imageDetail(title, noteId);
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions(title), suggestions(title), list, list, detail, detail]);
  const { provider } = providerFor(mock);
  const result = await provider.navigateToCandidate({
    task: task({ topic: title, budgets: { ...task().budgets, maxResultScrollsPerQuery: 0 } }),
    candidate: { candidateId: "candidate-1", noteId, title, keyword: "handoff" },
    deviceAlias: "content-01",
  });
  assert.equal(result.status, "paused");
  assert.equal(result.pausedForHuman, true);
  assert.equal(result.pageState, "IMAGE_NOTE");
  assert.equal(result.verifiedBy, "noteId");
  assert.equal(result.candidate.title, title);
  const exactTap = mock.calls.find((call) => call.operation === "tap_exact_candidate");
  assert.deepEqual(exactTap.args.slice(-2), ["540", "650"]);
  assert.equal(mock.calls.some((call) => /like|favorite|follow|publish|send/.test(call.operation)), false);
  assert.equal(JSON.stringify(result).includes("REAL-SERIAL"), false);
});

test("ambiguous exact-title handoff stops without opening a generic first card", async () => {
  const title = "Duplicate exact title";
  const list = results(title, [
    noteCard("7777777777777777", title, "Author A"),
    noteCard("8888888888888888", title, "Author B"),
  ]);
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions(title), suggestions(title), list, list]);
  const { provider } = providerFor(mock);
  const result = await provider.navigateToCandidate({
    task: task({ topic: title, budgets: { ...task().budgets, maxResultScrollsPerQuery: 0 } }),
    candidate: { candidateId: "ambiguous", title, keyword: title }, deviceAlias: "content-01",
  });
  assert.equal(result.status, "human_required");
  assert.equal(result.failureSignature, "handoff:ambiguous_title");
  assert.equal(mock.calls.some((call) => call.operation === "tap_exact_candidate"), false);
});

test("Chinese suggestions use only an approved base64 IME broadcast and return strings", async () => {
  const topic = "夏季通勤穿搭";
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions(topic, ["小个子通勤", "夏季上班穿搭"]), suggestions(topic, ["小个子通勤", "夏季上班穿搭"])]);
  const { provider } = providerFor(mock, {
    unicodeInput: { enabled: true, action: "ADB_INPUT_B64", extraKey: "msg", approvedAliases: ["content-01"] },
  });
  const values = await provider.collectTopicSuggestions({ task: task({ topic }), deviceAlias: "content-01" });
  assert.deepEqual(values, ["小个子通勤", "夏季上班穿搭"]);
  const broadcast = mock.calls.find((call) => call.operation === "input_unicode_b64");
  assert(broadcast);
  assert.equal(broadcast.args.includes(topic), false);
  assert.equal(Buffer.from(broadcast.args.at(-1), "base64").toString("utf8"), topic);
  assert.equal(mock.calls.some((call) => call.operation === "input_ascii"), false);
});

test("an explicitly approved per-device Xiaowei text adapter takes priority over the Unicode IME", async () => {
  const topic = "夏季通勤穿搭";
  const delivered = [];
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions(topic, ["通勤建议"]), suggestions(topic, ["通勤建议"])]);
  const { provider } = providerFor(mock, {
    xiaoweiTextApprovedAliases: ["content-01"],
    xiaoweiTextInput: async (value) => { delivered.push(value); },
    unicodeInput: { enabled: true, action: "ADB_INPUT_B64", extraKey: "msg", approvedAliases: ["content-01"] },
  });
  const values = await provider.collectTopicSuggestions({ task: task({ topic }), deviceAlias: "content-01" });
  assert.deepEqual(values, ["通勤建议"]);
  assert.deepEqual(delivered, [{ deviceAlias: "content-01", text: topic }]);
  assert.equal(mock.calls.some((call) => call.operation === "input_unicode_b64"), false);
});

test("unapproved Unicode input safely returns human_required without submitting text", async () => {
  const mock = mockAdb([home, home, searchEntry, searchEntry]);
  const { provider } = providerFor(mock);
  const result = await provider.collectTopicSuggestions({ task: task({ topic: "夏季通勤" }), deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.affectsDeviceHealth, false);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.failureSignature, "input:unicode_requires_human");
  assert.equal(mock.calls.some((call) => call.operation === "input_ascii" || call.operation === "input_unicode_b64" || call.operation === "submit_search"), false);
});

test("an exact EditText mismatch stops instead of submitting a potentially garbled search", async () => {
  const keyword = "summer commute";
  const mock = mockAdb([home, home, searchEntry, searchEntry, suggestions("summer commut3"), suggestions("summer commut3")]);
  const { provider } = providerFor(mock);
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "search", keyword }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.failureSignature, "input:verification_failed");
  assert.equal(mock.calls.some((call) => call.operation === "submit_search" || call.operation === "tap_search_submit"), false);
});

test("login and challenge UI hard-stops before recovery, tapping, scrolling, or cloud-visible artifacts", async () => {
  let recoveryCalls = 0;
  const mock = mockAdb([login]);
  const { provider } = providerFor(mock, { pageRecovery: async () => { recoveryCalls += 1; return {}; } });
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "recommended", keyword: "x" }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.stopAll, true);
  assert.match(result.failureSignature, /^safety:/);
  assert.equal(recoveryCalls, 0);
  assert.equal(mock.calls.some((call) => /^tap_|scroll|screenshot/.test(call.operation)), false);
});

test("configured local diagnostics retain hierarchy and screenshot paths after a navigation stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "xhs-provider-diagnostics-"));
  const mock = mockAdb([login]);
  const { provider } = providerFor(mock, { failureArtifactsRoot: root });
  const result = await provider.executeWorkUnit({
    task: task({ taskId: "diagnostic-task" }),
    unit: { unitId: "diagnostic-unit", source: "recommended", keyword: "x" },
    deviceAlias: "content-01",
  });
  assert.equal(result.status, "human_required");
  assert.equal(typeof result.diagnostics.hierarchyPath, "string");
  assert.equal(typeof result.diagnostics.screenshotPath, "string");
  await access(result.diagnostics.hierarchyPath);
  await access(result.diagnostics.screenshotPath);
  assert.equal(JSON.stringify(result.diagnostics).includes("REAL-SERIAL"), false);
});

test("page recovery rejects coordinates and never converts them into a device tap", async () => {
  let recoveryInput;
  const mock = mockAdb([unknownWithSearch, unknownWithSearch]);
  const { provider } = providerFor(mock, {
    localOcr: async () => safeUnknownLocalOcr,
    pageRecovery: async (input) => {
      recoveryInput = input;
      return { pageType: "UNKNOWN", confidence: 0.99, targetDescription: "搜索框", x: 900, y: 100 };
    },
  });
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "search", keyword: "ascii" }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.failureSignature, "page:recovery_invalid");
  assert.equal(recoveryInput.deviceAlias, "content-01");
  assert.equal(recoveryInput.classification.safety.blockCloudUpload, false);
  assert.equal(mock.calls.some((call) => /^tap_/.test(call.operation)), false);
});

test("two safe but unmatched local OCR scans occur before the optional AI page fallback", async () => {
  let localCalls = 0;
  let aiCalls = 0;
  const checkedImages = [];
  const mock = mockAdb([unknownWithSearch, unknownWithSearch]);
  const { provider } = providerFor(mock, {
    localOcr: async ({ attempt, imagePath }) => {
      localCalls += 1;
      assert.equal(attempt, localCalls);
      assert.match(imagePath, /screen\.png$/);
      checkedImages.push(imagePath);
      return safeUnknownLocalOcr;
    },
    pageRecovery: async () => {
      aiCalls += 1;
      return { pageType: "UNKNOWN", confidence: 0.4, targetDescription: "搜索框" };
    },
  });
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "search", keyword: "ascii" }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.failureSignature, "page:recovery_low_confidence");
  assert.equal(localCalls, 2);
  assert.equal(aiCalls, 1);
  assert.equal(new Set(checkedImages).size, 1);
});

test("unavailable local OCR blocks cloud recovery instead of trusting a caller flag", async () => {
  let aiCalls = 0;
  const mock = mockAdb([unknownWithSearch, unknownWithSearch]);
  const { provider } = providerFor(mock, {
    localOcr: async () => null,
    pageRecovery: async () => {
      aiCalls += 1;
      return null;
    },
  });
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "search", keyword: "ascii" }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.stopAll, true);
  assert.equal(result.failureSignature, "page:privacy_check_unavailable");
  assert.equal(aiCalls, 0);
});

test("sensitive local OCR result stops all devices without calling AI or tapping", async () => {
  let aiCalls = 0;
  const mock = mockAdb([unknownWithSearch, unknownWithSearch]);
  const { provider } = providerFor(mock, {
    localOcr: async () => ({
      pageType: "LOGIN_OR_CHALLENGE",
      confidence: 0.99,
      targetDescription: "",
      suggestedAction: "STOP_FOR_HUMAN",
      humanRequired: true,
    }),
    pageRecovery: async () => {
      aiCalls += 1;
      return null;
    },
  });
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "search", keyword: "ascii" }, deviceAlias: "content-01" });
  assert.equal(result.status, "human_required");
  assert.equal(result.stopAll, true);
  assert.equal(result.failureSignature, "safety:local_ocr_sensitive");
  assert.equal(aiCalls, 0);
  assert.equal(mock.calls.some((call) => /^tap_/.test(call.operation)), false);
});

test("valid page recovery refreshes UI and re-resolves the semantic target before one tap", async () => {
  const keyword = "ascii";
  let recoveryCalls = 0;
  const mock = mockAdb([
    unknownWithSearch, unknownWithSearch,
    unknownWithSearch, unknownWithSearch,
    searchEntry, searchEntry,
    suggestions(keyword, ["ascii outfit"]), suggestions(keyword, ["ascii outfit"]),
  ]);
  const { provider } = providerFor(mock, {
    localOcr: async () => safeUnknownLocalOcr,
    pageRecovery: async ({ xmlPath, imagePath, classification }) => {
      recoveryCalls += 1;
      assert.match(xmlPath, /hierarchy\.xml$/);
      assert.match(imagePath, /screen\.png$/);
      assert.equal(classification.state, "UNKNOWN");
      return { pageType: "SEARCH_ENTRY", confidence: 0.97, targetDescription: "搜索框" };
    },
  });
  const result = await provider.executeWorkUnit({
    task: task({ budgets: { ...task().budgets, maxResultScrollsPerQuery: 0 } }),
    unit: { source: "suggestions", keyword }, deviceAlias: "content-01",
  });
  assert.equal(result.status, "completed");
  assert.equal(recoveryCalls, 1);
  const recoveredTap = mock.calls.find((call) => call.operation === "tap_search_entry");
  assert.deepEqual(recoveredTap.args.slice(-2), ["875", "110"]);
  assert.equal(mock.calls.filter((call) => call.operation === "tap_search_entry").length, 1);
});

test("VIDEO_NOTE is never swiped as a list surface and stops after two navigation failures", async () => {
  const mock = mockAdb([video, video, video, video, video, video]);
  const { provider } = providerFor(mock);
  const result = await provider.executeWorkUnit({ task: task(), unit: { source: "recommended", keyword: "x" }, deviceAlias: "content-01" });
  assert.equal(result.status, "partial");
  assert.match(result.failureSignature, /^navigation:home:/);
  assert.equal(mock.calls.filter((call) => call.operation === "navigate_back").length, 2);
  assert.equal(mock.calls.some((call) => call.operation === "scroll_results"), false);
});

test("external interaction requests are refused before any ADB command", async () => {
  const mock = mockAdb();
  const { provider } = providerFor(mock);
  const result = await provider.executeWorkUnit({
    task: task(), unit: { source: "search", keyword: "x", action: "like" }, deviceAlias: "content-01",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failureSignature, "safety:forbidden_interaction");
  assert.equal(mock.calls.length, 0);
});
