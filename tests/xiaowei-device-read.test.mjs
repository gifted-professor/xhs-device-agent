import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPublicDeviceList,
  extractSingleDeviceValue,
  extractUiHierarchy,
  inspectPng,
  hierarchyContainsPackage,
  inferWechatMeBounds,
  packageInventoryContains,
  parsePrivateSize,
  runXiaoweiDeviceRead,
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

test("device.node.activate re-resolves, sends one event, and verifies a fresh text postcondition", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaowei-node-activate-"));
  const outputRoot = path.join(projectRoot, "data", "matrix", "runs", "run-node-activate");
  let activated = false;
  let pointerEvents = 0;
  const before = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node clickable="true" enabled="true" text="Open" bounds="[100,2100][300,2180]" /></node></hierarchy>';
  const after = '<hierarchy><node package="com.example.app" bounds="[0,0][1080,2400]"><node text="Done" bounds="[100,400][300,480]" /></node></hierarchy>';
  try {
    const result = await runXiaoweiDeviceRead({
      action: "node-activate", package: "com.example.app",
      selector: { label: "Open", role: "button", sources: ["accessibility"] },
      postcondition: { kind: "text", value: "Done" },
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
      localOcr: async () => ({ matches: [], ocrAvailable: true }),
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
  const hierarchy = '<hierarchy><node package="com.xingin.xhs" resource-id="home_feed"><node content-desc="笔记 公开标题 来自公开作者 7赞" /><node content-desc="消息,1条未读" /></node></hierarchy>';
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
    assert.equal(result.stability, "two_fresh_ui_intersection");
    assert.equal(result.localAdbRequired, false);
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|serial|alias|消息|未读/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("XHS visible-card opening resolves the ordinal twice, sends one pointer event, and verifies detail", async () => {
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
        if (request.data.command === "wm size") {
          return { code: 10_000, message: "SUCCESS", data: { opaque: "Physical size: 1080x2400" } };
        }
        uiReads += 1;
        return { code: 10_000, message: "SUCCESS", data: { opaque: uiReads <= 2 ? home : detail } };
      },
      delay: async () => {},
    });
    assert.equal(actions.filter((action) => action === "pointerEvent").length, 1);
    assert.equal(result.selected.ordinal, 1);
    assert.equal(result.detail.title, "公开标题");
    assert.equal(result.verification, "single_pointer_event_then_two_fresh_detail_ui_reads");
    assert.doesNotMatch(JSON.stringify(result), /secret-device-identifier|serial|alias|coordinate|"x"|"y"/iu);
    await assert.rejects(() => runXiaoweiDeviceRead({
      action: "xhs-open-visible", ordinal: 0, endpoint: "ws://127.0.0.1:22222/", outputRoot, targets: [target()],
    }, { projectRoot, xhsRulesPath: rulesPath }), /ordinal/u);
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
