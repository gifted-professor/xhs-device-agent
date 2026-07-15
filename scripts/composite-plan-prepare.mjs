import { createHash } from "node:crypto";

import { canonicalizeJson } from "./composite-plan-core.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function date(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const result = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(result.valueOf()), "valid preparation time is required");
  return result;
}

function safeVisibleName(value) {
  invariant(typeof value === "string" && value.length >= 1 && value.length <= 80, "visible machine name is invalid");
  invariant(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), "visible machine name contains control text");
  return value;
}

export async function prepareCompositeSnapshot({ request, activeCapability, provider, now, ttlMs = 60000 }) {
  invariant(request && Array.isArray(request.devices) && request.devices.length > 0, "explicit devices are required");
  invariant(activeCapability?.profile && /^[a-f0-9]{64}$/.test(activeCapability.profileHash ?? ""), "active accepted capability is required");
  invariant(/^[a-f0-9]{64}$/.test(activeCapability.acceptanceHash ?? ""), "capability acceptance hash is required");
  invariant(provider && typeof provider.listDevices === "function", "read-only inventory provider is required");
  invariant(typeof provider.readCapability === "function", "read-only capability provider is required");
  invariant(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000, "finite snapshot ttl is required");
  const needsLikeAuthorization = request.actionPool.includes("engagement.ensure_liked");
  const needsFavoriteAuthorization = request.actionPool.includes("engagement.ensure_favorited");
  const needsInteractionAuthorization = needsLikeAuthorization || needsFavoriteAuthorization;
  if (needsInteractionAuthorization) {
    invariant(typeof provider.readInteractionAuthorization === "function", "interaction authorization provider is required");
  }
  const machines = request.devices.map((entry) => entry.machine);
  invariant(machines.every((machine) => /^[0-9]{2}$/.test(machine)), "machine must use a two-digit number");
  invariant(new Set(machines).size === machines.length, "duplicate machine in preparation request");
  invariant(request.devices.length <= activeCapability.profile.maxDevices, "selected devices exceed accepted capability");

  const inventory = await provider.listDevices();
  invariant(Array.isArray(inventory), "inventory provider must return an array");
  const resolved = [];
  for (const selected of request.devices) {
    const matches = inventory.filter((entry) => entry?.machine === selected.machine && entry?.online === true);
    invariant(matches.length === 1, `machine ${selected.machine} must resolve to exactly one unique online device`);
    const device = matches[0];
    invariant(/^[a-f0-9]{64}$/.test(device.identityHash ?? ""), `machine ${selected.machine} identity hash is invalid`);
    const capability = await provider.readCapability(selected.machine);
    const authorization = needsInteractionAuthorization
      ? await provider.readInteractionAuthorization(selected.machine)
      : { ensureLiked: false, ensureFavorited: false };
    invariant(capability?.actionRegistryVersion === "composite-actions/v1", `machine ${selected.machine} action registry is unsupported`);
    if (needsLikeAuthorization) {
      invariant(authorization?.ensureLiked === true, `machine ${selected.machine} lacks like authorization`);
    }
    if (needsFavoriteAuthorization) {
      invariant(authorization?.ensureFavorited === true, `machine ${selected.machine} lacks favorite authorization`);
    }
    resolved.push({
      machine: selected.machine,
      taskId: selected.taskId,
      visibleName: safeVisibleName(device.visibleName),
      identityHash: device.identityHash,
      appVersion: String(capability.appVersion ?? ""),
      adapterVersion: String(capability.adapterVersion ?? ""),
      actionRegistryVersion: capability.actionRegistryVersion,
      interactionAuthorization: {
        ensureLiked: authorization?.ensureLiked === true,
        ensureFavorited: authorization?.ensureFavorited === true,
      },
    });
  }

  const inventoryBinding = resolved.map(({ machine, taskId, visibleName, identityHash }) => ({ machine, taskId, visibleName, identityHash }));
  const capabilityBinding = resolved.map(({ machine, appVersion, adapterVersion, actionRegistryVersion, interactionAuthorization }) => ({
    machine, appVersion, adapterVersion, actionRegistryVersion, interactionAuthorization,
  }));
  const inventorySnapshotHash = hash(inventoryBinding);
  const capabilitySnapshotHash = hash({
    capabilityProfileId: activeCapability.profile.capabilityProfileId,
    capabilityProfileHash: activeCapability.profileHash,
    capabilityAcceptanceHash: activeCapability.acceptanceHash,
    devices: capabilityBinding,
  });
  const created = date(now);
  const expires = new Date(created.valueOf() + ttlMs);
  return {
    schemaVersion: "xhs-composite-preparation/v1",
    snapshotId: `snapshot-${hash({ inventorySnapshotHash, capabilitySnapshotHash, createdAt: created.toISOString() }).slice(0, 16)}`,
    capabilityProfileId: activeCapability.profile.capabilityProfileId,
    capabilityProfileHash: activeCapability.profileHash,
    capabilityAcceptanceHash: activeCapability.acceptanceHash,
    inventorySnapshotHash,
    capabilitySnapshotHash,
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
    devices: resolved,
  };
}
