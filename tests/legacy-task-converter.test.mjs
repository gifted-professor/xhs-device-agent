import assert from "node:assert/strict";
import test from "node:test";

import {
  convertLegacyFeedBatch,
  convertLegacyFeedRun,
  normalizeLegacyFeedBatch,
} from "../scripts/legacy-task-converter.mjs";

test("legacy Feed positions become ordered unified actions for every selected machine", () => {
  const input = {
    schemaVersion: "xhs-legacy-feed-compat/v1",
    taskId: "legacy-feed-001",
    machines: ["02", "04", "05"],
    maxParallel: 2,
    count: 11,
    likeAt: 2,
    favoriteAt: 7,
  };
  const first = convertLegacyFeedRun(input);
  const second = convertLegacyFeedRun(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.deviceSelection.machines, input.machines);
  assert.equal(first.maxParallel, 2);
  assert.deepEqual(first.actions, [
    { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited" },
  ]);
});

test("legacy Batch accepts capability-bounded machine counts and preserves each run exactly", () => {
  const input = {
    schemaVersion: 1,
    batchId: "legacy-batch-001",
    mode: "feed_read_only",
    maxParallel: 2,
    runs: [
      { machine: "02", taskId: "legacy-batch-001-02", count: 11 },
      { machine: "04", taskId: "legacy-batch-001-04", count: 3 },
      { machine: "05", taskId: "legacy-batch-001-05", count: 7 },
    ],
  };
  const task = convertLegacyFeedBatch(input);
  assert.deepEqual(task.deviceSelection.machines, ["02", "04", "05"]);
  assert.equal(task.source.count, 11);
  assert.deepEqual(task.sourceCountsByMachine, input.runs.map(({ machine, count }) => ({ machine, count })));
  assert.deepEqual(task.taskIdsByMachine, input.runs.map(({ machine, taskId }) => ({ machine, taskId })));
  assert.deepEqual(task.actions, []);
});

test("legacy Batch validation rejects duplicate identity and values beyond unified finite bounds", () => {
  const base = {
    schemaVersion: 1,
    batchId: "legacy-batch-002",
    mode: "feed_read_only",
    maxParallel: 1,
    runs: [{ machine: "02", taskId: "legacy-batch-002-02", count: 1 }],
  };
  assert.throws(() => normalizeLegacyFeedBatch({ ...base, runs: [...base.runs, { ...base.runs[0] }] }), /unique/u);
  assert.throws(() => normalizeLegacyFeedBatch({ ...base, runs: [{ ...base.runs[0], count: 10001 }] }), /1\.\.10000/u);
});

test("legacy Feed derives safe deterministic worker task IDs from an 80-character task ID", () => {
  const task = convertLegacyFeedRun({
    schemaVersion: "xhs-legacy-feed-compat/v1",
    taskId: `t${"x".repeat(79)}`,
    machines: ["02", "04"],
    maxParallel: 2,
    count: 1,
  });
  assert.equal(task.taskIdsByMachine.length, 2);
  assert.equal(task.taskIdsByMachine.every(({ taskId }) => taskId.length <= 80), true);
  assert.equal(new Set(task.taskIdsByMachine.map(({ taskId }) => taskId)).size, 2);
});
