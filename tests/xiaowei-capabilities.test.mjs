import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilityRegistry,
  createPublicManifest,
  validateInventory,
} from "../scripts/lib/xiaowei-capabilities.mjs";
import { validateCapabilityParams } from "../scripts/lib/xiaowei-validate.mjs";

function capability(overrides = {}) {
  return {
    id: "probe.read",
    domain: "probe",
    uiLabels: [],
    vendorActions: ["probeRead"],
    sources: ["test"],
    availability: "documented_candidate",
    maturity: "D1",
    testOrder: "S0",
    typedApi: true,
    rawLabApi: true,
    requestSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["brief", "full"] },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["mode"],
    },
    responseSchema: { type: "object" },
    verification: "fresh readback",
    restoration: "none",
    timeoutMs: 8000,
    versionRange: "test",
    ...overrides,
  };
}

function inventory(capabilities) {
  return {
    schemaVersion: 1,
    product: { name: "test", observedVersion: "1", transport: "ws://test" },
    capabilities,
  };
}

test("registry rejects duplicate capability IDs", () => {
  assert.throws(
    () => validateInventory(inventory([capability(), capability()])),
    /duplicate capability ID: probe\.read/,
  );
});

test("registry rejects duplicate action names within one capability", () => {
  assert.throws(
    () => validateInventory(inventory([capability({ vendorActions: ["probeRead", "probeRead"] })])),
    /duplicate vendor action.*probeRead/,
  );
});

test("registry rejects missing maturity, test order, verification, and restoration", () => {
  for (const field of ["maturity", "testOrder", "verification", "restoration"]) {
    const entry = capability();
    delete entry[field];
    assert.throws(() => validateInventory(inventory([entry])), new RegExp(field));
  }
});

test("registry rejects unknown JSON-schema fields", () => {
  const entry = capability({
    requestSchema: { type: "object", properties: {}, surprise: true },
  });
  assert.throws(() => validateInventory(inventory([entry])), /unknown schema field: surprise/);
});

test("registry is derived from the supplied inventory", () => {
  const source = inventory([capability(), capability({ id: "probe.write", vendorActions: ["probeWrite"] })]);
  const registry = buildCapabilityRegistry(source);
  assert.deepEqual(registry.map((entry) => entry.id), ["probe.read", "probe.write"]);
  assert.ok(Object.isFrozen(registry));
});

test("typed parameter validation rejects unknown and malformed fields", () => {
  const entry = capability();
  assert.deepEqual(validateCapabilityParams(entry, { mode: "brief", limit: 2 }), {
    mode: "brief",
    limit: 2,
  });
  assert.throws(() => validateCapabilityParams(entry, { mode: "brief", extra: true }), /unknown parameter: extra/);
  assert.throws(() => validateCapabilityParams(entry, { limit: 2 }), /missing required parameter: mode/);
  assert.throws(() => validateCapabilityParams(entry, { mode: "wrong" }), /mode must be one of/);
  assert.throws(() => validateCapabilityParams(entry, { mode: "brief", limit: 2.5 }), /limit must be an integer/);
});

test("public manifest omits vendor action names and evidence sources", () => {
  const manifest = createPublicManifest(inventory([capability({
    risk: "read-only",
    requirements: ["device online"],
    examples: [{ params: { mode: "brief" } }],
  })]));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.capabilities[0].id, "probe.read");
  assert.equal(manifest.capabilities[0].risk, "read-only");
  assert.equal(Object.hasOwn(manifest.capabilities[0], "vendorActions"), false);
  assert.equal(Object.hasOwn(manifest.capabilities[0], "sources"), false);
});
