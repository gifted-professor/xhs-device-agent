import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRemoteArgv,
  createRemoteGateway,
  parseStructuredReadOutput,
  sanitizeCommandOutput,
} from "../scripts/xhs-remote-gateway.mjs";

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
  assert.deepEqual(buildRemoteArgv({ command: "xhs.open-visible", machine: "04", ordinal: 2 }), [
    "xhs", "open-visible", "--machine", "04", "--ordinal", "2",
  ]);
  assert.throws(
    () => buildRemoteArgv({ command: "xhs.open-visible", machine: "04", ordinal: 0 }),
    /ordinal/u,
  );
  assert.deepEqual(buildRemoteArgv({ command: "app.open", machine: "03", package: "com.tencent.mm" }), [
    "app", "open", "--machine", "03", "--package", "com.tencent.mm",
  ]);
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

test("generic node commands carry a closed selector and never caller coordinates", () => {
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
  assert.doesNotMatch(JSON.stringify(resolved), /"(?:serial|alias|deviceId|x|y|path|left|top|right|bottom)"/iu);
  const activated = parseStructuredReadOutput("device.node.activate", JSON.stringify({
    machine: "03", status: "verified",
    node: { label: "我", role: "tab", group: null, ordinal: null, source: "ocr", unique: true },
    verification: "node_rechecked_then_single_pointer_event_then_fresh_postcondition",
    transport: "xiaowei-api", localAdbRequired: false,
  }));
  assert.equal(activated.status, "verified");
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
    notes: [{ title: "公开标题", author: "公开作者", mediaType: "image", metrics: { likes: "12" } }],
    detail: null,
    profile: null,
    visibleLabels: ["公开话题"],
    stability: "two_fresh_ui_intersection",
    transport: "xiaowei-api",
    localAdbRequired: false,
  }));
  assert.equal(xhs.notes[0].title, "公开标题");
  assert.doesNotMatch(JSON.stringify(xhs), /serial|alias|deviceId|消息|未读/iu);
  assert.throws(() => parseStructuredReadOutput("xhs.observe", JSON.stringify({
    ...xhs,
    serial: "private-identifier",
  })), /invalid public shape/u);
  const opened = parseStructuredReadOutput("xhs.open-visible", JSON.stringify({
    ...xhs,
    selected: { ordinal: 1, title: "公开标题", author: "公开作者", mediaType: "image" },
    page: { state: "IMAGE_NOTE", score: 1, margin: 0.5 },
    detail: {
      title: "公开标题", author: "公开作者", body: "公开正文", publishedAtOrRegion: "07-10广西",
      media: { type: "image", count: 6 }, metrics: { likes: "12", favorites: null, comments: "3" },
    },
    verification: "single_pointer_event_then_two_fresh_detail_ui_reads",
  }));
  assert.equal(opened.detail.body, "公开正文");
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
  const json = sanitizeCommandOutput(JSON.stringify({
    serial: "ABC123", hierarchyPath: "C:\\private\\internal-alias\\window.xml",
    nested: { token: "secret", alias: "internal-alias", value: 1 },
  }));
  assert.deepEqual(JSON.parse(json), {
    serial: "[redacted]", hierarchyPath: "[redacted]",
    nested: { token: "[redacted]", alias: "[redacted]", value: 1 },
  });
  const text = sanitizeCommandOutput("ABC12345 device product:test\nserial=ABC123");
  assert.doesNotMatch(text, /ABC123/u);
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
