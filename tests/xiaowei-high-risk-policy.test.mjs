import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITIES } from "../scripts/lib/xiaowei-capabilities.mjs";

const SYSTEM_IDS = [
  "connection.wifi.enable",
  "connection.root.enable",
  "connection.accessibility.enable",
  "connection.usb.enable",
  "connection.hid.enable",
  "connection.otg.enable",
];

test("system capabilities record installed implementation paths and independent recovery facts", () => {
  for (const id of SYSTEM_IDS) {
    const capability = CAPABILITIES.find((entry) => entry.id === id);
    assert.ok(capability, `missing ${id}`);
    assert.ok(capability.implementationPaths.length > 0, `${id} lacks implementation path`);
    assert.equal(capability.recovery.sshIndependent, true);
    assert.equal(capability.recovery.adb5038OnlineCount, 4);
    assert.notEqual(capability.availability, "blocked_by_policy");
  }
});

test("disconnecting mode switches stay marked recovery-not-ready instead of policy-blocked", () => {
  for (const id of ["connection.wifi.enable", "connection.root.enable", "connection.accessibility.enable", "connection.hid.enable", "connection.otg.enable"]) {
    const capability = CAPABILITIES.find((entry) => entry.id === id);
    assert.match(capability.availability, /recovery_not_ready/);
    assert.equal(capability.typedApi, false);
  }
});

test("root and accessibility verification distinguish acceptance, activation, and usable control", () => {
  for (const id of ["connection.root.enable", "connection.accessibility.enable"]) {
    const verification = CAPABILITIES.find((entry) => entry.id === id).verification;
    assert.match(verification, /command accepted/);
    assert.match(verification, /mode reports active/);
    assert.match(verification, /probe succeeds/);
  }
});

test("screen sleep, wake, and resolution remain callable through unrestricted adb_shell", () => {
  for (const id of ["screen.off", "screen.on", "screen.resolution.set"]) {
    const capability = CAPABILITIES.find((entry) => entry.id === id);
    assert.deepEqual(capability.vendorActions, ["adb_shell"]);
    assert.equal(capability.rawLabApi, true);
    assert.notEqual(capability.availability, "blocked_by_policy");
  }
});
