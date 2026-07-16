import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  discoverXiaoweiTarget,
  invokeXiaoweiPrivateCommand,
  runXiaoweiPrivateCli,
  summarizePrivateDeviceList,
  validateDebuggerEndpoint,
} from "../scripts/xiaowei-private-api.mjs";

function discoveryFetch(targets) {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from(JSON.stringify(targets)),
  });
}

function mockTarget() {
  return {
    type: "page",
    title: "效卫安卓投屏",
    url: "http://tauri.localhost/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/1",
  };
}

class MockWebSocket extends EventEmitter {
  static responder = () => ({ ok: true, value: null });
  static sent = [];

  constructor() {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(raw) {
    const request = JSON.parse(raw);
    MockWebSocket.sent.push(request);
    const value = MockWebSocket.responder(request.params.expression);
    queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({
      id: request.id,
      result: { result: { value } },
    }))));
  }

  close() {}
}

test("private debugger endpoint is loopback-only", () => {
  assert.equal(validateDebuggerEndpoint("http://127.0.0.1:9223"), "http://127.0.0.1:9223");
  assert.throws(() => validateDebuggerEndpoint("http://example.com:9223"), /local HTTP URL/u);
  assert.throws(() => validateDebuggerEndpoint("http://127.0.0.1:9223/path"), /must not include a path/u);
});

test("Xiaowei target discovery requires exactly one named local WebView", async () => {
  const target = await discoverXiaoweiTarget({ fetchImpl: discoveryFetch([mockTarget()]) });
  assert.equal(target.title, "效卫安卓投屏");
  await assert.rejects(() => discoverXiaoweiTarget({ fetchImpl: discoveryFetch([]) }), /exactly one/u);
});

test("private command sends the exact accepted Tauri command", async () => {
  MockWebSocket.sent.length = 0;
  MockWebSocket.responder = (expression) => {
    assert.match(expression, /invoke\("restart_adb", \{\}\)/u);
    return { ok: true, value: null };
  };
  const result = await invokeXiaoweiPrivateCommand("restart_adb", {}, {
    target: mockTarget(),
    WebSocketImpl: MockWebSocket,
  });
  assert.equal(result.command, "restart_adb");
  assert.equal(MockWebSocket.sent[0].method, "Runtime.evaluate");
  MockWebSocket.responder = (expression) => {
    assert.match(expression, /invoke\("get_size", \{"serial":"server-resolved"\}\)/u);
    return { ok: true, value: "1080x2400" };
  };
  const size = await invokeXiaoweiPrivateCommand("get_size", { serial: "server-resolved" }, {
    target: mockTarget(), WebSocketImpl: MockWebSocket,
  });
  assert.equal(size.risk, "read_only");
  await assert.rejects(() => invokeXiaoweiPrivateCommand("exec_command"), /not accepted/u);
  MockWebSocket.responder = () => ({ ok: true, value: "done" });
  const development = await invokeXiaoweiPrivateCommand("exec_command", { command: "test" }, {
    target: mockTarget(), WebSocketImpl: MockWebSocket, developmentMode: true,
  });
  assert.equal(development.risk, "development_unrestricted");
});

test("device summary never emits private identifiers", () => {
  const summary = summarizePrivateDeviceList([{ serial: "secret-1" }, { serial: "secret-2" }]);
  assert.deepEqual(summary, { deviceCount: 2, resultType: "array", identifiersRedacted: true });
  assert.doesNotMatch(JSON.stringify(summary), /secret/u);
  assert.deepEqual(
    summarizePrivateDeviceList(JSON.stringify({ data: [{ serial: "hidden" }] })),
    { deviceCount: 1, resultType: "json_string", identifiersRedacted: true },
  );
});

test("private CLI exposes a redacted device summary", async () => {
  let output = "";
  MockWebSocket.responder = (expression) => {
    assert.match(expression, /get_device_list/u);
    return { ok: true, value: [{ serial: "secret" }] };
  };
  await runXiaoweiPrivateCli(["device-summary"], {
    target: mockTarget(),
    WebSocketImpl: MockWebSocket,
    output: { write: (value) => { output += value; } },
  });
  assert.equal(JSON.parse(output).deviceCount, 1);
  assert.doesNotMatch(output, /secret/u);
});
