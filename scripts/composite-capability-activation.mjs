import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { canonicalizeJson } from "./composite-plan-core.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
  const [profile, evidence] = await Promise.all([readJson(profilePath), readJson(evidencePath)]);
  invariant(profile.profileKind !== "synthetic_test", "synthetic capability profiles cannot be activated");
  invariant(profile.profileKind === "production_candidate", "only a production candidate can be human-accepted");
  invariant(typeof profile.capabilityProfileId === "string", "capabilityProfileId is required");
  invariant(Array.isArray(profile.allowedActions) && profile.allowedActions.length > 0, "finite allowedActions are required");
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
  const [receipt, profile, evidence] = await Promise.all([
    readJson(receiptPath), readJson(active.sourceProfilePath), readJson(active.sourceEvidencePath),
  ]);
  const acceptanceHash = hashCapabilityDocument(receipt);
  invariant(acceptanceHash === active.acceptanceHash, "acceptance receipt hash mismatch");
  const profileHash = hashCapabilityDocument(profile);
  const evidenceHash = hashCapabilityDocument(evidence);
  invariant(profileHash === receipt.capabilityProfileHash, "active profile hash changed after acceptance");
  invariant(evidenceHash === receipt.acceptanceEvidenceHash, "acceptance evidence hash changed after acceptance");
  invariant(receipt.acceptedBy === "human", "active capability is not human-accepted");
  return { profile, receipt, profileHash, acceptanceHash, receiptPath };
}
