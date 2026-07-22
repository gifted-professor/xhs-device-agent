import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { XiaoweiTransport, makeRequest } from "../scripts/lib/xiaowei-transport.mjs";
import { createFakeWebSocketFactory } from "./helpers/fake-websocket.mjs";

function tempLock(name = "xw-ws-22222.lock") {
  return join(mkdtempSync(join(tmpdir(), "xiaowei-transport-")), name);
}

function transportFor(scenarios, overrides = {}) {
  const { WebSocket, sockets } = createFakeWebSocketFactory(scenarios);
  return {
    sockets,
    transport: new XiaoweiTransport({
      WebSocketImpl: WebSocket,
      lockPath: tempLock(),
      requestTimeoutMs: 50,
      lockTimeoutMs: 50,
      staleLockMs: 1000,
      lockRetryMs: 2,
      ...overrides,
    }),
  };
}

test("makeRequest preserves arbitrary data and omits absent fields", () => {
  assert.deepEqual(makeRequest({ action: "list" }), { action: "list" });
  assert.deepEqual(
    makeRequest({ action: "futureAction", devices: "device-runtime-id", data: { any: [1, true, null] } }),
    { action: "futureAction", devices: "device-runtime-id", data: { any: [1, true, null] } },
  );
  assert.throws(() => makeRequest({ action: "" }), { code: "XIAOWEI_INVALID_ACTION" });
});

test("invoke returns untouched successful vendor response", async () => {
  const response = { code: 10000, message: "SUCCESS", data: { future: true } };
  const { transport, sockets } = transportFor([
    (socket) => {
      socket.open();
      socket.message(response);
    },
  ]);

  const result = await transport.invoke({ action: "futureAction", devices: "runtime-device", data: { x: 1 } });
  assert.deepEqual(result, response);
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), {
    action: "futureAction",
    devices: "runtime-device",
    data: { x: 1 },
  });
});

test("invoke reports vendor error response without losing raw details", async () => {
  const response = { code: 40003, message: "NOT_SUPPORTED", data: null };
  const { transport } = transportFor([
    (socket) => {
      socket.open();
      socket.message(response);
    },
  ]);

  await assert.rejects(
    transport.invoke({ action: "unknownButSourced" }),
    (error) => {
      assert.equal(error.code, "XIAOWEI_VENDOR_ERROR");
      assert.deepEqual(error.details.response, response);
      return true;
    },
  );
});

test("invoke rejects malformed JSON", async () => {
  const { transport } = transportFor([
    (socket) => {
      socket.open();
      socket.malformed();
    },
  ]);

  await assert.rejects(transport.invoke({ action: "list" }), { code: "XIAOWEI_MALFORMED_RESPONSE" });
});

test("invoke rejects request timeout and closes the socket", async () => {
  const { transport, sockets } = transportFor([(socket) => socket.open()], { requestTimeoutMs: 5 });
  await assert.rejects(transport.invoke({ action: "list" }), { code: "XIAOWEI_TIMEOUT" });
  assert.equal(sockets[0].closed, true);
});

test("invoke rejects close before response", async () => {
  const { transport } = transportFor([
    (socket) => {
      socket.open();
      socket.close();
    },
  ]);
  await assert.rejects(transport.invoke({ action: "list" }), { code: "XIAOWEI_CLOSED" });
});

test("invoke rejects connection error", async () => {
  const { transport } = transportFor([(socket) => socket.error()]);
  await assert.rejects(transport.invoke({ action: "list" }), { code: "XIAOWEI_CONNECTION_ERROR" });
});

test("invoke removes a stale lock and continues", async () => {
  const lockPath = tempLock();
  writeFileSync(lockPath, "stale");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  const response = { code: 10000, message: "SUCCESS", data: [] };
  const { transport } = transportFor([
    (socket) => {
      socket.open();
      socket.message(response);
    },
  ], { lockPath, staleLockMs: 1000 });

  assert.deepEqual(await transport.invoke({ action: "list" }), response);
});

test("invoke fails when an active lock cannot be acquired", async () => {
  const lockPath = tempLock();
  writeFileSync(lockPath, "active");
  const { transport } = transportFor([], { lockPath, lockTimeoutMs: 5, staleLockMs: 60_000 });
  await assert.rejects(transport.invoke({ action: "list" }), { code: "XIAOWEI_LOCK_TIMEOUT" });
});
