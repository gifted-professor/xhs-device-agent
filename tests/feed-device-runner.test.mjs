import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  AdbFeedAdapter,
  countUiDumpBytes,
  detailSurfaceStable,
  dominantPackage,
  extractHierarchyXml,
  extractPlaybackProgressSeconds,
  isPackageFocused,
  openedPageSkipReason,
  probePackageFocus,
  feedSurfaceStable,
  interactionMatch,
  interactionVerifiedAfterActivation,
  transientOverlayKind,
  visibleFeedCards,
} from "../scripts/feed-device-runner.mjs";
import { parseUiAutomatorXml } from "../scripts/xhs-page-engine.mjs";

function documentOf(body) {
  return parseUiAutomatorXml("<?xml version=\"1.0\"?><hierarchy>" + body + "</hierarchy>");
}

const VALID_UI_XML = "<?xml version=\"1.0\"?><hierarchy><node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" /></hierarchy>";

test("hierarchy extraction accepts complete dumps with or without an XML declaration", () => {
  assert.equal(extractHierarchyXml("noise\n" + VALID_UI_XML + "\ntrailer"), VALID_UI_XML);
  assert.equal(
    extractHierarchyXml("UI dump\n<hierarchy><node class=\"android.view.View\" /></hierarchy>\n"),
    "<hierarchy><node class=\"android.view.View\" /></hierarchy>",
  );
  assert.equal(extractHierarchyXml("UI hierchary dumped to: /sdcard/window.xml"), null);
});

test("UI capture falls back from a transient direct failure to the remote file dump", async () => {
  const adapter = new AdbFeedAdapter({
    adbPath: "unused-adb",
    serial: "test-device",
    deviceAlias: "device-test",
    rules: {},
    runDir: "run",
  });
  const commands = [];
  adapter.pause = async () => {};
  adapter.adb = (args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command === "exec-out uiautomator dump /dev/tty") {
      throw Object.assign(new Error("transient timeout"), { code: "ADB_COMMAND_FAILED" });
    }
    if (command === "exec-out cat /sdcard/xhs_feed_window.xml") return VALID_UI_XML;
    return "";
  };

  const result = await adapter.captureUiHierarchy();
  assert.equal(result.source, "remote-file");
  assert.equal(result.document.nodes.length, 1);
  assert.deepEqual(commands, [
    "exec-out uiautomator dump /dev/tty",
    "shell rm -f /sdcard/xhs_feed_window.xml",
    "shell uiautomator dump /sdcard/xhs_feed_window.xml",
    "exec-out cat /sdcard/xhs_feed_window.xml",
    "shell rm -f /sdcard/xhs_feed_window.xml",
  ]);
});

test("UI capture retries direct mode after an invalid remote file and then stops honestly", async () => {
  const adapter = new AdbFeedAdapter({
    adbPath: "unused-adb",
    serial: "test-device",
    deviceAlias: "device-test",
    rules: {},
    runDir: "run",
  });
  let directAttempts = 0;
  adapter.pause = async () => {};
  adapter.adb = (args) => {
    const command = args.join(" ");
    if (command === "exec-out uiautomator dump /dev/tty") {
      directAttempts += 1;
      return directAttempts === 2 ? VALID_UI_XML : "incomplete";
    }
    return "";
  };
  const recovered = await adapter.captureUiHierarchy();
  assert.equal(recovered.source, "direct-final");

  directAttempts = 0;
  adapter.adb = () => "incomplete";
  await assert.rejects(
    adapter.captureUiHierarchy(),
    (error) => error.code === "UI_DUMP_INVALID" && error.attempts === 3,
  );
});

test("feed card discovery uses a scrollable semantic container and stable public identity", () => {
  const document = documentOf(
    "<node class=\"androidx.recyclerview.widget.RecyclerView\" resource-id=\"com.xingin.xhs:id/home_feed\" scrollable=\"true\" bounds=\"[0,100][1080,2200]\">" +
      "<node class=\"android.widget.FrameLayout\" content-desc=\"笔记  夏日城市散步路线 来自公开作者 12赞\" clickable=\"false\" enabled=\"true\" bounds=\"[20,140][520,1040]\">" +
        "<node class=\"android.widget.FrameLayout\" resource-id=\"com.xingin.xhs:id/0_resource_name_obfuscated\" clickable=\"true\" enabled=\"true\" bounds=\"[20,140][520,1040]\">" +
          "<node class=\"android.widget.ImageView\" resource-id=\"com.xingin.xhs:id/0_resource_name_obfuscated\" bounds=\"[20,140][520,780]\" />" +
        "</node>" +
      "</node>" +
      "<node class=\"android.widget.FrameLayout\" clickable=\"true\" enabled=\"true\" bounds=\"[560,140][1060,1040]\">" +
        "<node class=\"android.widget.TextView\" text=\"首页\" bounds=\"[580,800][800,900]\" />" +
      "</node>" +
    "</node>",
  );
  const result = visibleFeedCards(document);
  assert.equal(result.container.node.resourceId, "com.xingin.xhs:id/home_feed");
  assert.equal(result.cards.length, 1);
  assert.match(result.cards[0].identity, /^[a-f0-9]{32}$/u);
  assert.deepEqual(result.cards[0].tokens, ["夏日城市散步路线", "公开作者"]);
  assert.equal(result.cards[0].node.clickable, true);
  assert.equal(result.cards[0].node.attributes.bounds, "[20,140][520,1040]");
});

test("like and favorite controls expose inactive and active states without toggling", () => {
  const inactive = documentOf(
    "<node class=\"android.widget.ImageView\" resource-id=\"com.xingin.xhs:id/like\" content-desc=\"点赞\" clickable=\"true\" enabled=\"true\" bounds=\"[900,1200][1040,1340]\" />" +
    "<node class=\"android.widget.ImageView\" resource-id=\"com.xingin.xhs:id/collect\" content-desc=\"收藏\" clickable=\"true\" enabled=\"true\" bounds=\"[900,1400][1040,1540]\" />",
  );
  assert.equal(interactionMatch(inactive, "like").active, false);
  assert.equal(interactionMatch(inactive, "favorite").active, false);

  const active = documentOf(
    "<node class=\"android.widget.ImageView\" resource-id=\"com.xingin.xhs:id/liked\" content-desc=\"取消点赞\" clickable=\"true\" enabled=\"true\" selected=\"true\" bounds=\"[900,1200][1040,1340]\" />" +
    "<node class=\"android.widget.ImageView\" resource-id=\"com.xingin.xhs:id/collected\" content-desc=\"取消收藏\" clickable=\"true\" enabled=\"true\" checked=\"true\" bounds=\"[900,1400][1040,1540]\" />",
  );
  assert.equal(interactionMatch(active, "like").active, true);
  assert.equal(interactionMatch(active, "favorite").active, true);
});

test("obfuscated video action row infers like and accepts favorite counts", () => {
  const document = documentOf(
    "<node class=\"android.widget.LinearLayout\" bounds=\"[41,2149][1066,2175]\">" +
      "<node class=\"android.widget.EditText\" clickable=\"true\" enabled=\"true\" bounds=\"[41,2149][519,2175]\" />" +
      "<node class=\"android.widget.LinearLayout\" clickable=\"true\" enabled=\"true\" bounds=\"[519,2149][700,2175]\">" +
        "<node class=\"android.widget.ImageView\" bounds=\"[530,2149][570,2175]\" />" +
        "<node class=\"android.widget.TextView\" text=\"378\" bounds=\"[580,2149][690,2175]\" />" +
      "</node>" +
      "<node class=\"android.widget.Button\" content-desc=\"收藏123\" clickable=\"true\" enabled=\"true\" bounds=\"[700,2149][906,2175]\" />" +
      "<node class=\"android.widget.Button\" content-desc=\"评论60\" clickable=\"true\" enabled=\"true\" bounds=\"[906,2149][1066,2175]\" />" +
    "</node>",
  );
  const like = interactionMatch(document, "like");
  const favorite = interactionMatch(document, "favorite");
  assert.equal(like.inferred, true);
  assert.equal(like.count, 378);
  assert.equal(like.node.attributes.bounds, "[519,2149][700,2175]");
  assert.equal(favorite.count, 123);
  assert.equal(favorite.node.attributes.bounds, "[700,2149][906,2175]");
});

test("action verification accepts an active state or an increased counter", () => {
  assert.equal(interactionVerifiedAfterActivation({ count: 378 }, { active: false, count: 379 }), true);
  assert.equal(interactionVerifiedAfterActivation({ count: 378 }, { active: true, count: 378 }), true);
  assert.equal(interactionVerifiedAfterActivation({ count: 378 }, { active: false, count: 378 }), false);
  assert.equal(interactionVerifiedAfterActivation({ count: null }, { active: false, count: 379 }), false);
});

test("the in-app rating prompt is recognized as a dismissible transient overlay", () => {
  const rating = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\">" +
      "<node class=\"android.widget.TextView\" text=\"您对小红书的评分如何?\" />" +
      "<node class=\"android.widget.TextView\" text=\"轻按星星对我们进行评价：1 到 5 颗星\" />" +
    "</node>",
  );
  assert.equal(transientOverlayKind(rating), "app_rating");
  assert.equal(transientOverlayKind(documentOf("<node text=\"普通笔记\" />")), null);
});

test("dynamic feed stability requires a persistent card identity in the XHS foreground", () => {
  const first = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"androidx.recyclerview.widget.RecyclerView\" scrollable=\"true\" bounds=\"[0,100][1080,2200]\">" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" content-desc=\"笔记  同一篇内容 来自公开作者 12赞\" bounds=\"[20,140][520,1040]\">" +
        "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" clickable=\"true\" enabled=\"true\" bounds=\"[20,140][520,1040]\" />" +
      "</node>" +
    "</node>",
  );
  const second = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"androidx.recyclerview.widget.RecyclerView\" scrollable=\"true\" bounds=\"[0,100][1080,2200]\">" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" content-desc=\"笔记  同一篇内容 来自公开作者 99赞\" bounds=\"[20,140][520,1040]\">" +
        "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" clickable=\"true\" enabled=\"true\" bounds=\"[20,140][520,1040]\" />" +
      "</node>" +
    "</node>",
  );
  const launcher = documentOf(
    "<node package=\"com.miui.home\" class=\"android.widget.FrameLayout\" bounds=\"[0,0][1080,2200]\">" +
      "<node package=\"com.miui.home\" class=\"android.widget.TextView\" text=\"小红书\" bounds=\"[20,140][520,1040]\" />" +
    "</node>",
  );
  assert.equal(dominantPackage(first), "com.xingin.xhs");
  assert.equal(dominantPackage(launcher), "com.miui.home");
  assert.equal(feedSurfaceStable({ document: first }, { document: second }), true);
  assert.equal(feedSurfaceStable({ document: first }, { document: launcher }), false);
});

function dynamicVideoSnapshot(author, title, progress, fingerprint) {
  const document = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\">" +
      "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/matrixNickNameView\" class=\"android.widget.TextView\" text=\"" + author + "\" />" +
      "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/noteContentText\" class=\"android.widget.TextView\" text=\"" + title + "\" />" +
      "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/video_progress\" class=\"android.widget.TextView\" text=\"" + progress + " / 03:51\" />" +
    "</node>",
  );
  return {
    document,
    classification: { state: "VIDEO_NOTE", safety: {} },
    foregroundPackage: "com.xingin.xhs",
    fingerprint,
  };
}

test("dynamic detail stability keeps identity while ignoring playback progress changes", () => {
  const first = dynamicVideoSnapshot("public author", "weekly outfit guide", "00:17", "fingerprint-1");
  const second = dynamicVideoSnapshot("public author", "weekly outfit guide", "00:21", "fingerprint-2");
  const other = dynamicVideoSnapshot("different author", "different post", "00:21", "fingerprint-3");
  assert.equal(detailSurfaceStable(first, second), true);
  assert.equal(detailSurfaceStable(first, other), false);
});

test("stable UI obtains a second detail sample even when the nominal timeout is exhausted", async () => {
  const { adapter } = startupAdapter();
  const samples = [
    dynamicVideoSnapshot("public author", "weekly outfit guide", "00:17", "fingerprint-1"),
    dynamicVideoSnapshot("public author", "weekly outfit guide", "00:21", "fingerprint-2"),
  ];
  let reads = 0;
  adapter.readUi = async () => samples[reads++];
  adapter.pause = async () => {};
  const result = await adapter.stableUi("dynamic-video", 0);
  assert.equal(result, samples[1]);
  assert.equal(reads, 2);
});

test("video progress extraction uses semantic progress controls and ignores ordinary clocks", () => {
  const exposed = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"android.widget.TextView\" resource-id=\"com.xingin.xhs:id/video_progress\" text=\"00:12 / 01:30\" />" +
    "<node package=\"com.xingin.xhs\" class=\"android.widget.TextView\" text=\"18:45\" />",
  );
  const hidden = documentOf(
    "<node package=\"com.xingin.xhs\" class=\"android.widget.TextView\" text=\"18:45\" />",
  );
  assert.equal(extractPlaybackProgressSeconds(exposed), 12);
  assert.equal(extractPlaybackProgressSeconds(hidden), null);
});

test("foreground verification ignores stale non-focused XHS windows", () => {
  const desktopFocused = `Window #1 Window{abc u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivity}
    mCurrentFocus=Window{def u0 com.miui.home/com.miui.home.launcher.Launcher}
    mFocusedApp=ActivityRecord{ghi u0 com.miui.home/.launcher.Launcher}`;
  const xhsFocused = "mCurrentFocus=Window{abc u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivity}";
  const activityFocused = "topResumedActivity=ActivityRecord{abc u0 com.xingin.xhs/.index.v2.IndexActivity t42}";
  assert.equal(isPackageFocused(desktopFocused), false);
  assert.equal(isPackageFocused(xhsFocused), true);
  assert.equal(isPackageFocused(activityFocused), true);
  assert.equal(isPackageFocused("mCurrentFocus=null\nmFocusedApp=null"), false);
});

test("foreground probing uses the full window dump supported by the current ROM", () => {
  const commands = [];
  const result = probePackageFocus((args) => {
    commands.push(args.join(" "));
    return "mCurrentFocus=Window{abc u0 com.xingin.xhs/com.xingin.xhs.index.v2.IndexActivity}";
  });
  assert.deepEqual(result, { focused: true, probe: "shell dumpsys window" });
  assert.deepEqual(commands, ["shell dumpsys window"]);
});

test("foreground probing falls back across Android focus formats", () => {
  const commands = [];
  const result = probePackageFocus((args) => {
    const command = args.join(" ");
    commands.push(command);
    if (command === "shell dumpsys window") return "mCurrentFocus=null\nmFocusedApp=null";
    if (command === "shell dumpsys activity activities") {
      return "topResumedActivity=ActivityRecord{abc u0 com.xingin.xhs/.index.v2.IndexActivity t42}";
    }
    throw new Error("legacy probe should not be needed");
  });
  assert.equal(result.focused, true);
  assert.deepEqual(commands, ["shell dumpsys window", "shell dumpsys activity activities"]);
});

test("a commercial CTA on an unsupported XHS detail is marked for a recoverable skip", () => {
  const document = documentOf(
    "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/noteContentLayout\" class=\"android.widget.LinearLayout\">" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" content-desc=\"图片,第1张,共5张\" />" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.TextView\" text=\"立即下载\" />" +
    "</node>",
  );
  assert.equal(openedPageSkipReason({ document, classification: { state: "UNKNOWN" } }), "commercial_cta");
  assert.equal(openedPageSkipReason({ document, classification: { state: "HOME_FEED" } }), "card_did_not_open");
  assert.equal(
    openedPageSkipReason({ document: documentOf("<node class=\"android.widget.FrameLayout\" />"), classification: { state: "UNKNOWN" } }),
    "unsupported_unknown_page",
  );
});

test("opening a stable unsupported commercial detail returns to feed and skips that candidate", async () => {
  const feedDocument = documentOf(
    "<node class=\"androidx.recyclerview.widget.RecyclerView\" resource-id=\"com.xingin.xhs:id/home_feed\" scrollable=\"true\" bounds=\"[0,100][1080,2200]\">" +
      "<node class=\"android.widget.FrameLayout\" resource-id=\"com.xingin.xhs:id/note_card\" clickable=\"true\" enabled=\"true\" bounds=\"[20,140][520,1040]\">" +
        "<node class=\"android.widget.TextView\" text=\"summer outfit guide\" bounds=\"[40,780][480,840]\" />" +
        "<node class=\"android.widget.TextView\" text=\"public author\" bounds=\"[40,850][480,910]\" />" +
      "</node>" +
    "</node>",
  );
  const detailDocument = documentOf(
    "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/noteContentLayout\" class=\"android.widget.LinearLayout\">" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" content-desc=\"image 1 of 5\" />" +
      "<node package=\"com.xingin.xhs\" class=\"android.widget.TextView\" text=\"Download now\" />" +
    "</node>",
  );
  const feed = { document: feedDocument, classification: { state: "HOME_FEED", safety: {} }, path: "feed.xml", foregroundPackage: "com.xingin.xhs" };
  const detail = { document: detailDocument, classification: { state: "UNKNOWN", safety: {} }, path: "detail.xml", foregroundPackage: "com.xingin.xhs" };
  const adapter = new AdbFeedAdapter({
    adbPath: "unused-adb",
    serial: "test-device",
    deviceAlias: "device-test",
    rules: {},
    runDir: "run",
  });
  const stages = [];
  adapter.stableUi = async (stage) => {
    stages.push(stage);
    return feed;
  };
  adapter.stableUiWhileTransitioning = async () => ({
    sample: detail,
    attempts: 2,
    rawBytes: 512,
    parseError: null,
  });
  adapter.tapNode = () => {};
  adapter.pause = async () => {};
  adapter.captureScreenshot = async () => null;
  let backCount = 0;
  adapter.backToFeed = async () => {
    backCount += 1;
    return { ...feed, path: "returned.xml" };
  };
  adapter.backToFeedOptional = async () => {
    backCount += 1;
    return { snapshot: { ...feed, path: "returned.xml" }, returnedToFeed: true };
  };

  const result = await adapter.openNextUnique(new Set(), 6);
  assert.equal(result.skipped, true);
  assert.equal(result.pageState, "UNKNOWN");
  assert.equal(result.reason, "commercial_cta");
  assert.equal(result.evidence.unsupported, "../detail.xml");
  assert.equal(backCount, 1);
  assert.equal(result.evidence.detailVisited, true);
  assert.deepEqual(stages, ["item-6-feed"]);
});

function feedFixture({ state = "HOME_FEED", path = "feed.xml", text = "" } = {}) {
  return {
    document: documentOf(
      "<node package=\"com.xingin.xhs\" class=\"androidx.recyclerview.widget.RecyclerView\" resource-id=\"com.xingin.xhs:id/home_feed\" scrollable=\"true\" bounds=\"[0,100][1080,2200]\">" +
        "<node class=\"android.widget.FrameLayout\" resource-id=\"com.xingin.xhs:id/note_card\" clickable=\"true\" enabled=\"true\" bounds=\"[20,140][520,1040]\">" +
          "<node class=\"android.widget.TextView\" text=\"summer outfit guide\" bounds=\"[40,780][480,840]\" />" +
          "<node class=\"android.widget.TextView\" text=\"public author\" bounds=\"[40,850][480,910]\" />" +
        "</node>" +
      "</node>",
    ),
    classification: { state, safety: {} },
    path,
    foregroundPackage: "com.xingin.xhs",
  };
}

function detailFixture({ state, path = "detail.xml", title = "summer outfit guide" } = {}) {
  const xml =
    "<hierarchy>" +
      "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/noteContentLayout\" class=\"android.widget.LinearLayout\">" +
        "<node package=\"com.xingin.xhs\" resource-id=\"com.xingin.xhs:id/noteContentText\" class=\"android.widget.TextView\" text=\"" + title + "\" />" +
      "</node>" +
    "</hierarchy>";
  return {
    xml,
    document: parseUiAutomatorXml(xml),
    classification: { state, safety: {} },
    path,
    foregroundPackage: "com.xingin.xhs",
    rawBytes: countUiDumpBytes(xml),
  };
}

function stubAdapter() {
  const adapter = new AdbFeedAdapter({
    adbPath: "unused-adb",
    serial: "test-device",
    deviceAlias: "device-test",
    rules: {},
    runDir: "run",
  });
  adapter.pause = async () => {};
  adapter.captureScreenshot = async () => null;
  return adapter;
}

test("openNextUnique tolerates three invalid UI dumps during transition then classifies a video detail", async () => {
  const adapter = stubAdapter();
  const feed = feedFixture({});
  const video = detailFixture({ state: "VIDEO_NOTE" });
  let transitionAttempts = 0;
  adapter.stableUi = async () => feed;
  adapter.readUi = async (stage) => {
    if (stage === "item-1-detail") {
      transitionAttempts += 1;
      if (transitionAttempts <= 3) {
        throw Object.assign(new Error("incomplete"), { code: "UI_DUMP_INVALID" });
      }
      return video;
    }
    return feed;
  };
  adapter.tapNode = () => {};
  adapter.backToFeed = async () => feed;

  const result = await adapter.openNextUnique(new Set(), 1);
  assert.equal(result.pageType, "VIDEO_NOTE");
  assert.equal(result.evidence.detailTransitionAttempts, 4);
  assert.equal(result.evidence.contentKind, "VIDEO_NOTE");
  assert.equal(result.evidence.detailVisited, true);
  assert.equal(result.evidence.returnedToList, false);
  assert.equal(result.evidence.uiDumpRawBytes, countUiDumpBytes(video.xml));
  assert.equal(result.evidence.uiDumpParseError, null);
});

test("detail transition reports the full bounded budget when only a non-detail sample is readable", async () => {
  const adapter = stubAdapter();
  const unknown = detailFixture({ state: "UNKNOWN" });
  let attempts = 0;
  adapter.readUi = async () => {
    attempts += 1;
    if (attempts === 1) return unknown;
    throw Object.assign(new Error("incomplete"), { code: "UI_DUMP_INVALID" });
  };

  const result = await adapter.stableUiWhileTransitioning("item-1-detail");
  assert.equal(attempts, 5);
  assert.equal(result.attempts, 5);
  assert.equal(result.sample.classification.state, "UNKNOWN");
});

test("openNextUnique stops without repeated Back on an ambiguous return state", async () => {
  const adapter = stubAdapter();
  const feed = feedFixture({});
  const detail = detailFixture({ state: "UNKNOWN" });
  let backCalls = 0;
  adapter.stableUi = async () => feed;
  adapter.stableUiWhileTransitioning = async () => ({
    sample: detail,
    attempts: 5,
    rawBytes: countUiDumpBytes(detail.xml),
    parseError: null,
  });
  adapter.tapNode = () => {};
  adapter.backToFeedOptional = async (stage) => {
    backCalls += 1;
    return { snapshot: { ...detail, path: stage + ".xml" }, returnedToFeed: false };
  };

  await assert.rejects(
    adapter.openNextUnique(new Set(), 1),
    (error) => error.code === "RETURN_TO_FEED_FAILED",
  );
  assert.equal(backCalls, 1);
});

test("openNextUnique continues normal flow for image notes", async () => {
  const adapter = stubAdapter();
  const feed = feedFixture({});
  const image = detailFixture({ state: "IMAGE_NOTE" });
  adapter.stableUi = async () => feed;
  adapter.stableUiWhileTransitioning = async () => ({
    sample: image,
    attempts: 1,
    rawBytes: countUiDumpBytes(image.xml),
    parseError: null,
  });
  adapter.tapNode = () => {};
  adapter.backToFeed = async () => feed;

  const result = await adapter.openNextUnique(new Set(), 1);
  assert.equal(result.pageType, "IMAGE_NOTE");
  assert.equal(result.evidence.contentKind, "IMAGE_NOTE");
  assert.equal(result.evidence.detailVisited, true);
});

function startupAdapter() {
  const adapter = new AdbFeedAdapter({
    adbPath: "unused-adb",
    serial: "test-device",
    deviceAlias: "device-test",
    rules: {},
    runDir: "run",
  });
  const commands = [];
  adapter.initializeContext = async () => {};
  adapter.pause = async () => {};
  adapter.adb = (args) => {
    commands.push(args.join(" "));
    return "";
  };
  return { adapter, commands };
}

function startupSnapshot(state, filePath) {
  return {
    document: documentOf("<node package=\"com.xingin.xhs\" class=\"android.widget.FrameLayout\" />"),
    classification: { state, safety: {} },
    path: filePath,
  };
}

test("feed startup keeps an already verified home page without relaunching", async () => {
  const { adapter, commands } = startupAdapter();
  const home = startupSnapshot("HOME_FEED", "home.xml");
  const stages = [];
  adapter.stableUi = async (stage) => {
    stages.push(stage);
    return home;
  };

  const result = await adapter.ensureFeed();
  assert.equal(result.verified, true);
  assert.equal(result.evidence.feedEntry, "../home.xml");
  assert.deepEqual(stages, ["feed-entry-current"]);
  assert.deepEqual(commands, []);
});

test("feed startup backs out of a leftover detail before considering relaunch", async () => {
  const { adapter, commands } = startupAdapter();
  const detail = startupSnapshot("UNKNOWN", "detail.xml");
  const home = startupSnapshot("HOME_FEED", "home.xml");
  const stages = [];
  adapter.stableUi = async (stage) => {
    stages.push(stage);
    return stage === "feed-entry-current" || stage === "feed-entry-current-back-1" ? detail : home;
  };

  const result = await adapter.ensureFeed();
  assert.equal(result.verified, true);
  assert.deepEqual(stages, ["feed-entry-current", "feed-entry-current-back-1", "feed-entry-current-back-2"]);
  assert.deepEqual(commands, ["shell input keyevent KEYCODE_BACK", "shell input keyevent KEYCODE_BACK"]);
});

test("feed startup relaunches XHS when BACK leaves the app, then verifies home", async () => {
  const { adapter, commands } = startupAdapter();
  const detail = startupSnapshot("UNKNOWN", "detail.xml");
  const home = startupSnapshot("HOME_FEED", "home.xml");
  const stages = [];
  adapter.stableUi = async (stage) => {
    stages.push(stage);
    if (stage === "feed-entry-current") return detail;
    if (stage === "feed-entry-current-back-1") {
      throw Object.assign(new Error("launcher"), { code: "APP_LEFT_FOREGROUND" });
    }
    return home;
  };

  const result = await adapter.ensureFeed();
  assert.equal(result.verified, true);
  assert.deepEqual(stages, ["feed-entry-current", "feed-entry-current-back-1", "feed-entry-launch-1"]);
  assert.deepEqual(commands, [
    "shell input keyevent KEYCODE_BACK",
    "shell monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1",
  ]);
});

test("feed startup auto-recovers from a residual video detail without counting it", async () => {
  const { adapter, commands } = startupAdapter();
  const detail = startupSnapshot("VIDEO_NOTE", "detail.xml");
  const home = startupSnapshot("HOME_FEED", "home.xml");
  const stages = [];
  adapter.stableUi = async (stage) => {
    stages.push(stage);
    return stage === "feed-entry-current" ? detail : home;
  };

  const result = await adapter.ensureFeed();
  assert.equal(result.verified, true);
  assert.equal(result.evidence.feedEntry, "../home.xml");
  assert.deepEqual(stages, ["feed-entry-current", "feed-entry-current-back-1"]);
  assert.deepEqual(commands, ["shell input keyevent KEYCODE_BACK"]);
});

test("feed startup stops after one Back when a residual detail cannot return home", async () => {
  const { adapter, commands } = startupAdapter();
  const detail = startupSnapshot("VIDEO_NOTE", "detail.xml");
  adapter.stableUi = async () => detail;

  await assert.rejects(
    adapter.ensureFeed(),
    (error) => error.code === "RESIDUAL_DETAIL",
  );
  assert.deepEqual(commands, ["shell input keyevent KEYCODE_BACK"]);
});
