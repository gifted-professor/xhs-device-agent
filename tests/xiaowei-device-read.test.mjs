import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPublicDeviceList,
  extractSingleDeviceValue,
  extractUiHierarchy,
  findSemanticTapPoint,
  inspectPng,
  hierarchyContainsPackage,
  inferWechatMeBounds,
  packageInventoryContains,
  parsePrivateSize,
  runXiaoweiDeviceRead,
  uniqueAccessibilityBounds,
} from "../scripts/xiaowei-device-read.mjs";

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SCREEN_PNG = Buffer.from(VALID_PNG);
SCREEN_PNG.writeUInt32BE(1080, 16);
SCREEN_PNG.writeUInt32BE(2400, 20);

function target() {
  return { machine: "02", name: "phone 02", alias: "device-public", serial: "secret-device-identifier" };
}

test("UI extraction ignores vendor warnings and device-key identifiers", () => {
  const raw = {
    "secret-device-identifier": "vendor warning\n<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy><node text=\"ok\" /></hierarchy>\nUI hierarchy dumped",
  };
  const hierarchy = extractUiHierarchy(extractSingleDeviceValue(raw));
  assert.match(hierarchy, /^<\?xml/u);
  assert.match(hierarchy, /<node text="ok"/u);
  assert.doesNotMatch(hierarchy, /secret-device-identifier|vendor warning/u);
});

test("incomplete UI extraction reports only bounded structural diagnostics", () => {
  assert.throws(
    () => extractUiHierarchy('<hierarchy><node text="private page text" />'),
    (error) => error.code === "UI_HIERARCHY_INCOMPLETE"
      && /bytes=|hasStart=true|hasEnd=false|sha256=/u.test(error.message)
      && !error.message.includes("private page text"),
  );
});

test("device UI falls back to a pulled device-side XML artifact when tty output is truncated", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-read-ui-file-fallback-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-ui-file-fallback");
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" text="video" /></hierarchy>\n';
  const actions = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "ui", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        actions.push({ action: request.action, command: request.data?.command });
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, hierarchy);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy.slice(0, -14) } };
        }
        if (request.data?.command?.startsWith("uiautomator dump --compressed /sdcard/xhs-agent-ui-")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "UI hierarchy dumped" } };
        }
        if (request.data?.command?.startsWith("if [ -s /sdcard/xhs-agent-ui-")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(Buffer.byteLength(hierarchy)) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
    });
    assert.equal(result.success, 1);
    assert.equal(result.results[0].verification, "complete_xml_artifact");
    assert.equal(await readFile(result.results[0].hierarchyPath, "utf8"), hierarchy);
    assert.deepEqual(actions.map(({ action }) => action), ["adb_shell", "adb_shell", "adb_shell", "pullFile", "adb_shell"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("PNG inspection requires a structured image with bounded dimensions", () => {
  assert.deepEqual(inspectPng(VALID_PNG), { width: 1, height: 1, bytes: VALID_PNG.length });
  assert.throws(() => inspectPng(Buffer.from("not a png")), /valid PNG/u);
});

test("device list allows every accepted Xiaowei machine to be online without local ADB or identifier disclosure", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-read-list-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-list");
  try {
    const result = await runXiaoweiDeviceRead({
      action: "list", privateEndpoint: "http://127.0.0.1:9223", outputRoot, targets: [
        { machine: "01", name: "phone 01", alias: "device-one", serial: "connected-one" },
        target(),
        { machine: "03", name: "phone 03", alias: "device-other", serial: "configured-other" },
        { machine: "04", name: "phone 04", alias: "device-four", serial: "connected-four" },
      ],
    }, {
      projectRoot,
      invokePrivateCommand: async (command, args) => {
        assert.equal(command, "get_device_list");
        assert.deepEqual(args, {});
        return {
          value: { data: [
            { serial: "connected-one" },
            { serial: "secret-device-identifier", deviceId: "vendor-private-id" },
            { serial: "configured-other" },
            { serial: "connected-four" },
            { serial: "unmapped-private-identifier" },
          ] },
        };
      },
    });
    assert.deepEqual(result, [
      {
        machine: "01", name: "phone 01", online: true,
        transport: "xiaowei-private-api", localAdbRequired: false,
      },
      {
        machine: "02", name: "phone 02", online: true,
        transport: "xiaowei-private-api", localAdbRequired: false,
      },
      {
        machine: "03", name: "phone 03", online: true,
        transport: "xiaowei-private-api", localAdbRequired: false,
      },
      {
        machine: "04", name: "phone 04", online: true,
        transport: "xiaowei-private-api", localAdbRequired: false,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /secret|serial|deviceId|alias/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device list fails closed for duplicate, unmapped, and identity-drifted records", () => {
  const records = [
    { serial: "secret-device-identifier" },
    { onlySerial: "secret-device-identifier" },
    { serial: "unmapped-private-identifier" },
    { serial: "conflict-a", onlySerial: "conflict-b" },
  ];
  const result = buildPublicDeviceList(records, [
    target(),
    {
      machine: "03", name: "phone 03", alias: "device-other",
      serial: "configured-other", acceptedSerial: "secret-device-identifier",
    },
  ]);
  assert.deepEqual(result.map(({ machine, online }) => ({ machine, online })), [
    { machine: "02", online: false },
    { machine: "03", online: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|unmapped|configured|stale|alias/iu);

  const duplicateAcceptance = buildPublicDeviceList([{ serial: "accepted-once" }], [
    { machine: "02", name: "phone 02", alias: "device-a", serial: "accepted-once" },
    {
      machine: "03", name: "phone 03", alias: "device-b",
      serial: "configured-other", acceptedSerial: "accepted-once",
    },
  ]);
  assert.deepEqual(duplicateAcceptance.map(({ machine, online }) => ({ machine, online })), [
    { machine: "02", online: false },
    { machine: "03", online: false },
  ]);

  const drift = buildPublicDeviceList([{ serial: "configured-drift" }], [{
    machine: "04", name: "phone 04", alias: "device-drift",
    serial: "configured-drift", acceptedSerial: "stale-drift",
  }]);
  assert.equal(drift[0].online, false);
});

test("app.list uses the official Xiaowei package inventory without local ADB", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-app-list-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-app-list");
  try {
    const result = await runXiaoweiDeviceRead({
      action: "app-list", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        assert.equal(request.action, "apkList");
        return { code: 10_000, message: "SUCCESS", data: { opaque: [
          { packageName: "com.xingin.xhs" }, { packageName: "com.tencent.mm" }, { packageName: "com.xingin.xhs" },
        ] } };
      },
    });
    assert.deepEqual(result, {
      machine: "02", packages: ["com.tencent.mm", "com.xingin.xhs"],
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|serial|alias/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device size injects the server-resolved serial and parses numeric dimensions", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-read-size-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-size");
  try {
    const result = await runXiaoweiDeviceRead({
      action: "size", privateEndpoint: "http://127.0.0.1:9223", outputRoot, targets: [target()],
    }, {
      projectRoot,
      invokePrivateCommand: async (command, args) => {
        assert.equal(command, "get_size");
        assert.deepEqual(args, { serial: "secret-device-identifier" });
        return { value: "1080x2400" };
      },
    });
    assert.deepEqual(result, {
      machine: "02", width: 1080, height: 2400,
      transport: "xiaowei-private-api", localAdbRequired: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|serial|alias/iu);
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "size", privateEndpoint: "http://127.0.0.1:9223", outputRoot,
      targets: [target()], args: { serial: "caller-override" },
    }, { projectRoot }), /unsupported field: args/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device size rejects invalid, empty, and multi-device private results", () => {
  assert.deepEqual(parsePrivateSize("1080x2400"), { width: 1080, height: 2400 });
  for (const value of ["", " 1080x2400", "1080X2400", "1080x", "0x2400", ["1080x2400"], { a: "1080x2400" }]) {
    assert.throws(() => parsePrivateSize(value), /size|dimensions/u);
  }
});

test("device UI read creates a verified artifact without local ADB or serial disclosure", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-read-ui-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-ui");
  try {
    const result = await runXiaoweiDeviceRead({
      action: "ui", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        assert.equal(request.action, "adb_shell");
        assert.equal(request.data.command, "uiautomator dump /dev/tty");
        return {
          code: 10_000,
          message: "SUCCESS",
          data: { "secret-device-identifier": "warning\n<hierarchy><node package=\"com.test\" /></hierarchy>" },
        };
      },
    });
    assert.equal(result.success, 1);
    assert.equal(result.localAdbRequired, false);
    const xml = await readFile(result.results[0].hierarchyPath, "utf8");
    assert.equal(result.results[0].bytes, Buffer.byteLength(xml, "utf8"));
    assert.match(result.results[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.results[0].persistenceVerification, "fsync_rename_readback_exact");
    assert.match(xml, /com\.test/u);
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.input verifies focused exact echo and restores the prior IME", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-device-input-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-input");
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = originalIme;
  let editorText = "旧内容";
  let inputCalls = 0;
  const ui = () => `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" class="android.widget.EditText" focused="true" focusable="true" text="${editorText}" bounds="[80,80][1000,220]" />
  </node></hierarchy>`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "input", package: "com.xingin.xhs", text: "通勤穿搭", imeService: bridgeIme,
      allowTemporaryEnable: false, echoVerification: "ui_text",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "imeList") {
          return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": [originalIme, bridgeIme] } };
        }
        if (request.action === "selectIme") {
          currentIme = request.data.ime;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "inputText") {
          inputCalls += 1;
          editorText = request.data.content;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "adb_shell") {
          const command = request.data.command;
          let value = "";
          if (command === "uiautomator dump /dev/tty") value = ui();
          else if (command === "settings get secure default_input_method") value = currentIme;
          else if (command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
          else if (command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
          else if (command.includes("KEYCODE_FORWARD_DEL")) editorText = "";
          return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
        }
        throw new Error(`Unexpected action ${request.action}`);
      },
    });
    assert.deepEqual(result, {
      machine: "02", status: "verified", verification: "exact_focused_editor_ui_echo_after_ime_restore",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.equal(inputCalls, 1);
    assert.equal(currentIme, originalIme);
    assert.doesNotMatch(JSON.stringify(result), /secret|serial|alias/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.input safely re-resolves and refocuses one rebuilt editor after IME selection", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-device-input-refocus-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-input-refocus");
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = originalIme;
  let editorText = "";
  let focused = true;
  let rebuilt = false;
  let bridgeUiReads = 0;
  let pointerCalls = 0;
  let inputCalls = 0;
  const ui = () => {
    if (rebuilt) bridgeUiReads += 1;
    const transitional = rebuilt && bridgeUiReads === 1;
    return `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="${transitional ? "comment_editor_transition" : rebuilt ? "comment_editor_rebuilt" : "comment_editor"}" focused="${focused}" focusable="true" text="${editorText}" bounds="${transitional ? "[80,1600][960,1900]" : rebuilt ? "[100,1700][940,1860]" : "[80,1800][900,1940]"}" />
  </node></hierarchy>`;
  };
  try {
    const result = await runXiaoweiDeviceRead({
      action: "input", package: "com.xingin.xhs", text: "表情评论", imeService: bridgeIme,
      allowTemporaryEnable: false, echoVerification: "ui_text",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "imeList") {
          return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": [originalIme, bridgeIme] } };
        }
        if (request.action === "selectIme") {
          currentIme = request.data.ime;
          if (currentIme === bridgeIme) {
            focused = false;
            rebuilt = true;
          }
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "10", x: "48.148148", y: "74.166667" });
          pointerCalls += 1;
          focused = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "inputText") {
          inputCalls += 1;
          editorText = request.data.content;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "adb_shell") {
          const command = request.data.command;
          let value = "";
          if (command === "uiautomator dump /dev/tty") value = ui();
          else if (command === "settings get secure default_input_method") value = currentIme;
          else if (command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
          else if (command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
          else if (command === "wm size") value = "Physical size: 1080x2400";
          else if (command.includes("KEYCODE_FORWARD_DEL")) editorText = "";
          return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
        }
        throw new Error(`Unexpected action ${request.action}`);
      },
    });
    assert.equal(pointerCalls, 1);
    assert.equal(inputCalls, 1);
    assert.equal(currentIme, originalIme);
    assert.equal(result.status, "verified");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.input focuses one stable unfocused editor before selecting the bridge IME", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-device-input-prefocus-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-input-prefocus");
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = originalIme;
  let editorText = "请友善发言...";
  let focused = false;
  let focusDelayReads = 0;
  let pointerCalls = 0;
  const ui = () => {
    if (focusDelayReads > 0) {
      focusDelayReads -= 1;
      if (focusDelayReads === 0) focused = true;
    }
    return `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="message_editor" focused="${focused}" focusable="true" text="${editorText}" bounds="[100,100][500,300]" />
  </node></hierarchy>`;
  };
  try {
    const result = await runXiaoweiDeviceRead({
      action: "input", package: "com.xingin.xhs", text: "你好", imeService: bridgeIme,
      allowTemporaryEnable: false, echoVerification: "local_ocr",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      localOcr: async () => { throw new Error("exact EditText echo must be preferred over OCR"); },
      sendRequest: async (request) => {
        if (request.action === "imeList") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: [originalIme, bridgeIme] } };
        }
        if (request.action === "selectIme") {
          currentIme = request.data.ime;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "10", x: "27.777778", y: "8.333333" });
          pointerCalls += 1;
          focusDelayReads = 10;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "inputText") {
          editorText = request.data.content;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "adb_shell") {
          const command = request.data.command;
          let value = "";
          if (command === "uiautomator dump /dev/tty") value = ui();
          else if (command === "settings get secure default_input_method") value = currentIme;
          else if (command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
          else if (command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
          else if (command.includes("KEYCODE_FORWARD_DEL")) editorText = "";
          else if (command === "wm size") value = "Physical size: 1080x2400";
          return { code: 10_000, message: "SUCCESS", data: { opaque: value } };
        }
        throw new Error(`Unexpected action ${request.action}`);
      },
    });
    assert.equal(pointerCalls, 1);
    assert.equal(currentIme, originalIme);
    assert.equal(result.status, "verified");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tap-text uses one in-memory Xiaowei UI snapshot, one pointer event, and a verified fresh postcondition", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-tap-text-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-tap");
  const actions = [];
  const before = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node clickable="true" enabled="true" bounds="[216,2108][432,2175]"><node text="理财" bounds="[0,0][0,0]" /></node></node></hierarchy>';
  const after = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node resource-id="com.example.app:id/assets" bounds="[20,100][500,180]" /></node></hierarchy>';
  let uiReads = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "tap-text",
      text: "理财",
      postcondition: { kind: "resource-id", value: "com.example.app:id/assets" },
      endpoint: "ws://127.0.0.1:22222/",
      outputRoot,
      targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pointerEvent") {
          assert.equal(request.data.type, "10");
          assert.match(request.data.x, /^\d+(?:\.\d+)?$/u);
          assert.match(request.data.y, /^\d+(?:\.\d+)?$/u);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("dumpsys ")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "mResumedActivity: ActivityRecord{abc u0 com.xingin.xhs/.MainActivity}" } };
        }
        if (request.data.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        const hierarchy = uiReads++ === 0 ? before : after;
        return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
      },
      delay: async () => {},
    });
    assert.deepEqual(actions, ["adb_shell", "adb_shell", "pointerEvent", "adb_shell"]);
    assert.equal(result.success, 1);
    assert.equal(result.results[0].verificationOutcome, "verified");
    assert.equal(result.results[0].persistenceVerification, "fsync_rename_readback_exact");
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|"x"|"y"/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.tap-coords rechecks the source package, sends once, and verifies a fresh postcondition", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-tap-coords-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-tap-coords");
  let sent = false;
  let pointerCalls = 0;
  const focus = () => `mResumedActivity: ActivityRecord{abc u0 ${sent ? "com.xingin.xhs" : "com.example.launcher"}/.MainActivity}`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "tap-coords", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
      package: "com.example.launcher", x: 50, y: 25,
      postcondition: { kind: "package", value: "com.xingin.xhs" },
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "10", x: "50", y: "25" });
          pointerCalls += 1;
          sent = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        assert.match(request.data.command, /dumpsys (?:activity|window)/u);
        return { code: 10_000, message: "SUCCESS", data: { opaque: focus() } };
      },
    });
    assert.equal(pointerCalls, 1);
    assert.deepEqual(result, {
      machine: "02", status: "verified",
      verification: "source_package_fast_rechecked_then_single_pointer_event_then_fresh_postcondition",
      transport: "xiaowei-api", localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("tap-ocr rechecks one screenshot target, sends one pointer event, and verifies a fresh OCR postcondition", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-tap-ocr-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-tap-ocr");
  const actions = [];
  const ocrCalls = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "tap-ocr",
      package: "com.tencent.mm",
      text: "我",
      postcondition: { kind: "text", value: "服务" },
      endpoint: "ws://127.0.0.1:22222/",
      outputRoot,
      targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pointerEvent") {
          assert.equal(request.data.type, "10");
          assert.match(request.data.x, /^\d+(?:\.\d+)?$/u);
          assert.match(request.data.y, /^\d+(?:\.\d+)?$/u);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        if (request.data.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: '<hierarchy><node package="com.tencent.mm" /></hierarchy>' } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      localOcr: async ({ expectedText }) => {
        ocrCalls.push(expectedText);
        if (expectedText === "我") {
          return {
            matches: [{ left: 810, top: 2100, right: 850, bottom: 2140 }],
            ocrAvailable: true,
          };
        }
        const postconditionCalls = ocrCalls.filter((value) => value === "服务").length;
        return {
          matches: postconditionCalls >= 5 ? [{ left: 100, top: 400, right: 180, bottom: 450 }] : [],
          ocrAvailable: true,
        };
      },
      delay: async () => {},
    });
    assert.equal(actions.filter((action) => action === "pointerEvent").length, 1);
    assert.equal(result.success, 1);
    assert.equal(result.results[0].verificationOutcome, "verified");
    assert.match(result.results[0].verification, /unique_local_ocr_target/u);
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|"x"|"y"|serial/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("WeChat account tab fallback derives one fresh-device target from stable bottom navigation anchors", () => {
  assert.deepEqual(inferWechatMeBounds(
    { left: 350, top: 2301, right: 443, bottom: 2333 },
    { left: 645, top: 2303, right: 705, bottom: 2332 },
    { width: 1080, height: 2400 },
  ), { left: 915, top: 2302, right: 992, bottom: 2333 });
  assert.throws(() => inferWechatMeBounds(
    { left: 350, top: 1800, right: 443, bottom: 1833 },
    { left: 645, top: 2303, right: 705, bottom: 2332 },
    { width: 1080, height: 2400 },
  ), /LAYOUT_DRIFT/u);
  assert.throws(() => inferWechatMeBounds(
    { left: 700, top: 2300, right: 760, bottom: 2330 },
    { left: 600, top: 2300, right: 660, bottom: 2330 },
    { width: 1080, height: 2400 },
  ), /LAYOUT_DRIFT/u);
});

test("device.node.resolve uses two fresh observations and exposes no coordinates or device identity", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-resolve-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-resolve");
  const hierarchy = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node clickable="true" enabled="true" text="Open" bounds="[100,2100][300,2180]" /></node></hierarchy>';
  try {
    const result = await runXiaoweiDeviceRead({
      action: "node-resolve",
      package: "com.example.app",
      selector: { label: "Open", role: "button", sources: ["accessibility", "ocr"] },
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
        }
        if (request.data?.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (request.data?.command?.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      localOcr: async () => ({ matches: [], ocrAvailable: true }),
      delay: async () => {},
    });
    assert.deepEqual(result, {
      machine: "02", status: "resolved",
      node: { label: "Open", role: "button", group: null, ordinal: null, source: "accessibility", unique: true },
      evidence: { foregroundPackageVerified: true, freshObservations: 2, coordinateExposed: false },
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /"(?:serial|alias|deviceId|x|y|left|top|right|bottom|path)"/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("accessibility selector resolves one clickable icon by class and nearby exact text", () => {
  const hierarchy = `<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]">
    <node class="android.widget.LinearLayout" bounds="[100,300][1040,700]">
      <node class="android.widget.TextView" text="一条唯一评论" bounds="[180,360][700,450]" />
      <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[100,360][160,440]" />
      <node class="android.view.ViewGroup" bounds="[180,460][700,590]">
        <node class="android.view.ViewGroup" bounds="[180,460][300,580]">
          <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[180,460][300,580]" />
        </node>
      </node>
      <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[900,600][1000,680]" />
    </node>
    <node class="android.widget.LinearLayout" bounds="[100,720][1040,1120]">
      <node class="android.widget.TextView" text="另一条评论" bounds="[180,780][700,870]" />
      <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[900,1020][1000,1100]" />
    </node>
  </node></hierarchy>`;
  const bounds = uniqueAccessibilityBounds(hierarchy, {
    label: "评论点赞", role: "button", sources: ["accessibility"],
    className: "android.widget.ImageView", clickable: true, nearText: "一条唯一评论", nearTextPosition: "right",
  }, { width: 1080, height: 2400 });
  assert.deepEqual(bounds, { left: 900, top: 600, right: 1000, bottom: 680, width: 100, height: 80 });
});

test("accessibility icon selector fails closed when near-text still leaves multiple targets", () => {
  const hierarchy = `<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]">
    <node class="android.widget.LinearLayout" bounds="[100,300][1040,700]">
      <node class="android.widget.TextView" text="一条唯一评论" bounds="[180,360][700,450]" />
      <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[800,600][880,680]" />
      <node class="android.widget.ImageView" clickable="true" enabled="true" bounds="[900,600][1000,680]" />
    </node>
  </node></hierarchy>`;
  assert.throws(() => uniqueAccessibilityBounds(hierarchy, {
    label: "评论点赞", role: "button", sources: ["accessibility"],
    className: "android.widget.ImageView", clickable: true, nearText: "一条唯一评论",
  }, { width: 1080, height: 2400 }), /NODE_AMBIGUOUS/u);
});

test("accessibility selector resolves a no-text icon by bounded screen region ordinal", () => {
  const hierarchy = `<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]">
    <node class="android.widget.ImageView" clickable="true" bounds="[40,80][120,160]" />
    <node class="android.widget.ImageView" clickable="true" bounds="[760,80][840,160]" />
    <node class="android.widget.ImageView" clickable="true" bounds="[900,80][980,160]" />
    <node class="android.widget.ImageView" clickable="true" bounds="[900,2100][980,2180]" />
  </node></hierarchy>`;
  assert.deepEqual(uniqueAccessibilityBounds(hierarchy, {
    label: "分享", role: "button", sources: ["accessibility"], className: "android.widget.ImageView",
    clickable: true, screenRegion: "top_right", regionOrdinal: 2,
  }, { width: 1080, height: 2400 }), {
    left: 900, top: 80, right: 980, bottom: 160, width: 80, height: 80,
  });
});

test("accessibility selector resolves a no-text navigation control by content description", () => {
  const hierarchy = `<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]">
    <node class="android.view.ViewGroup" content-desc="消息,未读" clickable="true" bounds="[540,2100][810,2400]">
      <node class="android.widget.TextView" text="" bounds="[0,0][0,0]" />
    </node>
  </node></hierarchy>`;
  assert.deepEqual(uniqueAccessibilityBounds(hierarchy, {
    label: "消息", role: "tab", sources: ["accessibility"], contentDesc: "消息,未读", clickable: true,
  }, { width: 1080, height: 2400 }), {
    left: 540, top: 2100, right: 810, bottom: 2400, width: 270, height: 300,
  });
});

test("device.node.resolve vision uses two fresh screenshots and keeps model bounds private", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-vision-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-vision");
  const hierarchy = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]" /></hierarchy>';
  let visionCalls = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "node-resolve", package: "com.example.app",
      selector: {
        label: "Profile", role: "tab", sources: ["vision"],
        visionPrompt: "person-shaped profile tab in the bottom navigation",
      },
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
        }
        if (request.data?.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (request.data?.command?.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      cloudVision: async ({ imagePath, promptText, instruction }) => {
        visionCalls += 1;
        assert.match(imagePath, /node-resolve-(?:before|guard)\.png$/u);
        assert.match(promptText, /2x2 pixel marker/u);
        assert.match(instruction, /Profile/u);
        return { content: JSON.stringify({
          matches: visionCalls === 1
            ? [{ left: 810, top: 2100, right: 900, bottom: 2190 }]
            : [{ left: 825, top: 2115, right: 885, bottom: 2175 }],
        }) };
      },
      localOcr: async () => ({ matches: [], ocrAvailable: true }),
      delay: async () => {},
    });
    assert.equal(visionCalls, 2);
    assert.deepEqual(result, {
      machine: "02", status: "resolved",
      node: { label: "Profile", role: "tab", group: null, ordinal: null, source: "vision", unique: true },
      evidence: { foregroundPackageVerified: true, freshObservations: 2, coordinateExposed: false },
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /(?:secret-device-identifier|"(?:x|y|left|top|right|bottom|path)")/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.node.resolve vision tolerates normal model box jitter", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-vision-jitter-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-vision-jitter");
  const hierarchy = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]" /></hierarchy>';
  let visionCalls = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "node-resolve", package: "com.example.app",
      selector: {
        label: "Profile", role: "tab", sources: ["vision"],
        visionPrompt: "person-shaped profile tab in the bottom navigation",
      },
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
        }
        if (request.data?.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (request.data?.command?.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      cloudVision: async () => {
        visionCalls += 1;
        return { content: JSON.stringify({
          matches: visionCalls === 1
            ? [{ left: 810, top: 2100, right: 900, bottom: 2190 }]
            : [{ left: 845, top: 2130, right: 935, bottom: 2220 }],
        }) };
      },
      localOcr: async () => ({ matches: [], ocrAvailable: true }),
      delay: async () => {},
    });
    assert.equal(visionCalls, 2);
    assert.equal(result.status, "resolved");
    assert.equal(result.node.source, "vision");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.node.resolve vision reports missing configuration instead of falling into relation", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-vision-missing-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-vision-missing");
  const hierarchy = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]" /></hierarchy>';
  try {
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "node-resolve", package: "com.example.app",
      selector: { label: "Profile", role: "tab", sources: ["vision"] },
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
        }
        if (request.data?.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (request.data?.command?.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      cloudVision: async () => { throw new Error("设置 VISION_API_URL、VISION_API_KEY、VISION_MODEL"); },
      localOcr: async () => ({ matches: [], ocrAvailable: true }),
      delay: async () => {},
    }), /CAPABILITY_MISSING.*Vision service is not configured/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.node.activate resolves an exact count child to its clickable ancestor and verifies increment without OCR", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-activate-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-activate");
  let activated = false;
  let pointerEvents = 0;
  const before = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node class="android.widget.LinearLayout" clickable="true" enabled="true" bounds="[800,2100][980,2180]"><node class="android.widget.ImageView" bounds="[800,2100][880,2180]" /><node class="android.widget.TextView" text="773" bounds="[880,2100][980,2180]" /></node><node class="android.widget.ImageView" clickable="true" bounds="[990,2100][1070,2180]" /></node></hierarchy>';
  const after = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node class="android.widget.LinearLayout" clickable="true" enabled="true" bounds="[800,2100][980,2180]"><node class="android.widget.ImageView" bounds="[800,2100][880,2180]" /><node class="android.widget.TextView" text="774" bounds="[880,2100][980,2180]" /></node><node class="android.widget.ImageView" clickable="true" bounds="[990,2100][1070,2180]" /></node></hierarchy>';
  try {
    const result = await runXiaoweiDeviceRead({
      action: "node-activate", package: "com.example.app",
      selector: { label: "评论点赞", role: "button", sources: ["accessibility"], text: "773" },
      postcondition: { kind: "text", value: "774" },
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          pointerEvents += 1;
          activated = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: activated ? after : before } };
        }
        if (request.data?.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (request.data?.command?.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      localOcr: async () => ({ matches: [], ocrAvailable: false }),
      delay: async () => {},
    });
    assert.equal(pointerEvents, 1);
    assert.equal(result.status, "verified");
    assert.equal(result.verification, "node_rechecked_then_single_pointer_event_then_fresh_postcondition");
    assert.doesNotMatch(JSON.stringify(result), /"(?:serial|alias|deviceId|x|y|left|top|right|bottom|path)"/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("WeChat wallet balance uses two fresh screenshots and returns only one stable typed balance", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-wechat-wallet-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-wallet");
  const actions = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "wechat-wallet-balance",
      endpoint: "ws://127.0.0.1:22222/",
      outputRoot,
      targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "adb_shell" && request.data.command.startsWith("if [ -s")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        if (request.action === "adb_shell" && request.data.command === "uiautomator dump /dev/tty") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: '<hierarchy><node package="com.tencent.mm" /></hierarchy>' } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
      localOcr: async ({ mode }) => mode === "currency_amount" ? {
        currencyAmounts: [{ currency: "CNY", amountMinor: 1230 }],
        ocrAvailable: true,
      } : {
        matches: [{ left: 100, top: 100, right: 180, bottom: 150 }],
        ocrAvailable: true,
      },
      delay: async () => {},
    });
    assert.deepEqual(result, {
      machine: "02", currency: "CNY", balance: "12.30",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.equal(actions.filter((action) => action === "pointerEvent").length, 0);
    assert.equal(actions.filter((action) => action === "pullFile").length, 2);
    assert.doesNotMatch(JSON.stringify(result), /secret|serial|alias|path|screenshot|coordinate/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS observation intersects two fresh UI reads and returns no device identifiers", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-observe-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-observe");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [{ state: "HOME_FEED", evidence: [{
      id: "home-feed", weight: 1,
      any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }],
    }] }],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed"><node bounds="[100,200][500,1000]" content-desc="笔记 公开标题 来自公开作者 7赞" /><node content-desc="消息,1条未读" /></node></hierarchy>';
  let uiReads = 0;
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-observe", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      sendRequest: async (request) => {
        assert.equal(request.action, "adb_shell");
        uiReads += 1;
        return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
      },
      delay: async () => {},
    });
    assert.equal(uiReads, 2);
    assert.equal(result.machine, "02");
    assert.equal(result.page.state, "HOME_FEED");
    assert.equal(result.notes[0].title, "公开标题");
    assert.equal(result.notes[0].ordinal, 1);
    assert.equal(result.stability, "two_fresh_ui_intersection");
    assert.equal(result.localAdbRequired, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|serial|alias|消息|未读/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS video-detail observation uses one fresh UI read", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-video-observe-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-video-observe");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [{ state: "VIDEO_NOTE", evidence: [{
      id: "video-detail", weight: 1,
      any: [{ attribute: "resourceId", match: "includes", values: ["video_detail"] }],
    }] }],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" resource-id="video_detail"><node content-desc="视频,播放中" bounds="[0,0][1080,1800]" /><node resource-id="note_title" text="公开视频" /></node></hierarchy>';
  let uiReads = 0;
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-observe", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      sendRequest: async () => {
        uiReads += 1;
        return { code: 10_000, message: "SUCCESS", data: { opaque: hierarchy } };
      },
      delay: async () => {},
    });
    assert.equal(uiReads, 1);
    assert.equal(result.page.state, "VIDEO_NOTE");
    assert.equal(result.stability, "single_fresh_video_detail_ui");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS find-video scrolls with fresh feed UI and returns the current ordinal", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-find-video-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-find-video");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [{ state: "HOME_FEED", evidence: [{
      id: "home-feed", weight: 1,
      any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }],
    }] }],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const imageFeed = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed" class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,100][1080,2200]"><node bounds="[100,200][500,900]" content-desc="笔记 图片条目 来自作者甲 1赞" /></node></hierarchy>';
  const videoFeed = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed" class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,100][1080,2200]"><node bounds="[100,200][500,900]" content-desc="视频 视频条目 来自作者乙 2赞" /></node></hierarchy>';
  let scrolled = false;
  let scrollEvents = 0;
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-find-video", maxScrolls: 2, maxDurationMs: 28_000,
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      now: () => 1_000,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "6" });
          scrollEvents += 1;
          scrolled = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: scrolled ? videoFeed : imageFeed } };
      },
    });
    assert.equal(scrollEvents, 1);
    assert.equal(result.status, "found");
    assert.equal(result.note.mediaType, "video");
    assert.equal(result.ordinal, 1);
    assert.equal(result.scrolls, 1);
    assert.equal(result.verification, "fresh_home_feed_ui_after_each_scroll");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.back uses one Xiaowei back event and verifies a fresh screen change", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-back-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-back");
  let page = "before";
  let backEvents = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "back", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          assert.deepEqual(request.data, { type: "3" });
          backEvents += 1;
          page = "after";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        assert.equal(request.action, "adb_shell");
        if (request.data.command === "screencap -p | sha256sum") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: `${(page === "before" ? "a" : "b").repeat(64)}  -` } };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: "mCurrentFocus=Window{a} com.example.app/.MainActivity" } };
      },
      delay: async () => {},
    });
    assert.equal(backEvents, 1);
    assert.deepEqual(result, {
      machine: "02",
      status: "verified",
      verification: "single_back_event_then_fresh_screen_change",
      transport: "xiaowei-api",
      localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.back accepts a focused-window change on animated pages", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-back-animated-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-back-animated");
  let activity = "com.xingin.xhs/.note.NoteActivity";
  let hashCalls = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "back", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          activity = "com.xingin.xhs/.home.MainActivity";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        assert.equal(request.action, "adb_shell");
        if (request.data.command === "screencap -p | sha256sum") {
          hashCalls += 1;
          return { code: 10_000, message: "SUCCESS", data: { opaque: `${String(hashCalls).padStart(2, "0").repeat(32)}  -` } };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: `mCurrentFocus=Window{a} ${activity}` } };
      },
      delay: async () => {},
    });
    assert.equal(result.status, "verified");
    assert.equal(result.verification, "single_back_event_then_focused_window_change");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.back rejects pure animation without navigation", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-back-anim-fail-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-back-anim-fail");
  let hashCalls = 0;
  let backEvents = 0;
  try {
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "back", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          backEvents += 1;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        assert.equal(request.action, "adb_shell");
        if (request.data.command === "screencap -p | sha256sum") {
          hashCalls += 1;
          return { code: 10_000, message: "SUCCESS", data: { opaque: `${String(hashCalls + 100).repeat(32).slice(0, 64)}  -` } };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: "mCurrentFocus=Window{a} com.xingin.xhs/.note.NoteActivity" } };
      },
      delay: async () => {},
    }), /POSTCONDITION_MISS|fresh UI change was not verified/u);
    assert.equal(backEvents, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.recent uses one Xiaowei task-switcher event and verifies a fresh UI change", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-recent-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-recent");
  let recent = false;
  let sends = 0;
  const ui = () => `<hierarchy><node package="com.example.systemui" text="${recent ? "recent-tasks" : "home"}" /></hierarchy>`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "recent", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          assert.deepEqual(request.data, { type: "1" });
          sends += 1;
          recent = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: ui() } };
      },
    });
    assert.equal(sends, 1);
    assert.deepEqual(result, {
      machine: "02", status: "verified", verification: "single_recent_event_then_fresh_ui_change",
      transport: "xiaowei-api", localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS visible-card opening resolves one fresh ordinal, rechecks foreground, and verifies matching detail", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-open-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-open");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [
      { state: "HOME_FEED", evidence: [{ id: "home", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }] }] },
      { state: "IMAGE_NOTE", evidence: [{ id: "detail", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["note_detail"] }] }] },
    ],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const home = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed"><node bounds="[100,200][500,1000]" content-desc="笔记 公开标题 来自公开作者 7赞" /></node></hierarchy>';
  const detail = '<hierarchy><node package="com.xingin.xhs" resource-id="note_detail"><node resource-id="note_title" text="公开标题" /><node resource-id="author" text="公开作者" /><node resource-id="note_content" text="公开正文" /><node resource-id="like_count" text="7" /></node></hierarchy>';
  const actions = [];
  let uiReads = 0;
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-open-visible", ordinal: 1, endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "10", x: "27.777778", y: "25" });
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("dumpsys ")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "mResumedActivity: ActivityRecord{abc u0 com.xingin.xhs/.MainActivity}" } };
        }
        if (request.data.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        uiReads += 1;
        return { code: 10_000, message: "SUCCESS", data: { opaque: uiReads <= 1 ? home : detail } };
      },
      delay: async () => {},
    });
    assert.equal(actions.filter((action) => action === "pointerEvent").length, 1);
    assert.equal(result.selected.ordinal, 1);
    assert.equal(result.detail.title, "公开标题");
    assert.equal(result.verification, "single_pointer_event_then_fresh_matching_detail_ui");
    assert.equal(result.stability, "single_fresh_matching_detail_ui");
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|serial|alias|coordinate|"x"|"y"/iu);
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "xhs-open-visible", ordinal: 0, endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, { projectRoot, xhsRulesPath: rulesPath }), /ordinal/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS visible-card opening returns from detail, verifies home, then opens exactly once", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-reopen-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-reopen");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [
      { state: "HOME_FEED", evidence: [{ id: "home", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }] }] },
      { state: "IMAGE_NOTE", evidence: [{ id: "detail", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["note_detail"] }] }] },
    ],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const home = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed"><node bounds="[100,200][500,1000]" content-desc="笔记 公开标题 来自公开作者 7赞" /></node></hierarchy>';
  const detail = '<hierarchy><node package="com.xingin.xhs" resource-id="note_detail"><node resource-id="note_title" text="公开标题" /><node resource-id="author" text="公开作者" /><node resource-id="note_content" text="公开正文" /><node resource-id="like_count" text="7" /></node></hierarchy>';
  const events = [];
  let page = "detail";
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-open-visible", ordinal: 1, endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          assert.deepEqual(request.data, { type: "3" });
          events.push("back");
          page = "home";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pointerEvent") {
          assert.equal(page, "home");
          assert.equal(request.data.type, "10");
          events.push("open");
          page = "detail";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("dumpsys ")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "mResumedActivity: ActivityRecord{abc u0 com.xingin.xhs/.MainActivity}" } };
        }
        if (request.data.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: page === "home" ? home : detail } };
      },
      delay: async () => {},
    });
    assert.deepEqual(events, ["back", "open"]);
    assert.equal(result.page.state, "IMAGE_NOTE");
    assert.equal(result.detail.title, "公开标题");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS visible-card opening tolerates an extended verified return transition", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-slow-return-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-slow-return");
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [
      { state: "HOME_FEED", evidence: [{ id: "home", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }] }] },
      { state: "IMAGE_NOTE", evidence: [{ id: "detail", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["note_detail"] }] }] },
    ],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const home = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed"><node bounds="[100,200][500,1000]" content-desc="笔记 公开标题 来自公开作者 7赞" /></node></hierarchy>';
  const detail = '<hierarchy><node package="com.xingin.xhs" resource-id="note_detail"><node resource-id="note_title" text="公开标题" /><node resource-id="author" text="公开作者" /><node resource-id="note_content" text="公开正文" /><node resource-id="like_count" text="7" /></node></hierarchy>';
  const events = [];
  let phase = "detail";
  let returnReads = 0;
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const result = await runXiaoweiDeviceRead({
      action: "xhs-open-visible", ordinal: 1, endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      xhsRulesPath: rulesPath,
      sendRequest: async (request) => {
        if (request.action === "pushEvent") {
          assert.deepEqual(request.data, { type: "3" });
          events.push("back");
          phase = "returning";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pointerEvent") {
          assert.equal(phase, "home");
          events.push("open");
          phase = "opened";
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("dumpsys ")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "mResumedActivity: ActivityRecord{abc u0 com.xingin.xhs/.MainActivity}" } };
        }
        if (request.data.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        if (phase === "returning") {
          returnReads += 1;
          if (returnReads >= 16) phase = "home";
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: phase === "home" ? home : detail } };
      },
      delay: async () => {},
    });
    assert.equal(returnReads, 16);
    assert.deepEqual(events, ["back", "open"]);
    assert.equal(result.detail.title, "公开标题");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.scroll rechecks one container, sends one directional event, and verifies fresh UI change", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-scroll-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-scroll");
  const before = '<hierarchy><node package="com.xingin.xhs" class="androidx.recyclerview.widget.RecyclerView" resource-id="feed" scrollable="true" bounds="[0,100][1080,2200]"><node text="第一条" /></node></hierarchy>';
  const after = '<hierarchy><node package="com.xingin.xhs" class="androidx.recyclerview.widget.RecyclerView" resource-id="feed" scrollable="true" bounds="[0,100][1080,2200]"><node text="第二条" /></node></hierarchy>';
  let moved = false;
  let eventCount = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "scroll", direction: "down", steps: 1, package: "com.xingin.xhs",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "6" });
          eventCount += 1;
          moved = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: moved ? after : before } };
      },
      delay: async () => {},
    });
    assert.equal(eventCount, 1);
    assert.deepEqual(result, {
      machine: "02", status: "verified", direction: "down", steps: 1,
      verification: "scrollable_container_rechecked_then_directional_events_then_fresh_ui_change",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "scroll", direction: "sideways", steps: 1,
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, { projectRoot }), /device\.scroll request is invalid/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.scroll deduplicates identical containers and rejects distinct equal-area targets", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-scroll-duplicate-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-scroll-duplicate");
  const container = 'package="com.xingin.xhs" class="androidx.viewpager.widget.ViewPager" resource-id="pager" scrollable="true" bounds="[0,0][1080,2200]"';
  const before = `<hierarchy><node ${container}><node text="第一条" /></node><node ${container}><node text="第一条" /></node></hierarchy>`;
  const after = `<hierarchy><node ${container}><node text="第二条" /></node><node ${container}><node text="第二条" /></node></hierarchy>`;
  let moved = false;
  let eventCount = 0;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "scroll", direction: "down", steps: 1, package: "com.xingin.xhs",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          eventCount += 1;
          moved = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        return { code: 10_000, message: "SUCCESS", data: { opaque: moved ? after : before } };
      },
    });
    assert.equal(result.status, "verified");
    assert.equal(eventCount, 1);

    const ambiguous = `<hierarchy><node ${container} /><node package="com.xingin.xhs" class="androidx.recyclerview.widget.RecyclerView" resource-id="feed" scrollable="true" bounds="[0,0][1080,2200]" /></hierarchy>`;
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "scroll", direction: "down", steps: 1, package: "com.xingin.xhs",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async () => ({ code: 10_000, message: "SUCCESS", data: { opaque: ambiguous } }),
    }), /NODE_AMBIGUOUS/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device.scroll supports a horizontal launcher page gesture and verifies a fresh screen change", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-scroll-horizontal-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-scroll-horizontal");
  let moved = false;
  let pointerCalls = 0;
  const changedPng = Buffer.from(SCREEN_PNG);
  changedPng[45] = changedPng[45] ^ 1;
  const ui = '<hierarchy><node package="com.example.launcher" bounds="[0,0][1080,2400]" /></hierarchy>';
  try {
    const result = await runXiaoweiDeviceRead({
      action: "scroll", direction: "right", steps: 1, package: "com.example.launcher",
      endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "8" });
          pointerCalls += 1;
          moved = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.action === "pullFile") {
          await writeFile(request.data.savePath, moved ? changedPng : SCREEN_PNG);
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data?.command?.includes("uiautomator dump")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: ui } };
        }
        if (request.data?.command?.startsWith("if [ -s ")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: String(SCREEN_PNG.length) } };
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      },
    });
    assert.equal(pointerCalls, 1);
    assert.deepEqual(result, {
      machine: "02", status: "verified", direction: "right", steps: 1,
      verification: "foreground_rechecked_then_horizontal_events_then_fresh_screen_change",
      transport: "xiaowei-api", localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("xhs.comment-emoji binds controls to Xiaohongshu and verifies count increment plus draft clearing", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-comment-emoji-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-comment-emoji");
  let draft = "";
  let count = 192;
  const pointerEvents = [];
  const ui = () => `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" content-desc="图片,第1张,共1张" bounds="[0,200][1080,1500]" />
    <node package="com.xingin.xhs" resource-id="note_title" text="测试帖子" bounds="[40,1500][700,1560]" />
    <node package="com.xingin.xhs" resource-id="note_author" text="测试作者" bounds="[40,1560][500,1620]" />
    <node package="com.xingin.xhs" content-desc="评论 ${count}" bounds="[20,1600][220,1680]" />
    <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="comment_editor" focused="true" text="${draft}" bounds="[80,1800][780,1940]" />
    <node package="com.xingin.xhs" class="android.widget.Button" text="[微笑R]" clickable="true" enabled="true" bounds="[100,2000][240,2140]" />
    <node package="com.xingin.xhs" class="android.widget.Button" text="发送" clickable="true" enabled="true" bounds="[850,1800][1030,1940]" />
  </node></hierarchy>`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "xhs-comment-emoji", emoji: "[微笑R]", endpoint: "ws://127.0.0.1:22222/",
      outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          pointerEvents.push(request.data);
          if (pointerEvents.length === 1) draft = "[微笑R]";
          else {
            assert.equal(draft, "[微笑R]");
            draft = "";
            count += 1;
          }
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        const value = request.data.command === "wm size" ? "Physical size: 1080x2400" : ui();
        return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
      },
    });
    assert.equal(pointerEvents.length, 2);
    assert.deepEqual(result, {
      machine: "02", status: "verified", beforeCount: 192, afterCount: 193,
      verification: "emoji_selected_then_package_bound_send_then_comment_count_increment_and_draft_clear",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.doesNotMatch(JSON.stringify(result), /微笑|serial|alias|coordinate|"(?:x|y)"/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS comment open, input, and send remain independently verifiable APIs", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-comment-atomic-"));
  let composerOpen = false;
  let draft = "";
  let count = 192;
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = originalIme;
  const pointerEvents = [];
  const ui = () => `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" content-desc="图片,第1张,共1张" bounds="[0,200][1080,1500]" />
    <node package="com.xingin.xhs" resource-id="note_title" text="测试帖子" bounds="[40,1500][700,1560]" />
    <node package="com.xingin.xhs" resource-id="note_author" text="测试作者" bounds="[40,1560][500,1620]" />
    <node package="com.xingin.xhs" content-desc="评论 ${count}" bounds="[20,1600][220,1680]" />
    ${composerOpen ? `
      <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="comment_editor" focused="true" text="${draft || "让大家听到你的声音"}" bounds="[80,1800][780,1940]" />
      <node package="com.xingin.xhs" class="android.widget.Button" text="[微笑R]" clickable="true" enabled="true" bounds="[100,2000][240,2140]" />
      <node package="com.xingin.xhs" class="android.widget.Button" text="发送" clickable="true" enabled="true" bounds="[850,1800][1030,1940]" />`
      : `<node package="com.xingin.xhs" class="android.widget.Button" content-desc="评论框" clickable="true" enabled="true" bounds="[80,1800][780,1940]" />`}
  </node></hierarchy>`;
  const runtime = {
    projectRoot,
    xhsRulesPath: path.resolve("config", "xhs-page-rules.json"),
    delay: async () => {},
    localOcr: async () => { throw new Error("comment text input must not require local OCR"); },
    sendRequest: async (request) => {
      if (request.action === "imeList") {
        return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": [originalIme, bridgeIme] } };
      }
      if (request.action === "selectIme") {
        currentIme = request.data.ime;
        if (currentIme === originalIme && draft === "好看") composerOpen = false;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "inputText") {
        draft = request.data.content;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "pointerEvent") {
        pointerEvents.push(request.data);
        if (!composerOpen) composerOpen = true;
        else if (!draft) draft = "[微笑R]";
        else {
          assert.equal(draft, "[微笑R]");
          draft = "";
          count += 1;
        }
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      let value = "";
      if (request.data.command === "wm size") value = "Physical size: 1080x2400";
      else if (request.data.command === "uiautomator dump /dev/tty") value = ui();
      else if (request.data.command === "settings get secure default_input_method") value = currentIme;
      else if (request.data.command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
      else if (request.data.command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
      else if (request.data.command.includes("KEYCODE_FORWARD_DEL")) draft = "";
      return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
    },
  };
  const base = {
    endpoint: "ws://127.0.0.1:22222/",
    targets: [target()],
  };
  try {
    const opened = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-open",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "open"),
    }, runtime);
    assert.match(opened.editorStateHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(opened, {
      machine: "02", status: "verified", commentCount: 192,
      target: { title: "测试帖子", author: "测试作者", mediaType: "image" },
      editorStateHash: opened.editorStateHash,
      verification: "comment_box_rechecked_then_single_activation_then_editor_verified",
      transport: "xiaowei-api", localAdbRequired: false,
    });

    const input = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-input", text: "[微笑R]", expectedEditorStateHash: opened.editorStateHash,
      imeService: "com.example.ime/.Service", allowTemporaryEnable: false, echoVerification: "ui_text",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "input"),
    }, runtime);
    assert.deepEqual(input, {
      machine: "02", status: "verified", inputMethod: "shortcut", draftLength: 5,
      verification: "xhs_comment_draft_exact_ui_echo",
      transport: "xiaowei-api", localAdbRequired: false,
    });

    const sent = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-send", expectedDraft: "[微笑R]", expectedBeforeCount: 192,
      expectedTarget: { title: "测试帖子", author: "测试作者", mediaType: "image" },
      expectedEmptyEditorStateHash: opened.editorStateHash,
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "send"),
    }, runtime);
    assert.deepEqual(sent, {
      machine: "02", status: "verified", beforeCount: 192, afterCount: 193,
      verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.equal(pointerEvents.length, 3);

    composerOpen = false;
    draft = "";
    const reopened = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-open",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "text-open"),
    }, runtime);
    const textInput = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-input", text: "好看", expectedEditorStateHash: reopened.editorStateHash,
      imeService: bridgeIme, allowTemporaryEnable: false, echoVerification: "local_ocr",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "text-input"),
    }, runtime);
    assert.deepEqual(textInput, {
      machine: "02", status: "verified", inputMethod: "ime", draftLength: 2,
      verification: "xhs_comment_draft_exact_ui_echo",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.equal(currentIme, originalIme);
    assert.equal(pointerEvents.length, 5);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS reply input reopens the same ordinal after IME selection rebuilds the editor", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-reply-input-"));
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = originalIme;
  let replyOpen = false;
  let replyLabelVisible = true;
  let draft = "";
  let pointerEvents = 0;
  const ui = () => {
    const visibleDraft = draft && currentIme === originalIme ? `回复 @目标：${draft}` : draft;
    return `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" content-desc="评论 18" bounds="[20,1600][220,1680]" />
    ${replyOpen ? `
      <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="reply_editor" focused="true" text="${visibleDraft || (replyLabelVisible ? "回复 @目标：" : "")}" bounds="[80,1100][780,1240]" />
      <node package="com.xingin.xhs" class="android.widget.Button" text="发送" clickable="true" enabled="true" bounds="[850,1100][1030,1240]" />`
      : `<node package="com.xingin.xhs" clickable="true" enabled="true" bounds="[20,300][1040,520]">
          <node package="com.xingin.xhs" text="昨天 北京 回复" bounds="[100,440][700,490]" />
        </node>
        <node package="com.xingin.xhs" clickable="true" enabled="true" bounds="[20,600][1040,820]">
          <node package="com.xingin.xhs" text="昨天 上海 回复" bounds="[100,740][700,790]" />
        </node>`}
  </node></hierarchy>`;
  };
  const runtime = {
    projectRoot,
    delay: async () => {},
    sendRequest: async (request) => {
      if (request.action === "imeList") {
        return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": [originalIme, bridgeIme] } };
      }
      if (request.action === "selectIme") {
        currentIme = request.data.ime;
        if (currentIme === bridgeIme && replyOpen && !draft) replyOpen = false;
        if (currentIme === originalIme && draft) replyOpen = false;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "inputText") {
        draft = request.data.content;
        replyLabelVisible = false;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "pointerEvent") {
        pointerEvents += 1;
        replyOpen = true;
        replyLabelVisible = !draft;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      let value = "";
      if (request.data.command === "wm size") value = "Physical size: 1080x2400";
      else if (request.data.command === "uiautomator dump /dev/tty") value = ui();
      else if (request.data.command === "settings get secure default_input_method") value = currentIme;
      else if (request.data.command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
      else if (request.data.command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
      else if (request.data.command.includes("KEYCODE_FORWARD_DEL")) {
        draft = "";
        replyLabelVisible = false;
      }
      return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
    },
  };
  try {
    const result = await runXiaoweiDeviceRead({
      action: "xhs-comment-reply-input", replyOrdinal: 2, text: "感谢分享",
      imeService: bridgeIme, allowTemporaryEnable: false, echoVerification: "ui_text",
      endpoint: "ws://127.0.0.1:22222/", targets: [target()],
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "reply-input"),
    }, runtime);
    assert.deepEqual(result, {
      machine: "02", status: "verified", inputMethod: "ime", draftLength: 4,
      commentCount: 18, editorStateHash: result.editorStateHash, replyOrdinal: 2,
      verification: "reply_target_rechecked_then_editor_recovered_after_ime_then_bound_draft_echo",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.match(result.editorStateHash, /^[a-f0-9]{64}$/u);
    assert.equal(pointerEvents, 3);
    assert.equal(currentIme, originalIme);
    assert.equal(draft, "感谢分享");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS reply input verifies drafts containing full-width punctuation", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-reply-fullwidth-"));
  const originalIme = "com.example.keyboard/.OriginalIme";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  const fullWidthDraft = "感谢分享！";
  let currentIme = originalIme;
  let replyOpen = false;
  let replyLabelVisible = true;
  let draft = "";
  const ui = () => {
    const visibleDraft = draft && currentIme === originalIme ? `回复 @目标：${draft}` : draft;
    return `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" content-desc="评论 18" bounds="[20,1600][220,1680]" />
    ${replyOpen ? `
      <node package="com.xingin.xhs" class="android.widget.EditText" resource-id="reply_editor" focused="true" text="${visibleDraft || (replyLabelVisible ? "回复 @目标：" : "")}" bounds="[80,1100][780,1240]" />
      <node package="com.xingin.xhs" class="android.widget.Button" text="发送" clickable="true" enabled="true" bounds="[850,1100][1030,1240]" />`
      : `<node package="com.xingin.xhs" clickable="true" enabled="true" bounds="[20,300][1040,520]">
          <node package="com.xingin.xhs" text="昨天 北京 回复" bounds="[100,440][700,490]" />
        </node>`}
  </node></hierarchy>`;
  };
  const runtime = {
    projectRoot,
    delay: async () => {},
    sendRequest: async (request) => {
      if (request.action === "imeList") {
        return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": [originalIme, bridgeIme] } };
      }
      if (request.action === "selectIme") {
        currentIme = request.data.ime;
        if (currentIme === bridgeIme && replyOpen && !draft) replyOpen = false;
        if (currentIme === originalIme && draft) replyOpen = false;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "inputText") {
        draft = request.data.content;
        replyLabelVisible = false;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "pointerEvent") {
        replyOpen = true;
        replyLabelVisible = !draft;
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      let value = "";
      if (request.data.command === "wm size") value = "Physical size: 1080x2400";
      else if (request.data.command === "uiautomator dump /dev/tty") value = ui();
      else if (request.data.command === "settings get secure default_input_method") value = currentIme;
      else if (request.data.command === "dumpsys input_method") value = `mCurMethodId=${currentIme}`;
      else if (request.data.command === "ime list -s") value = `${originalIme}\n${bridgeIme}`;
      else if (request.data.command.includes("KEYCODE_FORWARD_DEL")) {
        draft = "";
        replyLabelVisible = false;
      }
      return { code: 10_000, message: "SUCCESS", data: { "secret-device-identifier": value } };
    },
  };
  try {
    const result = await runXiaoweiDeviceRead({
      action: "xhs-comment-reply-input", replyOrdinal: 1, text: fullWidthDraft,
      imeService: bridgeIme, allowTemporaryEnable: false, echoVerification: "ui_text",
      endpoint: "ws://127.0.0.1:22222/", targets: [target()],
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "reply-input-fullwidth"),
    }, runtime);
    assert.equal(result.status, "verified");
    assert.equal(result.draftLength, 5);
    assert.equal(draft, fullWidthDraft);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS comment send reopens the exact feed note when the composer hides the incremented count", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-comment-recover-"));
  const rulesPath = path.join(projectRoot, "xhs-rules.json");
  const rules = {
    thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
    states: [
      { state: "HOME_FEED", evidence: [{ id: "home", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }] }] },
      { state: "IMAGE_NOTE", evidence: [{ id: "detail", weight: 1, any: [{ attribute: "resourceId", match: "includes", values: ["note_detail"] }] }] },
    ],
    safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
  };
  const detail = (count) => `<hierarchy><node package="com.xingin.xhs" resource-id="note_detail">
    <node package="com.xingin.xhs" content-desc="图片,第1张,共1张" />
    <node package="com.xingin.xhs" resource-id="note_title" text="公开标题" />
    <node package="com.xingin.xhs" resource-id="author" text="公开作者" />
    <node package="com.xingin.xhs" resource-id="note_content" text="公开正文" />
    <node package="com.xingin.xhs" content-desc="评论 ${count}" />
    <node package="com.xingin.xhs" class="android.widget.Button" content-desc="评论框" clickable="true" enabled="true" bounds="[80,1800][780,1940]" />
  </node></hierarchy>`;
  const composer = (draft) => `<hierarchy><node package="com.xingin.xhs">
    <node package="com.xingin.xhs" class="android.widget.EditText" focused="true" text="${draft || "留下你的想法吧"}" bounds="[80,1080][998,1179]" />
    <node package="com.xingin.xhs" class="android.widget.Button" text="[微笑R]" clickable="true" enabled="true" bounds="[100,1350][240,1470]" />
    <node package="com.xingin.xhs" class="android.widget.Button" text="发送" clickable="true" enabled="true" bounds="[850,1250][1030,1340]" />
  </node></hierarchy>`;
  const home = (top) => `<hierarchy><node package="com.xingin.xhs" resource-id="home_feed">
    <node package="com.xingin.xhs" bounds="[100,${top}][500,${top + 800}]" content-desc="笔记 公开标题 来自公开作者 赞" />
  </node></hierarchy>`;
  let state = "detail";
  let draft = "";
  let count = 7;
  let homeReads = 0;
  let clearedComposerReads = 0;
  let sendSubmitted = false;
  const events = [];
  const runtime = {
    projectRoot,
    xhsRulesPath: rulesPath,
    delay: async () => {},
    sendRequest: async (request) => {
      if (request.action === "pointerEvent") {
        events.push("tap");
        if (state === "detail") state = "composer";
        else if (state === "composer" && !draft) draft = "[微笑R]";
        else if (state === "composer") { draft = ""; count += 1; sendSubmitted = true; }
        else if (state === "home") state = "detail";
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.action === "pushEvent") {
        events.push("back");
        state = "home";
        return { code: 10_000, message: "SUCCESS", data: null };
      }
      if (request.data.command === "wm size") {
        return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
      }
      if (sendSubmitted && state === "composer" && !draft) clearedComposerReads += 1;
      const value = state === "home" ? home(homeReads++ % 2 ? 240 : 200)
        : state === "composer" ? composer(draft) : detail(count);
      return { code: 10_000, message: "SUCCESS", data: { opaque: value } };
    },
  };
  const base = { endpoint: "ws://127.0.0.1:22222/", targets: [target()] };
  try {
    await writeFile(rulesPath, JSON.stringify(rules));
    const opened = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-open",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "open"),
    }, runtime);
    await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-input", text: "[微笑R]", expectedEditorStateHash: opened.editorStateHash,
      imeService: "com.example.ime/.Service", allowTemporaryEnable: false, echoVerification: "ui_text",
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "input"),
    }, runtime);
    const sent = await runXiaoweiDeviceRead({
      ...base, action: "xhs-comment-send", expectedDraft: "[微笑R]",
      expectedBeforeCount: opened.commentCount, expectedTarget: opened.target,
      expectedEmptyEditorStateHash: opened.editorStateHash,
      outputRoot: path.join(projectRoot, "data", "matrix", "runs", "send"),
    }, runtime);
    assert.deepEqual(sent, {
      machine: "02", status: "verified", beforeCount: 7, afterCount: 8,
      verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
      transport: "xiaowei-api", localAdbRequired: false,
    });
    assert.deepEqual(events, ["tap", "tap", "tap", "back", "tap"]);
    assert.equal(clearedComposerReads, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("xhs.dm.send binds the exact draft to the send control aligned with its editor", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-dm-send-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-dm-send");
  let sent = false;
  let pointerCalls = 0;
  const ui = () => `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" class="android.widget.TextView" text="发送" clickable="true" enabled="true" bounds="[827,1196][959,1261]" />
    ${sent ? '<node package="com.xingin.xhs" class="android.widget.TextView" text="测试" bounds="[600,900][950,1000]" />' : ''}
    <node package="com.xingin.xhs" class="android.widget.EditText" focused="true" text="${sent ? "请友善发言..." : "测试"}" bounds="[165,1333][811,1443]" />
    <node package="com.xingin.xhs" class="android.widget.TextView" text="发送" clickable="true" enabled="true" bounds="[921,1344][1025,1432]" />
  </node></hierarchy>`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "xhs-dm-send", expectedDraft: "测试", endpoint: "ws://127.0.0.1:22222/",
      outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          assert.deepEqual(request.data, { type: "10", x: "90.092593", y: "57.833333" });
          pointerCalls += 1;
          sent = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        const value = request.data.command === "wm size" ? "Physical size: 1080x2400" : ui();
        return { code: 10_000, message: "SUCCESS", data: { opaque: value } };
      },
    });
    assert.equal(pointerCalls, 1);
    assert.deepEqual(result, {
      machine: "02", status: "verified", draftLength: 2,
      verification: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_and_message_echo",
      transport: "xiaowei-api", localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("xhs.dm.send degrades to mitigated when the sent bubble stays unreadable", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-xhs-dm-send-mitigated-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-xhs-dm-send-mitigated");
  let sent = false;
  let pointerCalls = 0;
  const ui = () => `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" class="android.widget.TextView" text="发送" clickable="true" enabled="true" bounds="[827,1196][959,1261]" />
    <node package="com.xingin.xhs" class="android.widget.EditText" focused="true" text="${sent ? "请友善发言..." : "测试"}" bounds="[165,1333][811,1443]" />
    <node package="com.xingin.xhs" class="android.widget.TextView" text="发送" clickable="true" enabled="true" bounds="[921,1344][1025,1432]" />
  </node></hierarchy>`;
  try {
    const result = await runXiaoweiDeviceRead({
      action: "xhs-dm-send", expectedDraft: "测试", endpoint: "ws://127.0.0.1:22222/",
      outputRoot, targets: [target()],
    }, {
      projectRoot,
      delay: async () => {},
      dmDegradedEchoBudgetMs: 0,
      sendRequest: async (request) => {
        if (request.action === "pointerEvent") {
          pointerCalls += 1;
          sent = true;
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        const value = request.data.command === "wm size" ? "Physical size: 1080x2400" : ui();
        return { code: 10_000, message: "SUCCESS", data: { opaque: value } };
      },
    });
    assert.equal(pointerCalls, 1);
    assert.deepEqual(result, {
      machine: "02", status: "mitigated", draftLength: 2,
      verification: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_without_message_echo",
      transport: "xiaowei-api", localAdbRequired: false,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("device screen composes screencap and pullFile then removes the phone artifact", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-read-screen-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-screen");
  const actions = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "screen", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pullFile") await writeFile(request.data.savePath, VALID_PNG);
        const data = request.action === "adb_shell" && request.data.command.startsWith("if [ -s")
          ? { "secret-device-identifier": String(VALID_PNG.length) }
          : null;
        return { code: 10_000, message: "SUCCESS", data };
      },
      delay: async () => {},
    });
    assert.deepEqual(actions, ["adb_shell", "adb_shell", "pullFile", "adb_shell"]);
    assert.equal(result.success, 1);
    assert.equal(result.results[0].cleanup, "completed");
    assert.equal(result.results[0].width, 1);
    assert.deepEqual(await readFile(result.results[0].screenshotPath), VALID_PNG);
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("app open checks installation, uses official startApk, and verifies fresh UI", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-open-app-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-open");
  const actions = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "open-app",
      package: "com.example.approved",
      endpoint: "ws://127.0.0.1:22222/",
      outputRoot,
      targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "apkList") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: [{ packageName: "com.example.approved" }] } };
        }
        if (request.action === "startApk") {
          assert.deepEqual(request.data, { apk: "com.example.approved" });
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        return {
          code: 10_000,
          message: "SUCCESS",
          data: { opaque: "<hierarchy><node package=\"com.example.approved\" /></hierarchy>" },
        };
      },
      delay: async () => {},
    });
    assert.deepEqual(actions, ["apkList", "startApk", "adb_shell"]);
    assert.equal(result.success, 1);
    assert.equal(result.results[0].verificationOutcome, "verified");
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("home resolves the launcher, sends official pushEvent, and verifies fresh UI", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-home-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-home");
  const actions = [];
  try {
    const result = await runXiaoweiDeviceRead({
      action: "home", endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, {
      projectRoot,
      sendRequest: async (request) => {
        actions.push(request.action);
        if (request.action === "pushEvent") {
          assert.deepEqual(request.data, { type: "2" });
          return { code: 10_000, message: "SUCCESS", data: null };
        }
        if (request.data.command.startsWith("cmd package resolve-activity")) {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "com.vendor.launcher/.Home" } };
        }
        return {
          code: 10_000,
          message: "SUCCESS",
          data: { opaque: "<hierarchy><node package=\"com.vendor.launcher\" /></hierarchy>" },
        };
      },
      delay: async () => {},
    });
    assert.deepEqual(actions, ["adb_shell", "pushEvent", "adb_shell"]);
    assert.equal(result.success, 1);
    assert.equal(result.results[0].verificationOutcome, "verified");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("package and hierarchy helpers require exact package matches", () => {
  assert.equal(packageInventoryContains({ list: ["com.example.app"] }, "com.example.app"), true);
  assert.equal(packageInventoryContains({ list: ["com.example.app.extra"] }, "com.example.app"), false);
  assert.equal(hierarchyContainsPackage('<node package="com.example.app" />', "com.example.app"), true);
  assert.equal(hierarchyContainsPackage('<node package="com.example.app.extra" />', "com.example.app"), false);
});

test("package-bound text taps reject cross-app and same-app ambiguity", () => {
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" text="发送" clickable="true" bounds="[800,1800][1000,1940]" />'
    + '<node package="com.tencent.mm" text="发送" clickable="true" bounds="[100,200][300,340]" /></hierarchy>';
  assert.deepEqual(findSemanticTapPoint(hierarchy, "发送", { width: 1080, height: 2400 }, {
    packageName: "com.xingin.xhs",
  }), { x: "83.333333", y: "77.916667" });
  const ambiguous = hierarchy.replace("</hierarchy>", '<node package="com.xingin.xhs" text="发送" clickable="true" bounds="[500,1800][700,1940]" /></hierarchy>');
  assert.throws(() => findSemanticTapPoint(ambiguous, "发送", { width: 1080, height: 2400 }, {
    packageName: "com.xingin.xhs",
  }), /NODE_AMBIGUOUS/u);
  const replies = '<hierarchy><node package="com.xingin.xhs" clickable="true" bounds="[0,300][1080,500]">'
    + '<node package="com.xingin.xhs" text="昨天 北京 回复" bounds="[100,420][700,480]" /></node>'
    + '<node package="com.xingin.xhs" clickable="true" bounds="[0,600][1080,800]">'
    + '<node package="com.xingin.xhs" text="今天 上海 回复" bounds="[100,720][700,780]" /></node></hierarchy>';
  assert.deepEqual(findSemanticTapPoint(replies, "回复", { width: 1080, height: 2400 }, {
    packageName: "com.xingin.xhs", match: "suffix", ordinal: 2,
  }), { x: "37.037037", y: "31.25" });
  assert.throws(() => findSemanticTapPoint(replies, "回复", { width: 1080, height: 2400 }, {
    packageName: "com.xingin.xhs", match: "suffix",
  }), /NODE_AMBIGUOUS/u);
});

test("suffix reply targets tolerate a trailing translate chip", () => {
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" bounds="[0,600][1080,900]">'
    + '<node package="com.xingin.xhs" text="7分钟前 中国台湾 回复 翻译" clickable="false" bounds="[168,769][810,824]" /></node></hierarchy>';
  assert.deepEqual(findSemanticTapPoint(hierarchy, "回复", { width: 1080, height: 2400 }, {
    packageName: "com.xingin.xhs", match: "suffix", ordinal: 1,
  }), { x: "45.277778", y: "33.1875" });
});
