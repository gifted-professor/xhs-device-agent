import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalizeJson } from "../scripts/composite-plan-core.mjs";
import {
  activateCapability,
  hashCapabilityDocument,
  loadActiveCapability,
  validateCapabilityProfile,
} from "../scripts/composite-capability-activation.mjs";

async function setup(profileKind = "production_candidate") {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-capability-activation-"));
  const profilePath = path.join(root, "profile.json");
  const evidencePath = path.join(root, "evidence.json");
  const acceptanceRoot = path.join(root, "active");
  const profile = {
    schemaVersion: "xhs-composite-capability/v1", capabilityProfileId: "candidate-v1", profileKind,
    actionRegistryVersion: "composite-actions/v1",
    allowedActions: ["engagement.ensure_liked", "engagement.ensure_favorited"],
    maxDevices: 2, maxParallel: 2, maxStateChangesTotal: 4, maxStateChangesPerMinute: 4, cpaConcurrency: 2,
    commentLiveCap: { maxScrolls: 3, maxItems: 20 },
    cpaLimits: { providerHardTimeoutMs: 45000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict",
      startPolicy: "all_ready", readyDeadlineMs: 8000, minReady: 1, snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000, readOnlyFlushMaxEvents: 32, cpaWorkflowSoftTimeoutMs: 8000,
    },
  };
  const evidence = { schemaVersion: "xhs-capability-evidence/v1", tests: "325/325", deviceGate: "closed" };
  await writeFile(profilePath, `${canonicalizeJson(profile)}\n`, "utf8");
  await writeFile(evidencePath, `${canonicalizeJson(evidence)}\n`, "utf8");
  return { root, profilePath, evidencePath, acceptanceRoot, profile, evidence };
}

test("human acceptance writes an exact ignored-state receipt and active lookup revalidates source hashes", async () => {
  const state = await setup();
  const profileHash = hashCapabilityDocument(state.profile);
  const evidenceHash = hashCapabilityDocument(state.evidence);
  const activated = await activateCapability({
    ...state, confirmProfileHash: profileHash, confirmEvidenceHash: evidenceHash, confirmHuman: true,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  assert.equal(activated.receipt.acceptedBy, "human");
  assert.equal(activated.receipt.capabilityProfileHash, profileHash);
  assert.equal(activated.receipt.acceptanceEvidenceHash, evidenceHash);
  assert.deepEqual(activated.receipt.acceptedLimits.allowedActions, state.profile.allowedActions);
  const active = await loadActiveCapability({ acceptanceRoot: state.acceptanceRoot });
  assert.deepEqual(active.profile, state.profile);
  assert.equal(active.profileHash, profileHash);
  assert.match(active.acceptanceHash, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(activated.receiptPath, "utf8")).includes(state.profilePath), false);

  await writeFile(state.profilePath, `${canonicalizeJson({ ...state.profile, maxParallel: 1 })}\n`, "utf8");
  await assert.rejects(() => loadActiveCapability({ acceptanceRoot: state.acceptanceRoot }), /profile hash/);
});

test("capability acceptance validates the full closed runtime profile before writing a receipt", async () => {
  const state = await setup();
  assert.equal(validateCapabilityProfile(state.profile), state.profile);
  for (const [index, invalid] of [
    { ...state.profile, maxParallel: 3 },
    { ...state.profile, allowedActions: [...state.profile.allowedActions, "tap"] },
    { ...state.profile, runtimeProfile: { ...state.profile.runtimeProfile, cpaWorkflowSoftTimeoutMs: 45000 } },
    { ...state.profile, hiddenOverride: true },
  ].entries()) {
    const profilePath = path.join(state.root, `invalid-${index}.json`);
    await writeFile(profilePath, `${canonicalizeJson(invalid)}\n`, "utf8");
    await assert.rejects(() => activateCapability({
      ...state,
      profilePath,
      confirmProfileHash: hashCapabilityDocument(invalid),
      confirmEvidenceHash: hashCapabilityDocument(state.evidence),
      confirmHuman: true,
    }), /invalid|unsupported|exceeds|timeout|fields|allowedActions/iu);
  }
});

test("synthetic fixtures, wrong hashes, non-human confirmation, and receipt collisions fail closed", async () => {
  const synthetic = await setup("synthetic_test");
  await assert.rejects(() => activateCapability({
    ...synthetic, confirmProfileHash: hashCapabilityDocument(synthetic.profile),
    confirmEvidenceHash: hashCapabilityDocument(synthetic.evidence), confirmHuman: true,
  }), /synthetic/);

  const state = await setup();
  const args = {
    ...state, confirmProfileHash: hashCapabilityDocument(state.profile),
    confirmEvidenceHash: hashCapabilityDocument(state.evidence), confirmHuman: true,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  };
  await assert.rejects(() => activateCapability({ ...args, confirmHuman: false }), /human/);
  await assert.rejects(() => activateCapability({ ...args, confirmProfileHash: "0".repeat(64) }), /profile hash/);
  await activateCapability(args);
  await assert.rejects(() => activateCapability(args), /already exists|collision/);
});
