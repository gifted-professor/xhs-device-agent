import { createHash } from "node:crypto";

import { ACTION_REGISTRY } from "./composite-action-registry.mjs";
import { hashPlan } from "./composite-plan-core.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(...values) {
  return createHash("sha256").update(values.join("\0"), "utf8").digest("hex");
}

function date(now) {
  const value = typeof now === "function" ? now() : now;
  const result = value instanceof Date ? value : new Date(value ?? Date.now());
  invariant(!Number.isNaN(result.valueOf()), "valid coordinator time is required");
  return result;
}

function ticketFor({ plan, approvalHash, attemptId, worker, parentEpoch, issuedAt, expiresAt }) {
  const workerId = `worker-${worker.machine}`;
  const nonce = digest(attemptId, workerId, String(parentEpoch), issuedAt.toISOString()).slice(0, 32);
  return Object.freeze({
    schemaVersion: "xhs-composite-worker-ticket/v1",
    ticketId: `ticket-${digest(plan.planHash, approvalHash, attemptId, workerId, nonce).slice(0, 16)}`,
    attemptId,
    workerId,
    machine: worker.machine,
    taskId: worker.taskId,
    planHash: plan.planHash,
    approvalHash,
    policyHash: plan.policyHash,
    capabilityProfileId: plan.capabilityProfileId,
    capabilityProfileHash: plan.capabilityProfileHash,
    inventorySnapshotHash: plan.inventorySnapshotHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    allowedStepIds: Object.freeze(worker.steps.map((step) => step.stepId)),
    allowedOperationIds: Object.freeze(worker.steps.map((step) => step.operationId).filter(Boolean)),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce,
    parentEpoch,
  });
}

export function createExecutionCoordinator({
  plan,
  approvalHash,
  attemptId,
  now = Date.now,
  leaseMs,
  onFuse = () => {},
} = {}) {
  invariant(plan?.planHash === hashPlan(plan), "coordinator plan hash mismatch");
  invariant(/^[a-f0-9]{64}$/u.test(approvalHash ?? ""), "coordinator approvalHash is invalid");
  invariant(/^attempt-[a-f0-9]{16}$/u.test(attemptId ?? ""), "coordinator attemptId is invalid");
  invariant(typeof onFuse === "function", "coordinator onFuse must be a function");
  const duration = leaseMs ?? plan.limits.maxWallClockMs;
  invariant(Number.isSafeInteger(duration) && duration > 0 && duration <= plan.limits.maxWallClockMs, "execution lease duration is invalid");
  const parentEpoch = 1 + Number.parseInt(digest(attemptId, plan.planHash).slice(0, 7), 16);
  const slots = Array.from({ length: plan.limits.maxParallel }, (_, index) => ({
    slotIndex: index + 1,
    generation: 0,
    slotId: null,
    state: "available",
    workerId: null,
    expiresAt: null,
  }));
  const contexts = new Map();
  let fuse = null;

  function tripFuse(reason, details = {}) {
    if (fuse) return fuse;
    invariant(typeof reason === "string" && /^[A-Z][A-Z0-9_]{2,79}$/u.test(reason), "fuse reason is invalid");
    fuse = Object.freeze({ reason, details: structuredClone(details), openedAt: date(now).toISOString(), parentEpoch });
    for (const slot of slots) {
      if (["issued", "active"].includes(slot.state)) slot.state = "revoked";
    }
    onFuse(fuse);
    return fuse;
  }

  function admit(machine) {
    invariant(!fuse, "global fuse is open");
    invariant(/^[0-9]{2}$/u.test(machine ?? ""), "worker machine is invalid");
    invariant(!contexts.has(machine), `machine ${machine} already has a worker context`);
    const worker = plan.devices.find((entry) => entry.machine === machine);
    invariant(worker && plan.devices.filter((entry) => entry.machine === machine).length === 1, "worker is not uniquely bound to the plan");
    const admissionTime = date(now).valueOf();
    for (const candidate of slots) {
      if (["issued", "active"].includes(candidate.state) && admissionTime > candidate.expiresAt) candidate.state = "expired";
    }
    const slot = slots.find((entry) => ["available", "released", "expired"].includes(entry.state));
    invariant(slot, "no execution slot is available");
    const issuedAt = date(now);
    const expiresAt = new Date(issuedAt.valueOf() + duration);
    const ticket = ticketFor({ plan, approvalHash, attemptId, worker, parentEpoch, issuedAt, expiresAt });
    slot.generation += 1;
    slot.slotId = `slot-${String(slot.slotIndex).padStart(3, "0")}-${String(slot.generation).padStart(4, "0")}`;
    slot.state = "issued";
    slot.workerId = ticket.workerId;
    slot.expiresAt = expiresAt.valueOf();

    invariant(ticket.planHash === plan.planHash && ticket.approvalHash === approvalHash, "worker ticket hash binding mismatch");
    invariant(ticket.parentEpoch === parentEpoch && ticket.machine === machine && ticket.taskId === worker.taskId, "worker ticket identity binding mismatch");
    invariant(ticket.allowedStepIds.length === worker.steps.length, "worker ticket step binding mismatch");
    slot.state = "active";

    const allowedActions = new Set(worker.steps.map((step) => step.action));
    const context = Object.freeze({
      attemptId,
      workerId: ticket.workerId,
      machine,
      taskId: worker.taskId,
      planHash: plan.planHash,
      approvalHash,
      parentEpoch,
      ticket,
      slotId: slot.slotId,
      assertFastGate({ action } = {}) {
        invariant(!fuse, "global fuse is open");
        invariant(slot.state === "active" && slot.workerId === ticket.workerId, "execution slot is not active");
        invariant(date(now).valueOf() <= slot.expiresAt, "worker ticket or execution slot expired");
        invariant(ticket.parentEpoch === parentEpoch, "worker parent epoch changed");
        invariant(typeof action === "string" && ACTION_REGISTRY[action] && allowedActions.has(action), "operation is outside the worker ticket");
        return true;
      },
      release() {
        if (slot.state === "active") slot.state = "released";
      },
    });
    contexts.set(machine, context);
    return context;
  }

  return Object.freeze({
    attemptId,
    parentEpoch,
    admit,
    tripFuse,
    getFuse: () => fuse,
    snapshotSlots: () => slots.map((entry) => ({ ...entry })),
  });
}
