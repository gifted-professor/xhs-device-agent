import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const OPERATION = /^operation-[a-f0-9]{16}$/u;
const BUDGET = /^budget-[a-f0-9]{16}$/u;
const MACHINE = /^[0-9]{2}$/u;
const STEP = /^m[0-9]{2}\.s[0-9]{3}$/u;
const ACTIONS = new Set(["engagement.ensure_liked", "engagement.ensure_favorited"]);
const TERMINAL_OUTCOMES = new Set([
  "verified_active", "noop_already_active", "skipped_condition", "target_changed",
  "control_unavailable", "ambiguous", "failed",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return structuredClone(value);
}

function normalizeSlot(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "operation slot is invalid");
  invariant(OPERATION.test(value.operationId), "operationId is invalid");
  invariant(BUDGET.test(value.budgetSlotId), "budgetSlotId is invalid");
  invariant(MACHINE.test(value.machine), "machine is invalid");
  invariant(STEP.test(value.stepId), "stepId is invalid");
  invariant(ACTIONS.has(value.action), "operation action is invalid");
  return {
    operationId: value.operationId,
    budgetSlotId: value.budgetSlotId,
    machine: value.machine,
    stepId: value.stepId,
    action: value.action,
  };
}

function normalizeSlots(slots) {
  invariant(Array.isArray(slots), "operation slots are required");
  const values = slots.map(normalizeSlot);
  invariant(new Set(values.map((entry) => entry.operationId)).size === values.length, "operationId slots must be unique");
  invariant(new Set(values.map((entry) => entry.budgetSlotId)).size === values.length, "budgetSlotId slots must be unique");
  return values.sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function newLedger(slots) {
  return {
    schemaVersion: "xhs-composite-operation-ledger/v1",
    entries: slots.map((slot) => ({
      ...slot,
      targetHash: null,
      state: "unused",
      outcome: null,
    })),
  };
}

function validateLedger(value, slots) {
  invariant(value?.schemaVersion === "xhs-composite-operation-ledger/v1", "operation ledger schema mismatch");
  invariant(Array.isArray(value.entries) && value.entries.length === slots.length, "operation ledger slot count mismatch");
  const expected = new Map(slots.map((slot) => [slot.operationId, slot]));
  for (const entry of value.entries) {
    const slot = expected.get(entry?.operationId);
    invariant(slot, "operation ledger contains an unknown operation");
    for (const key of ["budgetSlotId", "machine", "stepId", "action"]) {
      invariant(entry[key] === slot[key], "operation ledger immutable binding mismatch");
    }
    invariant(["unused", "consumed", "closed"].includes(entry.state), "operation ledger state is invalid");
    invariant(entry.targetHash === null || /^[a-f0-9]{64}$/u.test(entry.targetHash), "operation ledger targetHash is invalid");
    invariant(entry.outcome === null || TERMINAL_OUTCOMES.has(entry.outcome), "operation ledger outcome is invalid");
    if (entry.state === "closed") invariant(entry.outcome !== null, "closed operation slot needs an outcome");
    if (entry.state !== "closed") invariant(entry.outcome === null, "open operation slot cannot have an outcome");
  }
  return value;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

async function pause(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      return await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await pause(5);
    }
  }
  throw new Error("operation ledger lock timeout");
}

function validateBinding(entry, value) {
  const binding = { ...normalizeSlot(value), targetHash: value.targetHash };
  invariant(/^[a-f0-9]{64}$/u.test(binding.targetHash), "targetHash is invalid");
  for (const key of ["operationId", "budgetSlotId", "machine", "stepId", "action"]) {
    invariant(entry[key] === binding[key], "operation binding mismatch");
  }
  invariant(entry.targetHash === null || entry.targetHash === binding.targetHash, "target binding mismatch");
  return binding;
}

export function operationSlotsFromPlan(plan) {
  invariant(Array.isArray(plan?.devices), "plan devices are required");
  return normalizeSlots(plan.devices.flatMap((device) => (device.steps ?? [])
    .filter((step) => ACTIONS.has(step.action))
    .map((step) => ({
      operationId: step.operationId,
      budgetSlotId: step.budgetSlotId,
      machine: device.machine,
      stepId: step.stepId,
      action: step.action,
    }))));
}

export class CompositeOperationLedger {
  static async open({ filePath, slots }) {
    invariant(typeof filePath === "string" && path.isAbsolute(filePath), "ledger filePath must be absolute");
    const instance = new CompositeOperationLedger(filePath, normalizeSlots(slots));
    await instance.withLock(async () => {
      const existing = await readJson(filePath);
      if (existing) validateLedger(existing, instance.slots);
      else await writeJsonAtomic(filePath, newLedger(instance.slots));
    });
    return instance;
  }

  constructor(filePath, slots) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.slots = slots;
  }

  async withLock(callback) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await acquireLock(this.lockPath);
    try {
      return await callback();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async mutate(bindingValue, transition) {
    return this.withLock(async () => {
      const ledger = validateLedger(await readJson(this.filePath), this.slots);
      const entry = ledger.entries.find((item) => item.operationId === bindingValue.operationId);
      invariant(entry, "operation binding mismatch");
      const binding = validateBinding(entry, bindingValue);
      const result = transition(entry, binding);
      validateLedger(ledger, this.slots);
      if (result.changed) await writeJsonAtomic(this.filePath, ledger);
      return clone(result.value);
    });
  }

  async consumeForSend(binding) {
    return this.mutate(binding, (entry, normalized) => {
      if (entry.state !== "unused") {
        return { changed: false, value: { acquired: false, state: entry.state, outcome: entry.outcome } };
      }
      entry.targetHash = normalized.targetHash;
      entry.state = "consumed";
      return { changed: true, value: { acquired: true, state: entry.state, outcome: null } };
    });
  }

  async closeWithoutSend(binding, outcome) {
    invariant(TERMINAL_OUTCOMES.has(outcome) && !["verified_active"].includes(outcome), "closeWithoutSend outcome is invalid");
    return this.mutate(binding, (entry, normalized) => {
      if (entry.state !== "unused") {
        return { changed: false, value: { closed: false, state: entry.state, outcome: entry.outcome } };
      }
      entry.targetHash = normalized.targetHash;
      entry.state = "closed";
      entry.outcome = outcome;
      return { changed: true, value: { closed: true, state: entry.state, outcome } };
    });
  }

  async recordOutcome(binding, outcome) {
    invariant(["verified_active", "ambiguous", "failed"].includes(outcome), "recordOutcome outcome is invalid");
    return this.mutate(binding, (entry) => {
      if (entry.state === "closed") {
        return { changed: false, value: { closed: false, state: entry.state, outcome: entry.outcome } };
      }
      invariant(entry.state === "consumed", "operation slot was not consumed before outcome");
      entry.state = "closed";
      entry.outcome = outcome;
      return { changed: true, value: { closed: true, state: entry.state, outcome } };
    });
  }

  async snapshot() {
    return this.withLock(async () => clone(validateLedger(await readJson(this.filePath), this.slots)));
  }
}
