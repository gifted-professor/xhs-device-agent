import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CompositeOperationLedger } from "../scripts/composite-operation-ledger.mjs";

const slots = [
  { operationId: "operation-0000000000000001", budgetSlotId: "budget-0000000000000001", machine: "01", stepId: "m01.s002", action: "engagement.ensure_liked" },
  { operationId: "operation-0000000000000002", budgetSlotId: "budget-0000000000000002", machine: "01", stepId: "m01.s003", action: "engagement.ensure_favorited" },
  { operationId: "operation-0000000000000003", budgetSlotId: "budget-0000000000000003", machine: "02", stepId: "m02.s002", action: "engagement.ensure_liked" },
];

async function ledger() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xhs-operation-ledger-"));
  return CompositeOperationLedger.open({ filePath: path.join(directory, "ledger.json"), slots });
}

function binding(index, targetHash = "a".repeat(64)) {
  return { ...slots[index], targetHash };
}

test("duplicate workers racing for one operation and budget slot get one consumer", async () => {
  const instance = await ledger();
  const results = await Promise.all(Array.from({ length: 12 }, () => instance.consumeForSend(binding(0))));
  assert.equal(results.filter((entry) => entry.acquired).length, 1);
  assert.equal(results.filter((entry) => !entry.acquired).every((entry) => entry.state === "consumed"), true);
  await instance.recordOutcome(binding(0), "verified_active");
  const later = await instance.consumeForSend(binding(0));
  assert.deepEqual({ acquired: later.acquired, state: later.state, outcome: later.outcome }, {
    acquired: false, state: "closed", outcome: "verified_active",
  });
});

test("noop and skipped slots close atomically and can never transfer", async () => {
  const instance = await ledger();
  const noop = await instance.closeWithoutSend(binding(1), "noop_already_active");
  assert.equal(noop.closed, true);
  const skipped = await instance.closeWithoutSend(binding(2, "b".repeat(64)), "skipped_condition");
  assert.equal(skipped.closed, true);
  for (const [index, targetHash] of [[1, "a".repeat(64)], [2, "b".repeat(64)]]) {
    const result = await instance.consumeForSend(binding(index, targetHash));
    assert.equal(result.acquired, false);
    assert.equal(result.state, "closed");
  }
  await assert.rejects(() => instance.consumeForSend({ ...binding(0), budgetSlotId: slots[1].budgetSlotId }), /binding mismatch/);
  await instance.consumeForSend(binding(0));
  await assert.rejects(() => instance.closeWithoutSend({ ...binding(0), targetHash: "c".repeat(64) }, "target_changed"), /target binding mismatch/);
});

test("ledger reload preserves immutable slot ownership and terminal outcomes", async () => {
  const first = await ledger();
  await first.consumeForSend(binding(0));
  await first.recordOutcome(binding(0), "ambiguous");
  const second = await CompositeOperationLedger.open({ filePath: first.filePath, slots });
  const snapshot = await second.snapshot();
  const entry = snapshot.entries.find((item) => item.operationId === slots[0].operationId);
  assert.equal(entry.state, "closed");
  assert.equal(entry.outcome, "ambiguous");
  assert.equal(entry.targetHash, "a".repeat(64));
});
