import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CompositeOperationLedger } from "../scripts/composite-operation-ledger.mjs";
import { ensureEngagementState } from "../scripts/engagement-ensure.mjs";

const operation = {
  operationId: "operation-1111111111111111", budgetSlotId: "budget-1111111111111111",
  machine: "01", stepId: "m01.s002", action: "engagement.ensure_liked",
};
const targetHash = "a".repeat(64);

function snapshot({ active = false, state = "IMAGE_NOTE", target = targetHash, control = true } = {}) {
  const nodes = control ? [{
    nodeIndex: 0, parentIndex: null, children: [], className: "android.widget.Button",
    resourceId: "", text: "", contentDesc: `${active ? "已点赞" : "点赞"} 10`,
    clickable: true, enabled: true, checked: active, selected: false,
    attributes: { bounds: "[800,1800][1000,2000]" },
  }] : [];
  return { classification: { state, safety: { sensitive: false } }, document: { nodes, roots: nodes.map((node) => node.nodeIndex) }, targetHash: target };
}

async function setup({ before, after, sendError = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xhs-engagement-"));
  const ledger = await CompositeOperationLedger.open({ filePath: path.join(directory, "ledger.json"), slots: [operation] });
  const queue = [before ?? snapshot(), after ?? snapshot({ active: true })];
  const calls = [];
  const fuses = [];
  const input = {
    action: "like", operation, binding: { targetHash }, ledger,
    invalidateSnapshot: () => calls.push("invalidate"),
    freshSnapshot: async (stage) => { calls.push(stage); return queue.shift(); },
    bindSnapshot: (value) => ({ targetHash: value.targetHash }),
    sameTarget: (_before, after) => after.targetHash === targetHash,
    assertFastGate: () => calls.push("gate"),
    sendOnce: async () => { calls.push("send"); if (sendError) throw sendError; },
    tripFuse: (reason) => fuses.push(reason),
  };
  return { input, ledger, calls, fuses };
}

test("already active closes its exact slot as noop with zero send", async () => {
  const value = await setup({ before: snapshot({ active: true }) });
  const result = await ensureEngagementState(value.input);
  assert.equal(result.status, "noop_already_active");
  assert.equal(value.calls.includes("send"), false);
  const entry = (await value.ledger.snapshot()).entries[0];
  assert.equal(entry.outcome, "noop_already_active");
});

test("inactive state consumes one exact slot, sends once, and verifies fresh active state", async () => {
  const value = await setup();
  const result = await ensureEngagementState(value.input);
  assert.equal(result.status, "verified");
  assert.equal(value.calls.filter((entry) => entry === "send").length, 1);
  assert.deepEqual(value.calls.filter((entry) => /before|after/.test(entry)), ["engagement-like-before", "engagement-like-after"]);
  assert.equal((await value.ledger.snapshot()).entries[0].outcome, "verified_active");
});

test("changed target stops with zero send and closes the nontransferable slot", async () => {
  const value = await setup({ before: snapshot({ target: "b".repeat(64) }) });
  const result = await ensureEngagementState(value.input);
  assert.equal(result.status, "ambiguous");
  assert.equal(value.calls.includes("send"), false);
  assert.deepEqual(value.fuses, ["TARGET_BINDING_CHANGED"]);
  assert.equal((await value.ledger.snapshot()).entries[0].outcome, "target_changed");
});

test("send timeout and unknown post-state are ambiguous, fuse, and never retry", async () => {
  const timeout = await setup({ sendError: Object.assign(new Error("timeout"), { sent: true }) });
  assert.equal((await ensureEngagementState(timeout.input)).status, "ambiguous");
  assert.equal(timeout.calls.filter((entry) => entry === "send").length, 1);
  assert.deepEqual(timeout.fuses, ["AMBIGUOUS_ACCOUNT_STATE"]);
  assert.equal((await timeout.ledger.snapshot()).entries[0].outcome, "ambiguous");

  const unknown = await setup({ after: snapshot({ control: false }) });
  assert.equal((await ensureEngagementState(unknown.input)).status, "ambiguous");
  assert.equal(unknown.calls.filter((entry) => entry === "send").length, 1);
  assert.deepEqual(unknown.fuses, ["AMBIGUOUS_ACCOUNT_STATE"]);
  assert.equal((await unknown.ledger.snapshot()).entries[0].outcome, "ambiguous");
});

test("ensure path never exposes unrelated interaction surfaces", async () => {
  const value = await setup();
  await ensureEngagementState(value.input);
  assert.equal(/follow|comment|reply|message|share|profile|publish|delete|login|permission|payment/iu.test(JSON.stringify(value.calls)), false);
});
