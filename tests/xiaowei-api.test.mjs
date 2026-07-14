import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runXiaoweiCli, sendXiaoweiRequest } from "../scripts/greenarrow-api.mjs";
import { listXiaoweiActions } from "../scripts/xiaowei-action-catalog.mjs";
import { XiaoweiTransportError } from "../scripts/xiaowei-transport.mjs";
import { createXiaoweiTextInputAdapter, validateXiaoweiTextInputConfig } from "../scripts/xiaowei-text-input.mjs";

const inspectTrustedMatrixParent = async () => ({
  name: "powershell.exe",
  commandLine: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.resolve("scripts", "Invoke-MatrixAction.ps1")}" -Action ListApps`,
});
const TEST_GATEWAY_KEY = Buffer.alloc(32, 7).toString("base64");

function writeSignedGatewayFiles(directory, request, options = {}) {
  const requestFile = path.join(directory, "request.json");
  const grantFile = path.join(directory, "grant.json");
  const requestSource = JSON.stringify(request);
  writeFileSync(requestFile, requestSource);
  const now = options.now ?? Date.now();
  const payload = {
    action: request.action,
    deviceAlias: "device-01",
    deviceSerial: request.devices,
    xiaoweiVersion: "test-version",
    endpoint: "ws://127.0.0.1:22222/",
    requestSha256: createHash("sha256").update(requestSource).digest("hex"),
    issuedAt: now - 100,
    expiresAt: now + 29_000,
    authorization: options.authorization ?? {},
    ...(options.payload ?? {}),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const mac = createHmac("sha256", Buffer.from(options.gatewayKey ?? TEST_GATEWAY_KEY, "base64"))
    .update(encodedPayload, "utf8").digest("hex");
  writeFileSync(grantFile, JSON.stringify({ schemaVersion: 1, payload: encodedPayload, mac }));
  return { requestFile, grantFile, payload };
}

function trustedGatewayRuntime(overrides = {}) {
  return {
    inspectParentProcess: inspectTrustedMatrixParent,
    gatewayKey: TEST_GATEWAY_KEY,
    ...overrides,
  };
}

test("internal list writes identifiers only to a temporary result file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    let stdout = "";
    await runXiaoweiCli(["list", "--internal-gateway", "--result-file", resultFile], {
      inspectParentProcess: inspectTrustedMatrixParent,
      output: { write(value) { stdout += value; } },
      sendRequest: async () => ({ code: 10000, message: "SUCCESS", data: [{ serial: "private-serial" }] }),
    });
    assert.equal(stdout, "");
    assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).data[0].serial, "private-serial");
    await assert.rejects(() => runXiaoweiCli(["list"], {
      sendRequest: async () => { throw new Error("must not send"); },
    }), /internal to the verified device gateway/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("internal invoke cannot expose catalog-only actions", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    const { requestFile, grantFile } = writeSignedGatewayFiles(directory, {
      action: "pointerEvent", devices: "private-serial", data: { type: "10", x: "1", y: "1" },
    });
    let sent = false;
    await assert.rejects(() => runXiaoweiCli([
      "invoke", "--internal-gateway", "--request-file", requestFile,
      "--grant-file", grantFile, "--result-file", resultFile,
    ], trustedGatewayRuntime({ sendRequest: async () => { sent = true; return {}; } })), /only verified operator actions/u);
    assert.equal(sent, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("internal gateway rejects every action outside its fixed operator allowlist before sending", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  const operatorActions = new Set(["screen", "pushEvent", "apkList", "startApk", "stopApk"]);
  try {
    const resultFile = path.join(directory, "result.json");
    for (const { action } of listXiaoweiActions()) {
      if (operatorActions.has(action)) continue;
      const definition = listXiaoweiActions().find((entry) => entry.action === action);
      const request = { action };
      if (definition.devices === "required") request.devices = "private-serial";
      const { requestFile, grantFile } = writeSignedGatewayFiles(directory, request);
      let sent = false;
      await assert.rejects(() => runXiaoweiCli([
        "invoke", "--internal-gateway", "--request-file", requestFile,
        "--grant-file", grantFile, "--result-file", resultFile,
      ], trustedGatewayRuntime({ sendRequest: async () => { sent = true; return {}; } })), /only verified operator actions/u, action);
      assert.equal(sent, false, action);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved read-only app inventory keeps device identifiers out of stdout", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    const { requestFile, grantFile } = writeSignedGatewayFiles(directory, { action: "apkList", devices: "private-serial" });
    let stdout = "";
    await runXiaoweiCli([
      "invoke", "--internal-gateway", "--request-file", requestFile,
      "--grant-file", grantFile, "--result-file", resultFile,
    ], trustedGatewayRuntime({
      output: { write(value) { stdout += value; } },
      sendRequest: async () => ({
        code: 10000,
        message: "SUCCESS",
        data: { "private-serial": [{ packageName: "com.xingin.xhs" }] },
      }),
    }));
    assert.equal(stdout, "");
    assert.equal(JSON.parse(readFileSync(resultFile, "utf8")).data["private-serial"][0].packageName, "com.xingin.xhs");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a self-authored legacy policy cannot invoke an operator action", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const requestFile = path.join(directory, "request.json");
    const policyFile = path.join(directory, "policy.json");
    const resultFile = path.join(directory, "result.json");
    writeFileSync(requestFile, JSON.stringify({ action: "apkList", devices: "private-serial" }));
    writeFileSync(policyFile, JSON.stringify({ acceptedActions: ["apkList"], authorization: {} }));
    let sent = false;
    await assert.rejects(() => runXiaoweiCli([
      "invoke", "--internal-gateway", "--request-file", requestFile,
      "--policy-file", policyFile, "--result-file", resultFile,
    ], trustedGatewayRuntime({ sendRequest: async () => { sent = true; return {}; } })), /Unknown Xiaowei internal option/u);
    assert.equal(sent, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a signed grant cannot authorize a request that was changed afterward", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const { requestFile, grantFile } = writeSignedGatewayFiles(directory, { action: "apkList", devices: "private-serial" });
    const resultFile = path.join(directory, "result.json");
    writeFileSync(requestFile, JSON.stringify({ action: "apkList", devices: "other-private-serial" }));
    let sent = false;
    await assert.rejects(() => runXiaoweiCli([
      "invoke", "--internal-gateway", "--request-file", requestFile,
      "--grant-file", grantFile, "--result-file", resultFile,
    ], trustedGatewayRuntime({ sendRequest: async () => { sent = true; return {}; } })), /capability grant is invalid/u);
    assert.equal(sent, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing, incorrect, and expired gateway grants fail before sending", async () => {
  const cases = [
    { name: "missing key", runtime: { gatewayKey: "" } },
    { name: "incorrect key", runtime: { gatewayKey: Buffer.alloc(32, 9).toString("base64") } },
    { name: "expired", expired: true },
  ];
  for (const item of cases) {
    const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
    try {
      const now = Date.now();
      const payload = item.expired ? { issuedAt: now - 30_000, expiresAt: now - 1 } : {};
      const { requestFile, grantFile } = writeSignedGatewayFiles(
        directory,
        { action: "apkList", devices: "private-serial" },
        { now, payload },
      );
      const resultFile = path.join(directory, "result.json");
      let sent = false;
      await assert.rejects(() => runXiaoweiCli([
        "invoke", "--internal-gateway", "--request-file", requestFile,
        "--grant-file", grantFile, "--result-file", resultFile,
      ], trustedGatewayRuntime({
        ...(item.runtime ?? {}),
        now: () => now,
        sendRequest: async () => { sent = true; return {}; },
      })), /capability grant is invalid/u, item.name);
      assert.equal(sent, false, item.name);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("result paths outside the OS temporary directory fail before any device request", async () => {
  const resultFile = path.join(process.cwd(), `xiaowei-result-${process.pid}-${Date.now()}.json`);
  let sent = false;
  await assert.rejects(() => runXiaoweiCli([
    "list", "--internal-gateway", "--result-file", resultFile,
  ], { inspectParentProcess: inspectTrustedMatrixParent, sendRequest: async () => { sent = true; return {}; } }), /operating-system temporary directory/u);
  assert.equal(sent, false);
});

test("an existing result file is never overwritten and fails before sending", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    writeFileSync(resultFile, "keep-me", { flag: "wx" });
    let sent = false;
    await assert.rejects(() => runXiaoweiCli([
      "list", "--internal-gateway", "--result-file", resultFile,
    ], { inspectParentProcess: inspectTrustedMatrixParent, sendRequest: async () => { sent = true; return {}; } }), /EEXIST|exist/u);
    assert.equal(sent, false);
    assert.equal(readFileSync(resultFile, "utf8"), "keep-me");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a result persistence failure after a response is conservatively reported as sent and unknown", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    await assert.rejects(() => runXiaoweiCli([
      "list", "--internal-gateway", "--result-file", resultFile,
    ], {
      inspectParentProcess: inspectTrustedMatrixParent,
      sendRequest: async () => ({ code: 10000, message: "SUCCESS", data: "x".repeat(4 * 1024 * 1024) }),
    }), (error) => {
      assert.equal(error.outcome, "unknown");
      assert.equal(error.sent, true);
      assert.equal(error.action, "list");
      return true;
    });
    assert.throws(() => readFileSync(resultFile, "utf8"), /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("internal gateway rejects a direct non-wrapper caller before any device request", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-xiaowei-cli-"));
  try {
    const resultFile = path.join(directory, "result.json");
    let sent = false;
    await assert.rejects(() => runXiaoweiCli([
      "list", "--internal-gateway", "--result-file", resultFile,
    ], {
      inspectParentProcess: async () => ({ name: "node.exe", commandLine: "node scripts/xiaowei-api.mjs list" }),
      sendRequest: async () => { sent = true; return {}; },
    }), /canonical unified PowerShell wrapper/u);
    assert.equal(sent, false);
    assert.throws(() => readFileSync(resultFile, "utf8"), /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Xiaowei WebSocket client sends the requested action instead of a fixed list probe", async () => {
  let sent;
  class MockWebSocket {
    constructor(endpoint) {
      this.endpoint = endpoint;
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get("open")?.());
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(payload) {
      sent = JSON.parse(payload);
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ code: 10000, message: "SUCCESS", data: null }) }));
    }
    close() {}
  }
  const request = { action: "imeList", devices: "test-device" };
  const response = await sendXiaoweiRequest(request, { endpoint: "ws://127.0.0.1:22222/", WebSocketImpl: MockWebSocket });
  assert.deepEqual(sent, request);
  assert.equal(response.code, 10000);
});

test("Xiaowei API client rejects non-loopback endpoints", () => {
  assert.throws(
    () => sendXiaoweiRequest({ action: "list" }, { endpoint: "wss://example.com/socket", WebSocketImpl: class {} }),
    /local loopback/u,
  );
});

test("malformed responses after send preserve a structured unknown outcome", async () => {
  class MalformedWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get("open")?.());
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send() { queueMicrotask(() => this.listeners.get("message")?.({ data: "not-json" })); }
    close() {}
  }
  await assert.rejects(
    () => sendXiaoweiRequest({ action: "list" }, { WebSocketImpl: MalformedWebSocket }),
    (error) => {
      assert.ok(error instanceof XiaoweiTransportError);
      assert.equal(error.outcome, "unknown");
      assert.equal(error.sent, true);
      return true;
    },
  );
});

test("approved Xiaowei text input selects a bridge IME, sends Unicode, and restores the prior IME", async () => {
  const nativeIme = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  const otherBridgeIme = "com.xiaowei.assistant/.keyboard.XwIME";
  let currentIme = nativeIme;
  let pendingIme = null;
  let pendingImeReads = 0;
  const enabledImes = new Set([nativeIme]);
  const calls = [];
  const commands = [];
  const verificationOrder = [];
  const sendRequest = async (request) => {
    calls.push(request);
    if (request.action === "list") return { code: 10000, message: "SUCCESS", data: [{ serial: "test-serial" }] };
    if (request.action === "imeList") return { code: 10000, message: "SUCCESS", data: { "test-serial": [nativeIme, otherBridgeIme, bridgeIme] } };
    if (request.action === "selectIme") {
      pendingIme = request.data.ime;
      pendingImeReads = 0;
    }
    return { code: 10000, message: "SUCCESS", data: null };
  };
  const adapter = createXiaoweiTextInputAdapter({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "test-version",
      currentXiaoweiVersion: "test-version",
    },
    adbPath: "test-adb",
    expectedPackage: "com.xingin.xhs",
    expectedOnlineSerials: ["test-serial"],
    devices: [{ alias: "content-01", serial: "test-serial" }],
    approvedAliases: ["content-01"],
    preferredImeServices: [otherBridgeIme, bridgeIme],
    perDevice: { "content-01": { preferredImeService: bridgeIme, allowTemporaryEnable: true, echoVerification: "ui_text" } },
  }, {
    sendRequest,
    commandRunner: async (_adbPath, _serial, args) => {
      commands.push(args);
      if (args.join(" ") === "shell ime list -s") return [...enabledImes].join("\n");
      if (args.slice(0, 3).join(" ") === "shell ime enable") {
        enabledImes.add(args[3]);
        return "enabled";
      }
      if (args.slice(0, 3).join(" ") === "shell ime disable") {
        enabledImes.delete(args[3]);
        return "disabled";
      }
      if (args.join(" ") === "shell dumpsys input_method") return `mCurMethodId=${currentIme}`;
      if (args.includes("default_input_method")) {
        if (pendingIme) {
          pendingImeReads += 1;
          if (pendingImeReads >= 2) {
            currentIme = pendingIme;
            pendingIme = null;
          }
        }
        return currentIme;
      }
      if (args.join(" ") === "shell dumpsys window") {
        return "mCurrentFocus=Window{1 u0 com.xingin.xhs/.index.v2.IndexActivity}";
      }
      return "";
    },
    sleep: async () => {},
  });
  const inputSession = await adapter({
    deviceAlias: "content-01",
    text: "测试",
    verifyFocusedEditor: async () => { verificationOrder.push("focused"); },
    verifyCleared: async () => { verificationOrder.push("cleared"); },
  });
  assert.deepEqual(inputSession.audit, {
    adapter: "xiaowei_api",
    apiIdentityVerified: true,
    bridgeSelectionVerified: true,
    focusedEditorVerified: true,
    clearVerified: true,
    apiAccepted: true,
    echoVerified: false,
    restoreAttempted: false,
    restoreVerified: false,
  });
  assert.deepEqual(verificationOrder, ["focused", "focused", "cleared"]);
  assert.equal(commands.some((args) => args.join(" ") === "shell dumpsys window windows"), true);
  assert.equal(commands.some((args) => args.join(" ") === "shell dumpsys window"), true);
  assert.deepEqual(calls.map((call) => call.action), ["list", "imeList", "selectIme", "inputText"]);
  assert.equal(calls[2].data.ime, bridgeIme, "the per-device profile must win over global service order");
  assert.equal(calls[3].data.content, "测试");
  const backwardClear = commands.at(-2);
  const forwardClear = commands.at(-1);
  assert.deepEqual(backwardClear.slice(0, 4), ["shell", "input", "keyevent", "KEYCODE_MOVE_END"]);
  assert.equal(backwardClear.filter((value) => value === "KEYCODE_DEL").length, 256);
  assert.deepEqual(forwardClear.slice(0, 4), ["shell", "input", "keyevent", "KEYCODE_MOVE_HOME"]);
  assert.equal(forwardClear.filter((value) => value === "KEYCODE_FORWARD_DEL").length, 256);
  assert.equal(currentIme, bridgeIme);
  assert.equal(enabledImes.has(bridgeIme), true);
  assert.equal(commands.filter((args) => args.includes("default_input_method")).length, 3);
  await inputSession.restore();
  assert.equal(inputSession.audit.restoreAttempted, true);
  assert.equal(inputSession.audit.restoreVerified, true);
  assert.deepEqual(calls.map((call) => call.action), ["list", "imeList", "selectIme", "inputText", "selectIme"]);
  assert.equal(commands.some((args) => args.join(" ") === `shell ime enable ${bridgeIme}`), true);
  assert.equal(commands.some((args) => args.join(" ") === `shell ime disable ${bridgeIme}`), true);
  assert.equal(enabledImes.has(bridgeIme), false);
  assert.equal(commands.filter((args) => args.includes("default_input_method")).length, 5);
  assert.equal(currentIme, nativeIme);
});

test("local-OCR profiles defer clear evidence and move the caret before visual verification", async () => {
  const nativeIme = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = nativeIme;
  const commands = [];
  const calls = [];
  const adapter = createXiaoweiTextInputAdapter({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "test-version",
      currentXiaoweiVersion: "test-version",
    },
    adbPath: "test-adb",
    expectedOnlineSerials: ["test-serial"],
    devices: [{ alias: "content-01", serial: "test-serial" }],
    approvedAliases: ["content-01"],
    preferredImeServices: [bridgeIme],
    perDevice: { "content-01": { preferredImeService: bridgeIme, allowTemporaryEnable: false, echoVerification: "local_ocr" } },
  }, {
    sendRequest: async (request) => {
      calls.push(request);
      if (request.action === "list") return { code: 10000, message: "SUCCESS", data: [{ serial: "test-serial" }] };
      if (request.action === "imeList") return { code: 10000, message: "SUCCESS", data: { "test-serial": [bridgeIme] } };
      if (request.action === "selectIme") currentIme = request.data.ime;
      return { code: 10000, message: "SUCCESS", data: null };
    },
    commandRunner: async (_adbPath, _serial, args) => {
      commands.push(args);
      if (args.join(" ") === "shell ime list -s") return `${nativeIme}\n${bridgeIme}`;
      if (args.join(" ") === "shell dumpsys input_method") return `mCurMethodId=${currentIme}`;
      if (args.includes("default_input_method")) return currentIme;
      return "";
    },
    sleep: async () => {},
  });
  let clearCallbackCalls = 0;
  const inputSession = await adapter({
    deviceAlias: "content-01",
    text: "娴嬭瘯",
    verifyFocusedEditor: async () => {},
    verifyCleared: async () => { clearCallbackCalls += 1; throw new Error("must be deferred"); },
  });
  assert.equal(clearCallbackCalls, 0);
  assert.equal(inputSession.audit.clearVerified, false);
  assert.equal(inputSession.audit.apiAccepted, true);
  const keyCommands = commands.filter((args) => args.slice(0, 3).join(" ") === "shell input keyevent");
  assert.equal(keyCommands.some((args) => args.includes("KEYCODE_FORWARD_DEL")), true);
  assert.deepEqual(keyCommands.at(-1), ["shell", "input", "keyevent", "KEYCODE_MOVE_END"]);
  assert.deepEqual(calls.map((call) => call.action), ["list", "imeList", "selectIme", "inputText"]);
  await inputSession.restore();
  assert.equal(inputSession.audit.restoreVerified, true);
});

test("enabled Xiaowei text input requires explicit per-alias and bridge-service approval", () => {
  assert.throws(() => validateXiaoweiTextInputConfig({
    endpoint: "ws://127.0.0.1:22222/",
    textInput: { enabled: true, humanApproved: false, approvedAliases: [], preferredImeServices: [] },
  }, new Set(["content-01"])), /requires human approval/u);
});

test("enabled Xiaowei text input also requires exact version and all three accepted actions", () => {
  assert.throws(() => validateXiaoweiTextInputConfig({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "accepted",
      currentXiaoweiVersion: "different",
    },
    textInput: {
      enabled: true,
      humanApproved: true,
      approvedAliases: ["content-01"],
      preferredImeServices: ["com.android.xwkeyboard/.XwIME"],
      perDevice: { "content-01": { preferredImeService: "com.android.xwkeyboard/.XwIME", allowTemporaryEnable: false, echoVerification: "ui_text" } },
    },
  }, new Set(["content-01"])), /exact Xiaowei version/u);
});

test("enabled Xiaowei text input requires explicit temporary-enable and echo-verification fields", () => {
  const base = {
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "accepted",
      currentXiaoweiVersion: "accepted",
    },
    textInput: {
      enabled: true,
      humanApproved: true,
      approvedAliases: ["content-01"],
      preferredImeServices: ["com.android.xwkeyboard/.XwIME"],
      perDevice: {},
    },
  };
  for (const profile of [
    { preferredImeService: "com.android.xwkeyboard/.XwIME", echoVerification: "ui_text" },
    { preferredImeService: "com.android.xwkeyboard/.XwIME", allowTemporaryEnable: false },
    { preferredImeService: "com.android.xwkeyboard/.XwIME", allowTemporaryEnable: false, echoVerification: "automatic" },
  ]) {
    assert.throws(() => validateXiaoweiTextInputConfig({
      ...base,
      textInput: { ...base.textInput, perDevice: { "content-01": profile } },
    }, new Set(["content-01"])), /temporary IME enable|echo verification/u);
  }
});

test("Xiaowei text acceptance cannot move to a different physical device under the same alias", () => {
  assert.throws(() => createXiaoweiTextInputAdapter({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "previous-serial" },
      acceptedXiaoweiVersion: "test-version",
      currentXiaoweiVersion: "test-version",
    },
    adbPath: "test-adb",
    expectedOnlineSerials: ["replacement-serial"],
    devices: [{ alias: "content-01", serial: "replacement-serial" }],
    approvedAliases: ["content-01"],
    preferredImeServices: ["com.android.xwkeyboard/.XwIME"],
    perDevice: {
      "content-01": {
        preferredImeService: "com.android.xwkeyboard/.XwIME",
        allowTemporaryEnable: false,
        echoVerification: "ui_text",
      },
    },
  }), /not bound to this physical device/u);
});

test("Xiaowei input never calls inputText when the cleared editor cannot be verified", async () => {
  const nativeIme = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  let currentIme = nativeIme;
  const enabledImes = new Set([nativeIme]);
  const calls = [];
  const adapter = createXiaoweiTextInputAdapter({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "test-version",
      currentXiaoweiVersion: "test-version",
    },
    adbPath: "test-adb",
    expectedOnlineSerials: ["test-serial"],
    devices: [{ alias: "content-01", serial: "test-serial" }],
    approvedAliases: ["content-01"],
    preferredImeServices: [bridgeIme],
    perDevice: { "content-01": { preferredImeService: bridgeIme, allowTemporaryEnable: true, echoVerification: "ui_text" } },
  }, {
    sendRequest: async (request) => {
      calls.push(request);
      if (request.action === "list") return { code: 10000, message: "SUCCESS", data: [{ serial: "test-serial" }] };
      if (request.action === "imeList") return { code: 10000, message: "SUCCESS", data: { "test-serial": [bridgeIme] } };
      if (request.action === "selectIme") currentIme = request.data.ime;
      return { code: 10000, message: "SUCCESS", data: null };
    },
    commandRunner: async (_adbPath, _serial, args) => {
      if (args.join(" ") === "shell ime list -s") return [...enabledImes].join("\n");
      if (args.slice(0, 3).join(" ") === "shell ime enable") {
        enabledImes.add(args[3]);
        return "enabled";
      }
      if (args.slice(0, 3).join(" ") === "shell ime disable") {
        enabledImes.delete(args[3]);
        return "disabled";
      }
      if (args.join(" ") === "shell dumpsys input_method") return `mCurMethodId=${currentIme}`;
      return args.includes("default_input_method") ? currentIme : "";
    },
    sleep: async () => {},
  });

  await assert.rejects(adapter({
    deviceAlias: "content-01",
    text: "测试",
    verifyFocusedEditor: async () => {},
    verifyCleared: async () => { throw new Error("old value remains"); },
  }), (error) => {
    assert.equal(error.name, "XiaoweiTextInputError");
    assert.equal(error.action, "clear");
    assert.equal(error.code, "CLEAR_UNVERIFIED");
    assert.equal(error.inputMethodAudit.apiIdentityVerified, true);
    assert.equal(error.inputMethodAudit.focusedEditorVerified, true);
    assert.equal(error.inputMethodAudit.bridgeSelectionVerified, true);
    assert.equal(error.inputMethodAudit.clearVerified, false);
    assert.equal(error.inputMethodAudit.restoreVerified, true);
    return true;
  });
  assert.equal(calls.some((call) => call.action === "inputText"), false);
  assert.equal(currentIme, nativeIme);
  assert.equal(enabledImes.has(bridgeIme), false);
});

test("Xiaowei pre-input identity failures retain a stage code and partial audit", async () => {
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  const calls = [];
  const adapter = createXiaoweiTextInputAdapter({
    endpoint: "ws://127.0.0.1:22222/",
    api: {
      enabled: true,
      acceptedActions: ["imeList", "selectIme", "inputText"],
      acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
      acceptedDeviceSerialsByAlias: { "content-01": "test-serial" },
      acceptedXiaoweiVersion: "test-version",
      currentXiaoweiVersion: "test-version",
    },
    adbPath: "test-adb",
    expectedOnlineSerials: ["test-serial"],
    devices: [{ alias: "content-01", serial: "test-serial" }],
    approvedAliases: ["content-01"],
    preferredImeServices: [bridgeIme],
    perDevice: { "content-01": { preferredImeService: bridgeIme, allowTemporaryEnable: true, echoVerification: "ui_text" } },
  }, {
    sendRequest: async (request) => {
      calls.push(request);
      return { code: 10000, message: "SUCCESS", data: [] };
    },
    commandRunner: async () => { throw new Error("ADB must not run after identity mismatch"); },
    sleep: async () => {},
  });

  await assert.rejects(adapter.verifyIdentity(), (error) => {
    assert.equal(error.code, "XIAOWEI_IDENTITY_MISMATCH");
    assert.equal(error.message, "API and ADB device identities differ");
    return true;
  });
  assert.deepEqual(calls.map((call) => call.action), ["list"]);
  calls.length = 0;

  await assert.rejects(adapter({
    deviceAlias: "content-01",
    text: "测试",
    verifyFocusedEditor: async () => {},
    verifyCleared: async () => {},
  }), (error) => {
    assert.equal(error.name, "XiaoweiTextInputError");
    assert.equal(error.action, "identity");
    assert.equal(error.code, "IDENTITY_MISMATCH");
    assert.deepEqual(error.inputMethodAudit, {
      adapter: "xiaowei_api",
      apiIdentityVerified: false,
      bridgeSelectionVerified: false,
      focusedEditorVerified: true,
      clearVerified: false,
      apiAccepted: false,
      echoVerified: false,
      restoreAttempted: false,
      restoreVerified: false,
    });
    return true;
  });
  assert.deepEqual(calls.map((call) => call.action), ["list"]);
});
