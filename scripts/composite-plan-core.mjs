import { createHash, createHmac } from "node:crypto";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeJson(value) {
  const active = new Set();
  const visit = (current) => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      invariant(Number.isFinite(current), "canonical JSON requires finite numbers");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    invariant(typeof current === "object", `unsupported canonical JSON value: ${typeof current}`);
    invariant(!active.has(current), "canonical JSON does not support cyclic values");
    active.add(current);
    let result;
    if (Array.isArray(current)) {
      result = `[${current.map((entry) => visit(entry)).join(",")}]`;
    } else {
      invariant(isPlainObject(current), "canonical JSON requires plain objects");
      const entries = Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${visit(current[key])}`);
      result = `{${entries.join(",")}}`;
    }
    active.delete(current);
    return result;
  };
  return visit(value);
}

function sha256(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

export function hashPlan(planWithoutHash) {
  invariant(isPlainObject(planWithoutHash), "plan must be an object");
  const { planHash: _ignored, ...hashable } = planWithoutHash;
  return sha256(hashable);
}

export function seededIndex({ seed, compilerVersion, stepId, choiceKind, counter, size }) {
  invariant(typeof seed === "string" && seed.length > 0, "seed is required");
  invariant(typeof compilerVersion === "string" && compilerVersion.length > 0, "compilerVersion is required");
  invariant(typeof stepId === "string" && stepId.length > 0, "stepId is required");
  invariant(typeof choiceKind === "string" && choiceKind.length > 0, "choiceKind is required");
  invariant(Number.isSafeInteger(counter) && counter >= 0, "counter must be a non-negative integer");
  invariant(Number.isSafeInteger(size) && size > 0, "size must be a positive integer");
  const message = ["hmac-sha256-counter-v1", compilerVersion, stepId, choiceKind, String(counter)].join("\u0000");
  const digest = createHmac("sha256", seed).update(message, "utf8").digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(size));
}
