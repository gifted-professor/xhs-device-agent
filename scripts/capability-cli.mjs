import path from "node:path";
import { fileURLToPath } from "node:url";

import { activateCapability, loadActiveCapability } from "./composite-capability-activation.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parse(argv) {
  const [command, ...tokens] = argv;
  invariant(["accept", "status"].includes(command), "capability command must be accept or status");
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index]);
    invariant(token.startsWith("--") && token.length > 2, "capability command accepts named options only");
    const name = token.slice(2);
    invariant(!Object.hasOwn(options, name), `--${name} may be provided only once`);
    if (["confirm-human", "json"].includes(name)) options[name] = true;
    else {
      index += 1;
      invariant(index < tokens.length && !String(tokens[index]).startsWith("--"), `--${name} requires a value`);
      options[name] = String(tokens[index]);
    }
  }
  return { command, options };
}

function root(options) {
  return path.resolve(options["acceptance-root"] ?? path.join(PROJECT_ROOT, "data", "composite-capability"));
}

export async function runCapabilityCommand(argv, dependencies = {}) {
  const { command, options } = parse(argv);
  const activate = dependencies.activateCapability ?? activateCapability;
  const load = dependencies.loadActiveCapability ?? loadActiveCapability;
  if (command === "status") {
    for (const key of Object.keys(options)) invariant(["acceptance-root", "json"].includes(key), `capability status does not support --${key}`);
    const active = await load({ acceptanceRoot: root(options) });
    return Object.freeze({
      schemaVersion: "xhs-capability-status/v1",
      status: "active",
      capabilityProfileId: active.profile.capabilityProfileId,
      capabilityProfileHash: active.profileHash,
      acceptanceHash: active.acceptanceHash,
      acceptedBy: active.receipt.acceptedBy,
      acceptedLimits: active.receipt.acceptedLimits,
    });
  }
  const allowed = new Set([
    "profile", "evidence", "acceptance-root", "confirm-profile-hash", "confirm-evidence-hash", "confirm-human", "json",
  ]);
  for (const key of Object.keys(options)) invariant(allowed.has(key), `capability accept does not support --${key}`);
  for (const required of ["profile", "evidence", "confirm-profile-hash", "confirm-evidence-hash"]) {
    invariant(options[required], `--${required} is required`);
  }
  invariant(options["confirm-human"] === true, "capability accept requires --confirm-human");
  invariant(/^[a-f0-9]{64}$/u.test(options["confirm-profile-hash"]), "confirmed profile hash is invalid");
  invariant(/^[a-f0-9]{64}$/u.test(options["confirm-evidence-hash"]), "confirmed evidence hash is invalid");
  const result = await activate({
    profilePath: path.resolve(options.profile),
    evidencePath: path.resolve(options.evidence),
    acceptanceRoot: root(options),
    confirmProfileHash: options["confirm-profile-hash"],
    confirmEvidenceHash: options["confirm-evidence-hash"],
    confirmHuman: true,
  });
  return Object.freeze({
    schemaVersion: "xhs-capability-accept-result/v1",
    status: "accepted",
    capabilityProfileId: result.receipt.capabilityProfileId,
    capabilityProfileHash: result.receipt.capabilityProfileHash,
    acceptanceHash: result.acceptanceHash,
    acceptanceId: result.receipt.acceptanceId,
  });
}

async function main(argv = process.argv.slice(2)) {
  const result = await runCapabilityCommand(argv);
  process.stdout.write(`${JSON.stringify(result, null, argv.includes("--json") ? 0 : 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
