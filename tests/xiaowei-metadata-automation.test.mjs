import assert from "node:assert/strict";
import test from "node:test";

import { runClipboardCanary } from "../scripts/xiaowei-clipboard-canary.mjs";
import { AUTOMATION_ROUTE_MAP, XiaoweiAutomation } from "../scripts/lib/xiaowei-automation.mjs";
import { getCapability } from "../scripts/lib/xiaowei-capabilities.mjs";

test("discovered tag/action/AutoJS routes remain distinct", () => {
  assert.equal(AUTOMATION_ROUTE_MAP["device.tag.add"], "addTag");
  assert.equal(AUTOMATION_ROUTE_MAP["device.tag.attach"], "addTagDevice");
  assert.equal(AUTOMATION_ROUTE_MAP["automation.action.create"], "actionCreate");
  assert.equal(AUTOMATION_ROUTE_MAP["automation.task.create"], "autojsCreate");
  assert.equal(AUTOMATION_ROUTE_MAP["automation.task.run"], "execAutojs");
});

test("route adapter forwards arbitrary discovered-route data without inventing a schema", async () => {
  const calls = [];
  const rawService = {
    async invokeRaw(request) {
      calls.push(request);
      return { ok: true, action: request.action, vendorResponse: { code: 10000 } };
    },
  };
  const automation = new XiaoweiAutomation({ rawService });
  const opaque = { vendorFieldsDiscoveredLater: [1, 2, 3] };
  const result = await automation.invokeRouteRaw({
    capabilityId: "automation.task.run",
    deviceAlias: "01",
    data: opaque,
    timeoutMs: 90000,
  });
  assert.deepEqual(calls[0], { deviceAlias: "01", action: "execAutojs", data: opaque, timeoutMs: 90000 });
  assert.equal(result.maturity, "route_verified_schema_unknown");
  await assert.rejects(
    automation.invokeRouteRaw({ capabilityId: "automation.unknown", deviceAlias: "01", data: {} }),
    /unknown automation route/,
  );
});

test("clipboard canary writes, verifies, restores, and verifies restoration", async () => {
  let clipboard = "original-private-value";
  const actions = [];
  const service = {
    async invokeRaw({ action, data }) {
      actions.push(action);
      if (action === "writeClipboard" && Object.hasOwn(data, "content")) clipboard = data.content;
      return {
        vendorResponse: action === "getClipboard"
          ? { code: 10000, data: { hiddenDeviceKey: { data: clipboard } } }
          : { code: 10000, data: null },
      };
    },
  };
  const result = await runClipboardCanary({ service, probe: "codex-xiaowei-probe-test" });
  assert.deepEqual(result, { ok: true, field: "content", writeVerified: true, restorationVerified: true });
  assert.equal(clipboard, "original-private-value");
  assert.deepEqual(actions, ["getClipboard", "writeClipboard", "getClipboard", "writeClipboard", "getClipboard"]);
});

test("device name and number stay unavailable after invalid current-version action probes", () => {
  assert.deepEqual(getCapability("device.name.set").vendorActions, []);
  assert.deepEqual(getCapability("device.number.set").vendorActions, []);
  assert.equal(getCapability("device.name.set").typedApi, false);
  assert.equal(getCapability("device.number.set").typedApi, false);
});
