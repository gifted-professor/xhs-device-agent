import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "../scripts/lib/xiaowei-capabilities.mjs";

const REQUIRED_CAPABILITY_IDS = [
  "screen.open",
  "device.number.set",
  "device.name.set",
  "device.tag.move",
  "app.install",
  "input.text.distribute",
  "file.distribute",
  "file.import",
  "file.export",
  "clipboard.export",
  "diagnostic.adb",
  "diagnostic.shell",
  "input.pointer.autoScroll",
  "automation.action.record",
  "automation.action.run",
  "automation.task.run",
  "automation.task.stop",
  "automation.execution.list",
  "input.ime.list",
  "input.ime.select",
  "input.phrase.list",
  "input.phrase.use",
  "device.wallpaper.setFromNumber",
  "connection.wifi.enable",
  "connection.root.enable",
  "connection.accessibility.enable",
  "screen.off",
  "screen.on",
];

test("capability registry is non-empty and uses unique IDs", () => {
  assert.ok(Array.isArray(CAPABILITIES));
  assert.ok(CAPABILITIES.length > 0);

  const ids = CAPABILITIES.map((capability) => capability.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("capability registry covers every known Xiaowei menu seed", () => {
  const ids = new Set(CAPABILITIES.map((capability) => capability.id));
  for (const id of REQUIRED_CAPABILITY_IDS) {
    assert.ok(ids.has(id), `missing capability: ${id}`);
  }
});
