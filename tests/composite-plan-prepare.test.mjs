import assert from "node:assert/strict";
import test from "node:test";

import { prepareCompositeSnapshot } from "../scripts/composite-plan-prepare.mjs";

const profile = {
  schemaVersion: "xhs-composite-capability/v1",
  capabilityProfileId: "accepted-profile-v1",
  profileKind: "production_candidate",
  maxDevices: 2,
  maxParallel: 2,
  allowedActions: ["engagement.ensure_liked", "engagement.ensure_favorited"],
};

function request(machines = ["01", "02"]) {
  return {
    devices: machines.map((machine) => ({ machine, taskId: `task-${machine}` })),
    actionPool: ["engagement.ensure_liked", "engagement.ensure_favorited"],
  };
}

function readOnlyRequest(machines = ["01"]) {
  return {
    devices: machines.map((machine) => ({ machine, taskId: `task-${machine}` })),
    actionPool: ["detail.inspect", "comments.observe_count"],
  };
}

function fakeProvider({ devices, favoriteAuthorized = true } = {}) {
  const calls = [];
  return {
    calls,
    async listDevices() {
      calls.push("listDevices");
      return devices ?? [
        { machine: "01", visibleName: "Phone A", online: true, identityHash: "1".repeat(64) },
        { machine: "02", visibleName: "Phone B", online: true, identityHash: "2".repeat(64) },
      ];
    },
    async readCapability(machine) {
      calls.push(`readCapability:${machine}`);
      return { appVersion: "9.99.0", adapterVersion: "adapter-v1", actionRegistryVersion: "composite-actions/v1" };
    },
    async readInteractionAuthorization(machine) {
      calls.push(`readInteractionAuthorization:${machine}`);
      return { ensureLiked: true, ensureFavorited: favoriteAuthorized };
    },
    async navigate() { assert.fail("prepare must not navigate"); },
    async send() { assert.fail("prepare must not send"); },
  };
}

test("prepare binds exact machines, accepted profile, capabilities, authorizations, hashes, and expiry", async () => {
  const provider = fakeProvider();
  const snapshot = await prepareCompositeSnapshot({
    request: request(),
    activeCapability: { profile, profileHash: "a".repeat(64), acceptanceHash: "b".repeat(64) },
    provider,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
    ttlMs: 60000,
  });
  assert.equal(snapshot.schemaVersion, "xhs-composite-preparation/v1");
  assert.equal(snapshot.capabilityProfileId, profile.capabilityProfileId);
  assert.equal(snapshot.capabilityProfileHash, "a".repeat(64));
  assert.equal(snapshot.capabilityAcceptanceHash, "b".repeat(64));
  assert.match(snapshot.inventorySnapshotHash, /^[a-f0-9]{64}$/);
  assert.match(snapshot.capabilitySnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.createdAt, "2026-07-15T00:00:00.000Z");
  assert.equal(snapshot.expiresAt, "2026-07-15T00:01:00.000Z");
  assert.deepEqual(snapshot.devices.map(({ machine, taskId }) => ({ machine, taskId })), request().devices);
  assert.deepEqual(provider.calls, [
    "listDevices", "readCapability:01", "readInteractionAuthorization:01",
    "readCapability:02", "readInteractionAuthorization:02",
  ]);
});

test("prepare fails closed on duplicate, missing, offline, ambiguous, or over-capability machines", async () => {
  const activeCapability = { profile, profileHash: "a".repeat(64), acceptanceHash: "b".repeat(64) };
  await assert.rejects(() => prepareCompositeSnapshot({ request: request(["01", "01"]), activeCapability, provider: fakeProvider() }), /duplicate/);
  await assert.rejects(() => prepareCompositeSnapshot({ request: request(["01", "02", "03"]), activeCapability, provider: fakeProvider() }), /capability/);
  await assert.rejects(() => prepareCompositeSnapshot({ request: request(["03"]), activeCapability, provider: fakeProvider() }), /unique online/);
  await assert.rejects(() => prepareCompositeSnapshot({
    request: request(["01"]), activeCapability,
    provider: fakeProvider({ devices: [{ machine: "01", visibleName: "A", online: false, identityHash: "1".repeat(64) }] }),
  }), /unique online/);
  await assert.rejects(() => prepareCompositeSnapshot({
    request: request(["01"]), activeCapability,
    provider: fakeProvider({ devices: [
      { machine: "01", visibleName: "A", online: true, identityHash: "1".repeat(64) },
      { machine: "01", visibleName: "B", online: true, identityHash: "2".repeat(64) },
    ] }),
  }), /unique online/);
});

test("prepare rejects missing account-state authorization without expanding activity", async () => {
  const provider = fakeProvider({ favoriteAuthorized: false });
  await assert.rejects(() => prepareCompositeSnapshot({
    request: request(["02"]),
    activeCapability: { profile, profileHash: "a".repeat(64), acceptanceHash: "b".repeat(64) },
    provider,
  }), /favorite authorization/);
  assert.equal(provider.calls.some((call) => call === "navigate" || call === "send"), false);
});

test("read-only preparation checks only capabilities required by the requested actions", async () => {
  const provider = fakeProvider();
  provider.readInteractionAuthorization = async () => assert.fail("read-only preparation must not inspect interaction authorization");
  const snapshot = await prepareCompositeSnapshot({
    request: readOnlyRequest(),
    activeCapability: { profile, profileHash: "a".repeat(64), acceptanceHash: "b".repeat(64) },
    provider,
  });
  assert.deepEqual(provider.calls, ["listDevices", "readCapability:01"]);
  assert.deepEqual(snapshot.devices[0].interactionAuthorization, {
    ensureLiked: false,
    ensureFavorited: false,
  });
});
