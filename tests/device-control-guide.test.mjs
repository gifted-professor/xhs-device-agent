import assert from "node:assert/strict";
import test from "node:test";

import { getDeviceControlGuide, loadDeviceControlCatalog } from "../scripts/device-control-guide.mjs";

test("device control catalog maps every standard failure to ordered bounded strategies", async () => {
  const catalog = await loadDeviceControlCatalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.protocol, "observe_resolve_recheck_execute_verify");
  for (const code of [
    "UI_EMPTY", "NODE_NOT_FOUND", "OCR_MISS", "OCR_AMBIGUOUS", "NODE_AMBIGUOUS",
    "LAYOUT_DRIFT", "FOREGROUND_DRIFT", "POSTCONDITION_MISS", "SENSITIVE_SURFACE",
    "IDENTITY_DRIFT", "CAPABILITY_MISSING", "TRANSPORT_FAILED",
  ]) {
    const guide = await getDeviceControlGuide(code);
    assert.equal(guide.code, code);
    assert.ok(Array.isArray(guide.next));
    assert.doesNotMatch(JSON.stringify(guide), /serial|deviceId|alias|coordinate|screenshotPath/iu);
  }
  await assert.rejects(() => getDeviceControlGuide("UNKNOWN_FAILURE"), /not documented/u);
});

test("current request authority and compatibility fallback do not become approval gates", async () => {
  const sensitive = await getDeviceControlGuide("SENSITIVE_SURFACE");
  assert.equal(sensitive.automatic, true);
  assert.equal(sensitive.terminal, false);
  assert.deepEqual(sensitive.next.map(({ strategy }) => strategy), ["REQUEST_SCOPED_ACTION"]);

  const missing = await getDeviceControlGuide("CAPABILITY_MISSING");
  assert.equal(missing.automatic, true);
  assert.equal(missing.terminal, false);
  assert.equal(missing.next[0].strategy, "PROJECT_COMPATIBILITY_ROUTE");

  const transport = await getDeviceControlGuide("TRANSPORT_FAILED");
  assert.equal(transport.next[0].strategy, "VERSION_VERIFIED_GATEWAY_RELOAD");
  assert.equal(transport.next[0].readCommand, "remote.status");
  assert.equal(transport.next[0].writeCommand, "remote.restart");
});
