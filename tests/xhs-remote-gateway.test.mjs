import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildRemoteArgv,
  commandTimeoutMs,
  computeGatewayBuildId,
  createGatewayScheduler,
  createRemoteGateway,
  extractPublicArtifactReferences,
  gatewayScheduleScope,
  parseStructuredReadOutput,
  sanitizeCommandOutput,
} from "../scripts/xhs-remote-gateway.mjs";

test("gateway build identity covers every declared resident source", () => {
  assert.match(computeGatewayBuildId(), /^[a-f0-9]{64}$/u);
  const source = readFileSync(new URL("../scripts/xhs-remote-gateway.mjs", import.meta.url), "utf8");
  assert.match(source, /GATEWAY_RESIDENT_SOURCE_PATHS[\s\S]+device-node-engine\.mjs/u);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("gateway scheduler serializes one machine and runs different machines concurrently", async () => {
  const scheduler = createGatewayScheduler();
  const first02Started = deferred();
  const first02Release = deferred();
  const second02Started = deferred();
  let second02HasStarted = false;
  const machine03Started = deferred();
  const machine03Release = deferred();
  const first02 = scheduler.enqueue("machine:02", async () => {
    first02Started.resolve();
    await first02Release.promise;
  });
  const second02 = scheduler.enqueue("machine:02", async () => {
    second02HasStarted = true;
    second02Started.resolve();
  });
  const machine03 = scheduler.enqueue("machine:03", async () => {
    machine03Started.resolve();
    await machine03Release.promise;
  });

  await Promise.all([first02Started.promise, machine03Started.promise]);
  assert.equal(scheduler.activeRequests, 2);
  assert.equal(scheduler.waitingDepth, 1);
  assert.equal(second02HasStarted, false);
  first02Release.resolve();
  await second02Started.promise;
  machine03Release.resolve();
  await Promise.all([first02, second02, machine03]);
  assert.equal(scheduler.depth, 0);
});

test("gateway scheduler treats global work as a fair exclusive barrier", async () => {
  const scheduler = createGatewayScheduler();
  const machineStarted = deferred();
  const machineRelease = deferred();
  const globalStarted = deferred();
  const globalRelease = deferred();
  const laterMachineStarted = deferred();
  const machine = scheduler.enqueue("machine:02", async () => {
    machineStarted.resolve();
    await machineRelease.promise;
  });
  const global = scheduler.enqueue("global", async () => {
    globalStarted.resolve();
    await globalRelease.promise;
  });
  const laterMachine = scheduler.enqueue("machine:03", async () => { laterMachineStarted.resolve(); });

  await machineStarted.promise;
  assert.equal(scheduler.activeRequests, 1);
  assert.equal(scheduler.waitingDepth, 2);
  machineRelease.resolve();
  await globalStarted.promise;
  assert.equal(scheduler.activeRequests, 1);
  assert.equal(scheduler.waitingDepth, 1);
  globalRelease.resolve();
  await laterMachineStarted.promise;
  await Promise.all([machine, global, laterMachine]);
  assert.equal(gatewayScheduleScope({ machine: "03" }), "machine:03");
  assert.equal(gatewayScheduleScope({ command: "host.status" }), "global");
});

test("gateway scheduler snapshot identifies active and waiting machine work", async () => {
  const scheduler = createGatewayScheduler();
  const release = deferred();
  const started = deferred();
  const active = scheduler.enqueue("machine:04", async () => {
    started.resolve();
    await release.promise;
  }, { requestId: "request-active", command: "device.ui", machine: "04" });
  const waiting = scheduler.enqueue("machine:04", async () => {}, {
    requestId: "request-waiting", command: "device.screen", machine: "04",
  });
  await started.promise;
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.active[0].machine, "04");
  assert.equal(snapshot.active[0].command, "device.ui");
  assert.match(snapshot.active[0].startedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(snapshot.waiting[0].requestId, "request-waiting");
  assert.equal(snapshot.waiting[0].startedAt, null);
  release.resolve();
  await Promise.all([active, waiting]);
});

const NODE_SELECTOR = {
  label: "我",
  role: "tab",
  sources: ["accessibility", "ocr", "relation"],
  relation: {
    algorithm: "horizontal_equal_spacing",
    region: "bottom_navigation",
    anchors: [{ label: "通讯录", ordinal: 2 }, { label: "发现", ordinal: 3 }],
    targetOrdinal: 4,
  },
};

test("remote gateway exposes only named xhs commands", () => {
  assert.deepEqual(buildRemoteArgv({ command: "host.restart-adb" }), ["host", "restart-adb"]);
  assert.deepEqual(buildRemoteArgv({ command: "private.catalog" }), ["api", "private-catalog"]);
  assert.deepEqual(buildRemoteArgv({ command: "device.size", machine: "02" }), ["device", "size", "--machine", "02"]);
  assert.deepEqual(buildRemoteArgv({ command: "device.ui", machine: "04" }), ["device", "ui", "--machine", "04"]);
  assert.deepEqual(buildRemoteArgv({ command: "device.guide", failureCode: "UI_EMPTY" }), [
    "device", "guide", "--failure-code", "UI_EMPTY",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "wechat.wallet-balance", machine: "04" }), [
    "wechat", "wallet-balance", "--machine", "04",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.observe", machine: "04" }), [
    "xhs", "observe", "--machine", "04",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.find-video", machine: "04" }), [
    "xhs", "find-video", "--machine", "04", "--max-scrolls", "3", "--max-duration-ms", "28000",
  ]);
  assert.deepEqual(buildRemoteArgv({
    command: "xhs.find-video", machine: "04", maxScrolls: 5, maxDurationMs: 30_000,
  }), [
    "xhs", "find-video", "--machine", "04", "--max-scrolls", "5", "--max-duration-ms", "30000",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.open-visible", machine: "04", ordinal: 2 }), [
    "xhs", "open-visible", "--machine", "04", "--ordinal", "2",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.comment-emoji", machine: "01", emoji: "[微笑R]" }), [
    "xhs", "comment-emoji", "--machine", "01", "--emoji", "[微笑R]",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.comment.open", machine: "01" }), [
    "xhs", "comment-open", "--machine", "01",
  ]);
  assert.deepEqual(buildRemoteArgv({
    command: "xhs.comment.input", machine: "01", text: "[微笑R]", expectedEditorStateHash: "a".repeat(64),
  }), [
    "xhs", "comment-input", "--machine", "01", "--text", "[微笑R]", "--expected-editor-state-hash", "a".repeat(64),
  ]);
  assert.deepEqual(buildRemoteArgv({
    command: "xhs.comment.reply-input", machine: "04", text: "感谢分享", ordinal: 2,
  }), [
    "xhs", "comment-reply-input", "--machine", "04", "--text", "感谢分享", "--ordinal", "2",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "xhs.comment.reply-input", machine: "04", text: "感谢分享", ordinal: 0,
  }), /ordinal is invalid/u);
  assert.deepEqual(buildRemoteArgv({
    command: "device.tap-text", machine: "01", package: "com.xingin.xhs", text: "回复",
    match: "suffix", ordinal: 2, expectText: "发送",
    reason: "open selected reply composer", rollback: "press back once",
  }), [
    "device", "tap-text", "--machine", "01", "--text", "回复", "--package", "com.xingin.xhs",
    "--match", "suffix", "--ordinal", "2", "--expect-text", "发送", "--confirm",
    "--reason", "open selected reply composer", "--rollback", "press back once",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "device.tap-text", machine: "01", package: "com.xingin.xhs", text: "回复",
    match: "suffix", expectText: "发送", reason: "open reply", rollback: "press back",
  }), /requires ordinal/u);
  assert.deepEqual(buildRemoteArgv({
    command: "xhs.comment.send", machine: "01", expectedDraft: "[微笑R]", expectedBeforeCount: 192,
    expectedTarget: { title: "测试帖子", author: "测试作者", mediaType: "image" },
    expectedEmptyEditorStateHash: "a".repeat(64),
  }), [
    "xhs", "comment-send", "--machine", "01", "--expected-draft", "[微笑R]", "--expected-before-count", "192",
    "--expected-target-base64", Buffer.from(JSON.stringify({
      title: "测试帖子", author: "测试作者", mediaType: "image",
    }), "utf8").toString("base64"),
    "--expected-empty-editor-state-hash", "a".repeat(64),
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "xhs.dm.send", machine: "01", expectedDraft: "测试" }), [
    "xhs", "dm-send", "--machine", "01", "--expected-draft", "测试",
  ]);
  assert.throws(
    () => buildRemoteArgv({ command: "xhs.open-visible", machine: "04", ordinal: 0 }),
    /ordinal/u,
  );
  assert.deepEqual(buildRemoteArgv({ command: "device.scroll", machine: "02", direction: "down" }), [
    "device", "scroll", "--machine", "02", "--direction", "down", "--steps", "1",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "device.scroll", machine: "02", direction: "right" }), [
    "device", "scroll", "--machine", "02", "--direction", "right", "--steps", "1",
  ]);
  assert.throws(
    () => buildRemoteArgv({ command: "device.scroll", machine: "02", direction: "sideways" }),
    /direction/u,
  );
  assert.deepEqual(buildRemoteArgv({ command: "app.open", machine: "03", package: "com.tencent.mm" }), [
    "app", "open", "--machine", "03", "--package", "com.tencent.mm",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "device.start-apk", machine: "03", package: "com.tencent.mm" }), [
    "app", "open", "--machine", "03", "--package", "com.tencent.mm",
  ]);
  assert.deepEqual(buildRemoteArgv({ command: "device.recent", machine: "03" }), [
    "device", "recent", "--machine", "03",
  ]);
  assert.deepEqual(buildRemoteArgv({
    command: "device.tap-coords", machine: "01", package: "com.example.launcher", x: "50", y: 8.5,
    expectPackage: "com.xingin.xhs",
  }), [
    "device", "tap-coords", "--machine", "01", "--package", "com.example.launcher",
    "--x", "50", "--y", "8.5", "--expect-package", "com.xingin.xhs",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "device.tap-coords", machine: "01", package: "com.example.launcher", x: 101, y: 8.5,
    expectPackage: "com.xingin.xhs",
  }), /percentage/u);
  assert.deepEqual(buildRemoteArgv({
    command: "device.input", machine: "02", package: "com.xingin.xhs", text: "通勤穿搭",
  }), [
    "device", "input", "--machine", "02", "--package", "com.xingin.xhs", "--text", "通勤穿搭",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "device.tap-text", machine: "01", text: "发送", expectText: "已发送",
    reason: "submit prepared comment", rollback: "inspect comment count",
  }), /package is invalid/u);
  assert.deepEqual(buildRemoteArgv({
    command: "device.tap-text", machine: "01", package: "com.xingin.xhs", text: "发送", expectText: "已发送",
    reason: "submit prepared comment", rollback: "inspect comment count",
  }), [
    "device", "tap-text", "--machine", "01", "--text", "发送", "--package", "com.xingin.xhs",
    "--expect-text", "已发送", "--confirm", "--reason", "submit prepared comment", "--rollback", "inspect comment count",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "device.input", machine: "02", package: "com.xingin.xhs", text: "first\nsecond",
  }), /text is invalid/u);
  assert.deepEqual(buildRemoteArgv({
    command: "device.tap-ocr", machine: "04", package: "com.tencent.mm", text: "我", expectText: "服务",
    reason: "open the verified account tab", rollback: "return to the previous page",
  }), [
    "device", "tap-ocr", "--machine", "04", "--package", "com.tencent.mm",
    "--text", "我", "--expect-text", "服务", "--confirm",
    "--reason", "open the verified account tab", "--rollback", "return to the previous page",
  ]);
  assert.throws(() => buildRemoteArgv({
    command: "device.tap-ocr", machine: "04", package: "com.tencent.mm", text: "我", expectText: "服务",
    x: 900, reason: "open the verified account tab", rollback: "return to the previous page",
  }), /Unknown remote command field/u);
  assert.throws(
    () => buildRemoteArgv({ command: "device.size", machine: "02", args: { serial: "caller-value" } }),
    /Unknown remote command field/u,
  );
  assert.throws(() => buildRemoteArgv({ command: "repo.status" }), /not implemented/u);
  assert.throws(() => buildRemoteArgv({ command: "host.status", config: "other.psd1" }), /Unknown remote command field/u);
});

test("vision node commands receive a bounded two-observation gateway timeout", () => {
  assert.equal(commandTimeoutMs({
    command: "device.node.resolve",
    selector: { sources: ["vision"] },
  }), 270000);
  assert.equal(commandTimeoutMs({
    command: "device.node.activate",
    selector: { sources: ["ocr", "vision"] },
  }), 270000);
  assert.equal(commandTimeoutMs({
    command: "device.node.resolve",
    selector: { sources: ["ocr"] },
  }), 120000);
});

test("generic node commands carry a closed selector and never caller coordinates", () => {
  const shorthand = buildRemoteArgv({
    command: "device.node.resolve", machine: "03", package: "com.xingin.xhs", selector: { contentDesc: "打开评论" },
  });
  assert.deepEqual(JSON.parse(Buffer.from(shorthand[7], "base64").toString("utf8")), {
    label: "打开评论", role: "button", sources: ["accessibility"], contentDesc: "打开评论",
  });
  const resolve = buildRemoteArgv({
    command: "device.node.resolve", machine: "03", package: "com.tencent.mm", selector: NODE_SELECTOR,
  });
  assert.deepEqual(resolve.slice(0, 7), [
    "device", "node-resolve", "--machine", "03", "--package", "com.tencent.mm", "--selector-base64",
  ]);
  assert.deepEqual(JSON.parse(Buffer.from(resolve[7], "base64").toString("utf8")), NODE_SELECTOR);
  const activate = buildRemoteArgv({
    command: "device.node.activate", machine: "03", package: "com.tencent.mm", selector: NODE_SELECTOR,
    expectText: "服务", reason: "open the verified account tab", rollback: "return to the previous page",
  });
  assert.deepEqual(activate.slice(-7), [
    "--expect-text", "服务", "--confirm", "--reason", "open the verified account tab",
    "--rollback", "return to the previous page",
  ]);
  for (const field of ["x", "y", "path", "expression", "serial", "deviceId"]) {
    assert.throws(() => buildRemoteArgv({
      command: "device.node.resolve", machine: "03", package: "com.tencent.mm",
      selector: { ...NODE_SELECTOR, [field]: "caller override" },
    }), /unsupported field/u);
  }
  assert.throws(() => buildRemoteArgv({
    command: "device.node.activate", machine: "03", package: "com.tencent.mm", selector: NODE_SELECTOR,
    expectText: "服务", args: { serial: "caller override" },
    reason: "open verified tab", rollback: "return to previous page",
  }), /Unknown remote command field/u);
});

test("structured device reads expose only their public fields", () => {
  const list = parseStructuredReadOutput("device.list", JSON.stringify([{
    machine: "02", name: "phone 02", online: true,
    transport: "xiaowei-private-api", localAdbRequired: false,
  }]));
  assert.deepEqual(Object.keys(list[0]), ["machine", "name", "online", "transport", "localAdbRequired"]);
  const size = parseStructuredReadOutput("device.size", JSON.stringify({
    machine: "02", width: 1080, height: 2400,
    transport: "xiaowei-private-api", localAdbRequired: false,
  }));
  assert.deepEqual(size, {
    machine: "02", width: 1080, height: 2400,
    transport: "xiaowei-private-api", localAdbRequired: false,
  });
  const input = parseStructuredReadOutput("device.input", JSON.stringify({
    machine: "02", status: "verified", verification: "exact_focused_editor_ui_echo_after_ime_restore",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(input.status, "verified");
  const scroll = parseStructuredReadOutput("device.scroll", JSON.stringify({
    machine: "02", status: "verified", direction: "down", steps: 1,
    verification: "scrollable_container_rechecked_then_directional_events_then_fresh_ui_change",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(scroll.direction, "down");
  const horizontalScroll = parseStructuredReadOutput("device.scroll", JSON.stringify({
    machine: "02", status: "verified", direction: "right", steps: 1,
    verification: "foreground_rechecked_then_horizontal_events_then_fresh_screen_change",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(horizontalScroll.direction, "right");
  const apps = parseStructuredReadOutput("app.list", JSON.stringify({
    machine: "02", packages: ["com.tencent.mm", "com.xingin.xhs"],
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(apps.packages.length, 2);
  const recent = parseStructuredReadOutput("device.recent", JSON.stringify({
    machine: "02", status: "verified", verification: "single_recent_event_then_fresh_ui_change",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(recent.status, "verified");
  const coords = parseStructuredReadOutput("device.tap-coords", JSON.stringify({
    machine: "02", status: "verified",
    verification: "source_package_fast_rechecked_then_single_pointer_event_then_fresh_postcondition",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.doesNotMatch(JSON.stringify(coords), /"(?:x|y)"/u);
  const guide = parseStructuredReadOutput("device.guide", JSON.stringify({
    schemaVersion: 1, code: "UI_EMPTY", stage: "observe", automatic: true, terminal: false,
    next: [{
      strategy: "OCR_EXACT_NODE", status: "implemented",
      readCommand: "device.node.resolve", writeCommand: "device.node.activate",
    }],
    stopConditions: ["SENSITIVE_SURFACE"], protocol: "observe_resolve_recheck_execute_verify",
  }));
  assert.equal(guide.next[0].readCommand, "device.node.resolve");
  const resolved = parseStructuredReadOutput("device.node.resolve", JSON.stringify({
    machine: "03", status: "resolved",
    node: { label: "我", role: "tab", group: "bottom_navigation", ordinal: 4, source: "relation", unique: true },
    evidence: { foregroundPackageVerified: true, freshObservations: 2, coordinateExposed: false },
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(resolved.node.source, "relation");
  const visionResolved = parseStructuredReadOutput("device.node.resolve", JSON.stringify({
    ...resolved,
    node: { label: "我", role: "tab", group: null, ordinal: null, source: "vision", unique: true },
  }));
  assert.equal(visionResolved.node.source, "vision");
  assert.doesNotMatch(JSON.stringify(resolved), /"(?:serial|alias|deviceId|x|y|path|left|top|right|bottom)"/iu);
  const activated = parseStructuredReadOutput("device.node.activate", JSON.stringify({
    machine: "03", status: "verified",
    node: { label: "我", role: "tab", group: null, ordinal: null, source: "ocr", unique: true },
    verification: "node_rechecked_then_single_pointer_event_then_fresh_postcondition",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(activated.status, "verified");
  const dmSent = parseStructuredReadOutput("xhs.dm.send", JSON.stringify({
    machine: "01", status: "verified", draftLength: 2,
    verification: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_and_message_echo",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(dmSent.status, "verified");
  assert.throws(() => parseStructuredReadOutput("device.node.resolve", JSON.stringify({
    ...resolved, x: 900,
  })), /invalid public shape/u);
  const wallet = parseStructuredReadOutput("wechat.wallet-balance", JSON.stringify({
    machine: "04", currency: "CNY", balance: "12.30",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.deepEqual(wallet, {
    machine: "04", currency: "CNY", balance: "12.30",
    transport: "xiaowei-api", localAdbRequired: false,
  });
  const xhs = parseStructuredReadOutput("xhs.observe", JSON.stringify({
    machine: "04",
    page: { state: "HOME_FEED", score: 1, margin: 0.5 },
    notes: [{ title: "公开标题", author: "公开作者", mediaType: "image", metrics: { likes: "12" }, ordinal: 1 }],
    detail: null,
    profile: null,
    visibleLabels: ["公开话题"],
    stability: "two_fresh_ui_intersection",
    transport: "xiaowei-api",
    localAdbRequired: false,
  }));
  assert.equal(xhs.notes[0].title, "公开标题");
  assert.doesNotMatch(JSON.stringify(xhs), /serial|alias|deviceId|消息|未读/iu);
  const searchResults = parseStructuredReadOutput("xhs.observe", JSON.stringify({
    ...xhs,
    page: { state: "SEARCH_RESULTS", score: 0.9, margin: 0.2 },
  }));
  assert.equal(searchResults.page.state, "SEARCH_RESULTS");
  assert.throws(() => parseStructuredReadOutput("xhs.observe", JSON.stringify({
    ...xhs,
    serial: "private-identifier",
  })), /invalid public shape/u);
  const videoDetail = parseStructuredReadOutput("xhs.observe", JSON.stringify({
    ...xhs,
    page: { state: "VIDEO_NOTE", score: 1, margin: 0.5 },
    notes: [],
    detail: {
      title: "公开视频", author: "公开作者", body: "", publishedAtOrRegion: "",
      media: { type: "video", count: 1 }, metrics: { likes: "12", favorites: null, comments: "3" },
    },
    stability: "single_fresh_video_detail_ui",
  }));
  assert.equal(videoDetail.page.state, "VIDEO_NOTE");
  const foundVideo = parseStructuredReadOutput("xhs.find-video", JSON.stringify({
    machine: "04", status: "found", page: { state: "HOME_FEED", score: 1, margin: 0.5 },
    note: { title: "公开视频", author: "公开作者", mediaType: "video", metrics: { likes: "12" }, ordinal: 2 },
    ordinal: 2, scrolls: 1, elapsedMs: 4500,
    verification: "fresh_home_feed_ui_after_each_scroll", transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(foundVideo.ordinal, 2);
  const opened = parseStructuredReadOutput("xhs.open-visible", JSON.stringify({
    ...xhs,
    selected: { ordinal: 1, title: "公开标题", author: "公开作者", mediaType: "image" },
    page: { state: "IMAGE_NOTE", score: 1, margin: 0.5 },
    detail: {
      title: "公开标题", author: "公开作者", body: "公开正文", publishedAtOrRegion: "07-10广西",
      media: { type: "image", count: 6 }, metrics: { likes: "12", favorites: null, comments: "3" },
    },
    stability: "single_fresh_matching_detail_ui",
    verification: "single_pointer_event_then_fresh_matching_detail_ui",
  }));
  assert.equal(opened.detail.body, "公开正文");
  const commented = parseStructuredReadOutput("xhs.comment-emoji", JSON.stringify({
    machine: "01", status: "verified", beforeCount: 192, afterCount: 193,
    verification: "emoji_selected_then_package_bound_send_then_comment_count_increment_and_draft_clear",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(commented.afterCount, 193);
  const commentOpened = parseStructuredReadOutput("xhs.comment.open", JSON.stringify({
    machine: "01", status: "verified", commentCount: 192,
    target: { title: "测试帖子", author: "测试作者", mediaType: "image" },
    editorStateHash: "a".repeat(64),
    verification: "comment_box_rechecked_then_single_activation_then_editor_verified",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(commentOpened.commentCount, 192);
  const commentInput = parseStructuredReadOutput("xhs.comment.input", JSON.stringify({
    machine: "01", status: "verified", inputMethod: "shortcut", draftLength: 5,
    verification: "xhs_comment_draft_exact_ui_echo", transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(commentInput.inputMethod, "shortcut");
  const replyInput = parseStructuredReadOutput("xhs.comment.reply-input", JSON.stringify({
    machine: "04", status: "verified", inputMethod: "ime", draftLength: 4, commentCount: 18,
    editorStateHash: "b".repeat(64), replyOrdinal: 2,
    verification: "reply_target_rechecked_then_editor_recovered_after_ime_then_bound_draft_echo",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(replyInput.replyOrdinal, 2);
  const commentSent = parseStructuredReadOutput("xhs.comment.send", JSON.stringify({
    machine: "01", status: "verified", beforeCount: 192, afterCount: 193,
    verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(commentSent.afterCount, 193);
  assert.throws(() => parseStructuredReadOutput("xhs.open-visible", JSON.stringify({
    ...opened,
    selected: { ...opened.selected, x: 100 },
  })), /invalid public shape/u);
  assert.throws(() => parseStructuredReadOutput("wechat.wallet-balance", JSON.stringify({
    machine: "04", currency: "CNY", balance: "12.30", screenshotPath: "private",
    transport: "xiaowei-api", localAdbRequired: false,
  })), /invalid public shape/u);
  assert.throws(
    () => parseStructuredReadOutput("device.list", JSON.stringify([{
      machine: "02", name: "phone 02", online: true, alias: "internal",
      transport: "xiaowei-private-api", localAdbRequired: false,
    }])),
    /invalid public shape/u,
  );
});

test("HTTP device list and size return direct redacted business payloads", async () => {
  const server = createRemoteGateway({
    execute: async (argv) => ({
      code: 0,
      timedOut: false,
      truncated: false,
      stdout: JSON.stringify(argv[1] === "list" ? [{
        machine: "02", name: "phone 02", online: true,
        transport: "xiaowei-private-api", localAdbRequired: false,
      }] : {
        machine: "02", width: 1080, height: 2400,
        transport: "xiaowei-private-api", localAdbRequired: false,
      }),
      stderr: "",
    }),
    audit: () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1/command`;
    const listResponse = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "device.list" }),
    });
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), [{
      machine: "02", name: "phone 02", online: true,
      transport: "xiaowei-private-api", localAdbRequired: false,
    }]);
    const sizeResponse = await fetch(base, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "device.size", machine: "02" }),
    });
    assert.equal(sizeResponse.status, 200);
    const size = await sizeResponse.json();
    assert.deepEqual(Object.keys(size), ["machine", "width", "height", "transport", "localAdbRequired"]);
    assert.doesNotMatch(JSON.stringify(size), /serial|deviceId|alias/iu);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("remote development invoke remains structured and shell-free", () => {
  assert.deepEqual(buildRemoteArgv({
    command: "dev.invoke", action: "adb_shell", machine: "04", data: { command: "getprop" },
  }), [
    "dev", "invoke", "--action", "adb_shell", "--machine", "04", "--data-json", "{\"command\":\"getprop\"}",
  ]);
  assert.throws(() => buildRemoteArgv({ command: "dev.invoke", action: "../exec", all: true }), /action is invalid/u);
  assert.throws(() => buildRemoteArgv({ command: "dev.invoke", action: "adb", all: true, machine: "04" }), /not both/u);
  const privateArgv = buildRemoteArgv({ command: "private.invoke", privateCommand: "reconnect_device", args: { serial: "opaque" } });
  assert.deepEqual(privateArgv.slice(0, 5), ["dev", "private-invoke", "--command", "reconnect_device", "--args-base64"]);
  assert.deepEqual(JSON.parse(Buffer.from(privateArgv[5], "base64").toString("utf8")), { serial: "opaque" });
  assert.throws(() => buildRemoteArgv({ command: "private.invoke", privateCommand: "../exec", args: {} }), /privateCommand is invalid/u);
});

test("remote local-change commands preserve the existing confirmation contract", () => {
  assert.deepEqual(buildRemoteArgv({
    command: "device.settings", machine: "01", reason: "development acceptance", rollback: "press device back",
  }), [
    "device", "settings", "--machine", "01", "--confirm", "--reason", "development acceptance", "--rollback", "press device back",
  ]);
  assert.throws(() => buildRemoteArgv({ command: "device.settings", machine: "01" }), /reason is invalid/u);
});

test("remote output redacts private identifiers and credentials", () => {
  const editorStateHash = "a".repeat(64);
  const json = sanitizeCommandOutput(JSON.stringify({
    serial: "ABC123", hierarchyPath: "C:\\private\\internal-alias\\window.xml",
    editorStateHash,
    nested: { token: "secret", alias: "internal-alias", value: 1 },
  }));
  assert.deepEqual(JSON.parse(json), {
    serial: "[redacted]", hierarchyPath: "[redacted]",
    hierarchyArtifact: { id: "85ba81be0738f562c5cafa4f", kind: "hierarchy" },
    editorStateHash,
    nested: { token: "[redacted]", alias: "[redacted]", value: 1 },
  });
  assert.deepEqual(extractPublicArtifactReferences(json), [{
    id: "85ba81be0738f562c5cafa4f", kind: "hierarchy",
  }]);
  const text = sanitizeCommandOutput("ABC12345 device product:test\nserial=ABC123");
  assert.doesNotMatch(text, /ABC123/u);
});

test("gateway status correlates machine, request, active task, artifact, and audit", async () => {
  const release = deferred();
  const started = deferred();
  const audits = [];
  const server = createRemoteGateway({
    execute: async () => {
      started.resolve();
      await release.promise;
      return {
        code: 0, timedOut: false, truncated: false,
        stdout: sanitizeCommandOutput(JSON.stringify({
          schemaVersion: 1,
          results: [{
            machine: "04", status: "success",
            screenshotPath: "C:\\private\\run-123\\device-04\\screen.png",
          }],
        })),
        stderr: "",
      };
    },
    audit: (event) => audits.push(event),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const commandPromise = fetch(`${root}/v1/command`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "device.screen", machine: "04" }),
    });
    await started.promise;
    const activeStatus = await (await fetch(`${root}/v1/status`)).json();
    assert.equal(activeStatus.active[0].machine, "04");
    assert.equal(activeStatus.active[0].command, "device.screen");
    assert.equal(activeStatus.devices[0].active.requestId, activeStatus.active[0].requestId);

    release.resolve();
    const response = await commandPromise;
    const requestId = response.headers.get("x-request-id");
    const body = await response.json();
    const stdout = JSON.parse(body.stdout);
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.equal(stdout.results[0].screenshotPath, "[redacted]");
    assert.match(stdout.results[0].screenshotArtifact.id, /^[a-f0-9]{24}$/u);

    const completedStatus = await (await fetch(`${root}/v1/status`)).json();
    assert.equal(completedStatus.devices[0].lastCompleted.requestId, requestId);
    assert.deepEqual(completedStatus.devices[0].latestArtifacts, [stdout.results[0].screenshotArtifact]);
    assert.equal(audits[0].machine, "04");
    assert.equal(audits[0].requestId, requestId);
    assert.deepEqual(audits[0].artifactRefs, [stdout.results[0].screenshotArtifact]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("development gateway permits unidentified tailnet nodes while strict mode remains available", async () => {
  const open = createRemoteGateway({
    execute: async () => ({ code: 0, timedOut: false, truncated: false, stdout: "ok", stderr: "" }),
    audit: () => {},
  });
  await new Promise((resolve) => open.listen(0, "127.0.0.1", resolve));
  const openPort = open.address().port;
  const openResponse = await fetch(`http://127.0.0.1:${openPort}/v1/command`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "host.status" }),
  });
  assert.equal(openResponse.status, 200);
  await new Promise((resolve) => open.close(resolve));

  const strict = createRemoteGateway({ requireIdentity: true, audit: () => {} });
  await new Promise((resolve) => strict.listen(0, "127.0.0.1", resolve));
  const strictPort = strict.address().port;
  const strictResponse = await fetch(`http://127.0.0.1:${strictPort}/v1/command`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "host.status" }),
  });
  assert.equal(strictResponse.status, 401);
  await new Promise((resolve) => strict.close(resolve));
});

test("gateway health proves the running build and boot instance", async () => {
  const buildId = "a".repeat(64);
  const bootId = "11111111-2222-4333-8444-555555555555";
  const server = createRemoteGateway({ buildId, bootId, audit: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "xhs-remote-gateway",
      queueDepth: 0,
      activeRequests: 0,
      accepting: true,
      buildId,
      bootId,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("authenticated loopback drain rejects new work and closes after queued work", async () => {
  const buildId = "b".repeat(64);
  const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const controlToken = "gateway-control-token-0123456789abcdef";
  let beginWork;
  const workStarted = new Promise((resolve) => { beginWork = resolve; });
  let releaseWork;
  const workBarrier = new Promise((resolve) => { releaseWork = resolve; });
  let shutdownComplete;
  const shutdown = new Promise((resolve) => { shutdownComplete = resolve; });
  const server = createRemoteGateway({
    buildId,
    bootId,
    controlToken,
    audit: () => {},
    onShutdown: shutdownComplete,
    execute: async () => {
      beginWork();
      await workBarrier;
      return { code: 0, timedOut: false, truncated: false, stdout: "ok", stderr: "" };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const command = fetch(`http://127.0.0.1:${port}/v1/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "host.status" }),
  });
  await workStarted;

  const denied = await fetch(`http://127.0.0.1:${port}/admin/drain-and-shutdown`, { method: "POST" });
  assert.equal(denied.status, 404);
  const accepted = await fetch(`http://127.0.0.1:${port}/admin/drain-and-shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${controlToken}` },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, draining: true, bootId });

  const rejected = await fetch(`http://127.0.0.1:${port}/v1/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "host.status" }),
  });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error, "gateway_draining");

  releaseWork();
  assert.equal((await command).status, 200);
  await shutdown;
});

test("remote gateway rejects non-UTF-8 JSON before command routing", async () => {
  let executed = false;
  const server = createRemoteGateway({
    execute: async () => { executed = true; return { code: 0, stdout: "", stderr: "" }; },
    audit: () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/command`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    assert.equal(response.status, 400);
    assert.equal(executed, false);
    assert.match((await response.json()).error, /valid UTF-8/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
