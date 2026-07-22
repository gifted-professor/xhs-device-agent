import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceApiRouter } from "../scripts/device-api-router.mjs";

function fixture() {
  const calls = [];
  const rawService = {
    async invokeRaw(body) { calls.push(["raw", body]); return { ok: true, action: body.action }; },
  };
  const client = {
    async deviceList() { return { code: 10000, data: [{ sort: 1, model: "M", serial: "do-not-expose" }] }; },
    async invoke(capability, input) { calls.push(["invoke", capability, input]); return { status: "executed" }; },
  };
  const operationService = {
    async run(input) { calls.push(["operation.run", input]); return { operationId: "op-1", status: "verified" }; },
    get(id) { return id === "op-1" ? { operationId: id, status: "verified" } : null; },
  };
  return { calls, router: createDeviceApiRouter({ rawService, client, operationService }) };
}

test("device list is alias-only and invoke does not require takeover", async () => {
  const { router, calls } = fixture();
  const devices = await router.handle({ method: "GET", path: "/device/v1/devices" });
  assert.equal(devices.status, 200);
  assert.doesNotMatch(JSON.stringify(devices.body), /do-not-expose|serial/);
  assert.deepEqual(devices.body.devices, [{ alias: "01", model: "M", online: true }]);

  const invoked = await router.handle({
    method: "POST",
    path: "/device/v1/invoke",
    body: { deviceAlias: "01", capability: "input.key.home", params: {} },
  });
  assert.equal(invoked.status, 200);
  assert.deepEqual(calls[0], ["invoke", "input.key.home", { deviceAlias: "01", params: {} }]);
});

test("raw remains unrestricted and needs no session or takeover fields", async () => {
  const { router, calls } = fixture();
  const result = await router.handle({
    method: "POST",
    path: "/device/v1/raw",
    body: { deviceAlias: "01", action: "unknownFutureAction", data: { anything: true } },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls[0], ["raw", { deviceAlias: "01", action: "unknownFutureAction", data: { anything: true } }]);
});

test("operations support idempotency and lookup without a lab session", async () => {
  const { router, calls } = fixture();
  const started = await router.handle({
    method: "POST",
    path: "/device/v1/operations",
    body: { idempotencyKey: "key-1", request: { deviceAlias: "01", capability: "input.key.home", params: {} } },
  });
  assert.equal(started.status, 200);
  assert.equal(calls[0][1].labSession, undefined);
  const found = await router.handle({ method: "GET", path: "/device/v1/operations/op-1" });
  assert.equal(found.status, 200);
  const missing = await router.handle({ method: "GET", path: "/device/v1/operations/missing" });
  assert.equal(missing.status, 404);
});
