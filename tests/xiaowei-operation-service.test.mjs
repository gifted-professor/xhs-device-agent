import assert from "node:assert/strict";
import test from "node:test";

import { XiaoweiLabSession } from "../scripts/lib/xiaowei-lab-session.mjs";
import { MemoryEvidenceSink, redactEvidence } from "../scripts/lib/xiaowei-evidence.mjs";
import { XiaoweiOperationService } from "../scripts/lib/xiaowei-operation-service.mjs";

test("optional lab session reports expiry, alias, host, version, and offline errors", () => {
  const session = new XiaoweiLabSession({
    id: "lab-1",
    deviceAlias: "01",
    host: "DESKTOP-3I1EVHE",
    version: "9.10.113",
    expiresAt: 200,
    now: () => 100,
  });
  assert.doesNotThrow(() => session.assertUsable({
    deviceAlias: "01", host: "DESKTOP-3I1EVHE", version: "9.10.113", online: true,
  }));
  assert.throws(() => session.assertUsable({ deviceAlias: "02", host: "DESKTOP-3I1EVHE", version: "9.10.113", online: true }), /alias mismatch/);
  assert.throws(() => session.assertUsable({ deviceAlias: "01", host: "OTHER", version: "9.10.113", online: true }), /host mismatch/);
  assert.throws(() => session.assertUsable({ deviceAlias: "01", host: "DESKTOP-3I1EVHE", version: "other", online: true }), /version mismatch/);
  assert.throws(() => session.assertUsable({ deviceAlias: "01", host: "DESKTOP-3I1EVHE", version: "9.10.113", online: false }), /offline/);
  session.now = () => 201;
  assert.throws(() => session.assertUsable({ deviceAlias: "01", host: "DESKTOP-3I1EVHE", version: "9.10.113", online: true }), /expired/);
});

test("same idempotency key and request returns the prior operation", async () => {
  let executions = 0;
  const service = new XiaoweiOperationService({
    execute: async () => { executions += 1; return { vendorCode: 10000 }; },
  });
  const request = { deviceAlias: "01", capability: "input.key.home", params: {} };
  const first = await service.run({ idempotencyKey: "same", request });
  const second = await service.run({ idempotencyKey: "same", request });
  assert.equal(executions, 1);
  assert.deepEqual(second, first);
});

test("same idempotency key with a different request is rejected", async () => {
  const service = new XiaoweiOperationService({ execute: async () => ({ vendorCode: 10000 }) });
  await service.run({ idempotencyKey: "conflict", request: { deviceAlias: "01", capability: "a", params: {} } });
  await assert.rejects(
    service.run({ idempotencyKey: "conflict", request: { deviceAlias: "01", capability: "b", params: {} } }),
    /idempotency key conflict/,
  );
});

test("a second concurrent operation on the same device is rejected", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new XiaoweiOperationService({ execute: async () => { await gate; return { vendorCode: 10000 }; } });
  const first = service.run({
    idempotencyKey: "first",
    request: { deviceAlias: "01", capability: "a", params: {} },
  });
  await assert.rejects(
    service.run({ idempotencyKey: "second", request: { deviceAlias: "01", capability: "b", params: {} } }),
    /already has an active operation/,
  );
  release();
  await first;
});

test("operation runs accepted through verification and restoration", async () => {
  const order = [];
  const evidence = new MemoryEvidenceSink();
  const service = new XiaoweiOperationService({
    execute: async () => { order.push("execute"); return { vendorCode: 10000 }; },
    verify: async () => { order.push("verify"); return { ok: true, hash: "abc" }; },
    restore: async () => { order.push("restore"); return { ok: true }; },
    evidence,
  });
  const result = await service.run({
    idempotencyKey: "lifecycle",
    request: { deviceAlias: "01", capability: "probe", params: { secretText: "never-log" } },
  });
  assert.equal(result.status, "verified");
  assert.deepEqual(order, ["execute", "verify", "restore"]);
  assert.deepEqual(evidence.events.map((event) => event.stage), ["accepted", "executing", "verifying", "restoring", "verified"]);
  assert.doesNotMatch(JSON.stringify(evidence.events), /never-log|secretText/);
});

test("sent timeout is ambiguous and is not retried automatically", async () => {
  let executions = 0;
  const timeout = Object.assign(new Error("timeout"), { code: "XIAOWEI_TIMEOUT", sent: true });
  const service = new XiaoweiOperationService({
    execute: async () => { executions += 1; throw timeout; },
  });
  const result = await service.run({
    idempotencyKey: "timeout",
    request: { deviceAlias: "01", capability: "probe", params: {} },
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(executions, 1);
});

test("evidence redaction keeps only operational metadata", () => {
  assert.deepEqual(redactEvidence({
    operationId: "op-1",
    stage: "verified",
    deviceAlias: "01",
    capability: "screen.capture",
    vendorCode: 10000,
    durationMs: 12,
    hash: "abc",
    serial: "private",
    text: "private",
    clipboard: "private",
    path: "C:\\private",
    screenshot: "private",
  }), {
    operationId: "op-1",
    stage: "verified",
    deviceAlias: "01",
    capability: "screen.capture",
    vendorCode: 10000,
    durationMs: 12,
    hash: "abc",
  });
});
