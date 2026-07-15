import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { canonicalizeJson } from "./composite-plan-core.mjs";
import { ACTION_REGISTRY } from "./composite-action-registry.mjs";

const PROFILE_KEYS = Object.freeze([
  "schemaVersion", "capabilityProfileId", "profileKind", "actionRegistryVersion", "allowedActions",
  "maxDevices", "maxParallel", "maxStateChangesTotal", "maxStateChangesPerMinute", "cpaConcurrency",
  "commentLiveCap", "cpaLimits", "runtimeProfile",
]);
const RUNTIME_KEYS = Object.freeze([
  "validationMode", "startPolicy", "readyDeadlineMs", "minReady", "snapshotReuseMs",
  "readOnlyFlushIntervalMs", "readOnlyFlushMaxEvents", "cpaWorkflowSoftTimeoutMs",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function plain(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(value);
  invariant(keys.length === allowed.length && keys.every((key) => allowed.includes(key)), `${label} fields are invalid`);
}

function integer(value, label, minimum, maximum) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} is outside its finite bounds`);
  return value;
}

export function validateCapabilityProfile(input) {
  const profile = plain(input, "capability profile");
  exactKeys(profile, PROFILE_KEYS, "capability profile");
  invariant(profile.schemaVersion === "xhs-composite-capability/v1", "capability profile schemaVersion is invalid");
  invariant(typeof profile.capabilityProfileId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(profile.capabilityProfileId), "capabilityProfileId is invalid");
  invariant(["production_candidate", "synthetic_test"].includes(profile.profileKind), "capability profile kind is invalid");
  invariant(profile.actionRegistryVersion === "composite-actions/v1", "capability action registry version is invalid");
  invariant(Array.isArray(profile.allowedActions) && profile.allowedActions.length > 0 && profile.allowedActions.length <= Object.keys(ACTION_REGISTRY).length, "finite allowedActions are required");
  invariant(new Set(profile.allowedActions).size === profile.allowedActions.length && profile.allowedActions.every((action) => ACTION_REGISTRY[action]), "allowedActions contains an unsupported or duplicate action");
  integer(profile.maxDevices, "maxDevices", 1, 64);
  integer(profile.maxParallel, "maxParallel", 1, 64);
  invariant(profile.maxParallel <= profile.maxDevices, "maxParallel exceeds maxDevices");
  integer(profile.maxStateChangesTotal, "maxStateChangesTotal", 0, 2_000_000);
  integer(profile.maxStateChangesPerMinute, "maxStateChangesPerMinute", 1, 1024);
  integer(profile.cpaConcurrency, "cpaConcurrency", 1, 16);
  const comment = plain(profile.commentLiveCap, "commentLiveCap");
  exactKeys(comment, ["maxScrolls", "maxItems"], "commentLiveCap");
  integer(comment.maxScrolls, "commentLiveCap.maxScrolls", 0, 8);
  integer(comment.maxItems, "commentLiveCap.maxItems", 0, 50);
  const cpa = plain(profile.cpaLimits, "cpaLimits");
  exactKeys(cpa, ["providerHardTimeoutMs"], "cpaLimits");
  integer(cpa.providerHardTimeoutMs, "cpaLimits.providerHardTimeoutMs", 1000, 120000);
  const runtime = plain(profile.runtimeProfile, "runtimeProfile");
  exactKeys(runtime, RUNTIME_KEYS, "runtimeProfile");
  invariant(runtime.validationMode === "startup_strict_runtime_light_account_state_strict", "runtime validation mode is invalid");
  invariant(["all_ready", "ready_subset_after_deadline"].includes(runtime.startPolicy), "runtime start policy is invalid");
  integer(runtime.readyDeadlineMs, "runtimeProfile.readyDeadlineMs", 1000, 120000);
  integer(runtime.minReady, "runtimeProfile.minReady", 1, 64);
  invariant(runtime.minReady <= profile.maxDevices, "runtime minReady exceeds maxDevices");
  integer(runtime.snapshotReuseMs, "runtimeProfile.snapshotReuseMs", 0, 10000);
  integer(runtime.readOnlyFlushIntervalMs, "runtimeProfile.readOnlyFlushIntervalMs", 50, 60000);
  integer(runtime.readOnlyFlushMaxEvents, "runtimeProfile.readOnlyFlushMaxEvents", 1, 1024);
  integer(runtime.cpaWorkflowSoftTimeoutMs, "runtimeProfile.cpaWorkflowSoftTimeoutMs", 100, 119999);
  invariant(runtime.cpaWorkflowSoftTimeoutMs < cpa.providerHardTimeoutMs, "CPA workflow timeout must be below the provider hard timeout");
  return profile;
}

function asDate(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const result = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(result.valueOf()), "valid activation time is required");
  return result;
}

export function hashCapabilityDocument(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeExclusiveJson(filePath, value) {
  const handle = await open(filePath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") throw new Error(`acceptance collision: ${path.basename(filePath)} already exists`);
    throw error;
  });
  try {
    await handle.writeFile(`${canonicalizeJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalizeJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

function acceptedLimits(profile) {
  return {
    maxDevices: profile.maxDevices,
    maxParallel: profile.maxParallel,
    maxStateChangesTotal: profile.maxStateChangesTotal,
    maxStateChangesPerMinute: profile.maxStateChangesPerMinute,
    cpaConcurrency: profile.cpaConcurrency,
    allowedActions: [...profile.allowedActions],
  };
}

export async function activateCapability({
  profilePath,
  evidencePath,
  acceptanceRoot,
  confirmProfileHash,
  confirmEvidenceHash,
  confirmHuman,
  now,
}) {
  invariant(confirmHuman === true, "explicit human capability confirmation is required");
  invariant(path.isAbsolute(profilePath) && path.isAbsolute(evidencePath), "controlled absolute profile and evidence paths are required");
  invariant(path.isAbsolute(acceptanceRoot), "controlled absolute acceptance root is required");
  const [profileInput, evidence] = await Promise.all([readJson(profilePath), readJson(evidencePath)]);
  const profile = validateCapabilityProfile(profileInput);
  invariant(profile.profileKind !== "synthetic_test", "synthetic capability profiles cannot be activated");
  invariant(profile.profileKind === "production_candidate", "only a production candidate can be human-accepted");
  const profileHash = hashCapabilityDocument(profile);
  const evidenceHash = hashCapabilityDocument(evidence);
  invariant(profileHash === confirmProfileHash, "profile hash confirmation mismatch");
  invariant(evidenceHash === confirmEvidenceHash, "evidence hash confirmation mismatch");

  const acceptedAt = asDate(now).toISOString();
  const acceptanceId = `acceptance-${createHash("sha256").update(`${profileHash}\0${evidenceHash}\0${acceptedAt}`).digest("hex").slice(0, 16)}`;
  const receipt = {
    schemaVersion: "xhs-composite-capability-acceptance/v1",
    acceptanceId,
    capabilityProfileId: profile.capabilityProfileId,
    capabilityProfileHash: profileHash,
    acceptedBy: "human",
    acceptedAt,
    acceptanceEvidenceHash: evidenceHash,
    acceptedLimits: acceptedLimits(profile),
  };
  const acceptanceHash = hashCapabilityDocument(receipt);
  await mkdir(path.join(acceptanceRoot, "receipts"), { recursive: true, mode: 0o700 });
  const receiptFile = `${acceptanceId}.json`;
  const receiptPath = path.join(acceptanceRoot, "receipts", receiptFile);
  await writeExclusiveJson(receiptPath, receipt);
  const activePath = path.join(acceptanceRoot, "active.json");
  await writeAtomicJson(activePath, {
    schemaVersion: "xhs-active-capability/v1",
    receiptFile,
    acceptanceHash,
    sourceProfilePath: path.resolve(profilePath),
    sourceEvidencePath: path.resolve(evidencePath),
  });
  return { receipt, receiptPath, activePath, acceptanceHash };
}

export async function loadActiveCapability({ acceptanceRoot }) {
  invariant(path.isAbsolute(acceptanceRoot), "controlled absolute acceptance root is required");
  const active = await readJson(path.join(acceptanceRoot, "active.json"));
  invariant(active.schemaVersion === "xhs-active-capability/v1", "active capability record is invalid");
  invariant(/^acceptance-[a-f0-9]{16}\.json$/.test(active.receiptFile), "active receipt path is invalid");
  const receiptPath = path.join(acceptanceRoot, "receipts", active.receiptFile);
  const [receipt, profileInput, evidence] = await Promise.all([
    readJson(receiptPath), readJson(active.sourceProfilePath), readJson(active.sourceEvidencePath),
  ]);
  const profile = validateCapabilityProfile(profileInput);
  const acceptanceHash = hashCapabilityDocument(receipt);
  invariant(acceptanceHash === active.acceptanceHash, "acceptance receipt hash mismatch");
  const profileHash = hashCapabilityDocument(profile);
  const evidenceHash = hashCapabilityDocument(evidence);
  invariant(profileHash === receipt.capabilityProfileHash, "active profile hash changed after acceptance");
  invariant(evidenceHash === receipt.acceptanceEvidenceHash, "acceptance evidence hash changed after acceptance");
  invariant(receipt.acceptedBy === "human", "active capability is not human-accepted");
  invariant(canonicalizeJson(receipt.acceptedLimits) === canonicalizeJson(acceptedLimits(profile)), "accepted capability limits do not match the active profile");
  return { profile, receipt, profileHash, acceptanceHash, receiptPath };
}
