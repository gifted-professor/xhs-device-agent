import { interactionMatch, interactionVerifiedAfterActivation } from "./feed-device-runner.mjs";

const ACTION_STEP = Object.freeze({
  like: "engagement.ensure_liked",
  favorite: "engagement.ensure_favorited",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function operationBinding(operation, binding) {
  return { ...operation, targetHash: binding.targetHash };
}

async function closeNoSend(input, outcome, fuseReason) {
  const closed = await input.ledger.closeWithoutSend(operationBinding(input.operation, input.binding), outcome);
  if (fuseReason) input.tripFuse?.(fuseReason);
  return {
    status: outcome === "noop_already_active" && closed.closed ? "noop_already_active" : "ambiguous",
    targetHash: input.binding.targetHash,
    sent: false,
    ledgerState: closed.state,
    outcome: closed.outcome,
  };
}

async function closeAmbiguous(input, error = null) {
  await input.ledger.recordOutcome(operationBinding(input.operation, input.binding), "ambiguous");
  input.tripFuse?.("AMBIGUOUS_ACCOUNT_STATE");
  return {
    status: "ambiguous",
    targetHash: input.binding.targetHash,
    sent: true,
    outcome: "ambiguous",
    ...(error ? { error: String(error?.message ?? error) } : {}),
  };
}

export async function ensureEngagementState(input = {}) {
  const {
    action, operation, binding, ledger, invalidateSnapshot, freshSnapshot,
    bindSnapshot, sameTarget, assertFastGate, sendOnce,
  } = input;
  invariant(Object.hasOwn(ACTION_STEP, action), "ensure action must be like or favorite");
  invariant(operation?.action === ACTION_STEP[action], "ensure operation action mismatch");
  invariant(binding && /^[a-f0-9]{64}$/u.test(binding.targetHash), "ensure target binding is invalid");
  invariant(ledger && typeof ledger.consumeForSend === "function", "operation ledger is required");
  invariant(typeof invalidateSnapshot === "function" && typeof freshSnapshot === "function", "fresh snapshot controls are required");
  invariant(typeof bindSnapshot === "function" && typeof sameTarget === "function" && typeof sendOnce === "function", "ensure adapter is incomplete");
  invariant(typeof assertFastGate === "function", "engagement fast gate is required");

  invalidateSnapshot();
  const before = await freshSnapshot(`engagement-${action}-before`);
  const rebound = bindSnapshot(before);
  if (rebound?.targetHash !== binding.targetHash) {
    return closeNoSend(input, "target_changed", "TARGET_BINDING_CHANGED");
  }
  const inspected = interactionMatch(before.document, action);
  if (!inspected) return closeNoSend(input, "control_unavailable", "AMBIGUOUS_ACCOUNT_STATE");
  if (inspected.active) return closeNoSend(input, "noop_already_active", null);

  const consumed = await ledger.consumeForSend(operationBinding(operation, binding));
  if (!consumed.acquired) {
    input.tripFuse?.("OPERATION_ALREADY_CONSUMED");
    return {
      status: "ambiguous", targetHash: binding.targetHash, sent: false,
      ledgerState: consumed.state, outcome: consumed.outcome,
    };
  }

  try {
    assertFastGate({ action: operation.action, operationId: operation.operationId, phase: "before_send" });
    await sendOnce(inspected);
  } catch (error) {
    return closeAmbiguous(input, error);
  }

  try {
    invalidateSnapshot();
    const after = await freshSnapshot(`engagement-${action}-after`);
    if (!sameTarget(before, after, binding)) return closeAmbiguous(input);
    const match = interactionMatch(after.document, action);
    if (!interactionVerifiedAfterActivation(inspected, match)) return closeAmbiguous(input);
    await ledger.recordOutcome(operationBinding(operation, binding), "verified_active");
    return { status: "verified", targetHash: binding.targetHash, sent: true, outcome: "verified_active" };
  } catch (error) {
    return closeAmbiguous(input, error);
  }
}
