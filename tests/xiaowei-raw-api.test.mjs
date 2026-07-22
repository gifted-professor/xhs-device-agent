import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceApiRouter } from "../scripts/device-api-router.mjs";
import { XiaoweiRawService } from "../scripts/lib/xiaowei-raw-service.mjs";
import { createDeviceApiServer } from "../scripts/xiaowei-device-api.mjs";

function fakeTransport({ devices = null, rawResponse = null } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(request, options) {
      calls.push({ request, options });
      if (request.action === "list") {
        return devices || {
          code: 10000,
          message: "SUCCESS",
          data: [{ sort: 1, serial: "runtime-only-serial", model: "probe-model" }],
        };
      }
      return rawResponse || {
        code: 10000,
        message: "SUCCESS",
        data: { echoedAction: request.action, echoedData: request.data },
      };
    },
  };
}

test("raw service accepts an action absent from the capability inventory", async () => {
  const transport = fakeTransport();
  const service = new XiaoweiRawService({ transport });
  const data = { nested: [1, true, null, { future: "value" }] };

  const result = await service.invokeRaw({
    deviceAlias: "01",
    action: "brandNewUnknownVendorAction",
    data,
    timeoutMs: 43210,
  });

  assert.deepEqual(transport.calls[1], {
    request: {
      action: "brandNewUnknownVendorAction",
      devices: "runtime-only-serial",
      data,
    },
    options: { timeoutMs: 43210 },
  });
  assert.deepEqual(result, {
    ok: true,
    deviceAlias: "01",
    action: "brandNewUnknownVendorAction",
    vendorResponse: {
      code: 10000,
      message: "SUCCESS",
      data: { echoedAction: "brandNewUnknownVendorAction", echoedData: data },
    },
  });
});

test("raw service resolves alias 01 from a fresh unique sort=1 inventory", async () => {
  const transport = fakeTransport({
    devices: {
      code: 10000,
      message: "SUCCESS",
      data: [
        { sort: 2, serial: "other" },
        { sort: 1, onlySerial: "selected-runtime-id" },
      ],
    },
  });
  const service = new XiaoweiRawService({ transport });
  await service.invokeRaw({ deviceAlias: "01", action: "anything", data: null });
  assert.equal(transport.calls[1].request.devices, "selected-runtime-id");
});

test("raw service rejects a missing or ambiguous canary without calling the action", async () => {
  const missing = fakeTransport({ devices: { code: 10000, data: [{ sort: 2, serial: "other" }] } });
  await assert.rejects(
    new XiaoweiRawService({ transport: missing }).invokeRaw({ deviceAlias: "01", action: "anything" }),
    { code: "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE" },
  );
  assert.equal(missing.calls.length, 1);

  const duplicate = fakeTransport({
    devices: {
      code: 10000,
      data: [{ sort: 1, serial: "one" }, { sort: "1", serial: "two" }],
    },
  });
  await assert.rejects(
    new XiaoweiRawService({ transport: duplicate }).invokeRaw({ deviceAlias: "01", action: "anything" }),
    { code: "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE" },
  );
  assert.equal(duplicate.calls.length, 1);
});

test("router advertises unrestricted raw action transport", async () => {
  const router = createDeviceApiRouter({ rawService: new XiaoweiRawService({ transport: fakeTransport() }) });
  const response = await router.handle({ method: "GET", path: "/device/v1/manifest" });
  assert.equal(response.status, 200);
  assert.equal(response.body.raw.allowAnyAction, true);
  assert.equal(response.body.raw.actionAllowlist, null);
});

test("POST /device/v1/raw forwards arbitrary action and data", async () => {
  const transport = fakeTransport();
  const router = createDeviceApiRouter({ rawService: new XiaoweiRawService({ transport }) });
  const response = await router.handle({
    method: "POST",
    path: "/device/v1/raw",
    body: {
      deviceAlias: "01",
      action: "notRegisteredAnywhere",
      data: { opaque: { x: 1 } },
      timeoutMs: 9876,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(transport.calls[1].request.action, "notRegisteredAnywhere");
  assert.deepEqual(transport.calls[1].request.data, { opaque: { x: 1 } });
});

test("POST /device/v1/raw validates only the envelope, not action semantics", async () => {
  const router = createDeviceApiRouter({ rawService: new XiaoweiRawService({ transport: fakeTransport() }) });
  const missingAction = await router.handle({
    method: "POST",
    path: "/device/v1/raw",
    body: { deviceAlias: "01", data: { any: true } },
  });
  assert.equal(missingAction.status, 400);
  assert.equal(missingAction.body.error.code, "XIAOWEI_INVALID_ACTION");

  const wrongAlias = await router.handle({
    method: "POST",
    path: "/device/v1/raw",
    body: { deviceAlias: "02", action: "anything" },
  });
  assert.equal(wrongAlias.status, 409);
  assert.equal(wrongAlias.body.error.code, "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE");
});

test("HTTP server exposes the unrestricted raw route to an Agent client", async (context) => {
  const transport = fakeTransport();
  const router = createDeviceApiRouter({ rawService: new XiaoweiRawService({ transport }) });
  const server = createDeviceApiServer({ router });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/device/v1/raw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceAlias: "01",
      action: "actionDiscoveredTomorrow",
      data: { vendorOpaque: ["kept", 1] },
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.action, "actionDiscoveredTomorrow");
  assert.deepEqual(transport.calls[1].request.data, { vendorOpaque: ["kept", 1] });
});
