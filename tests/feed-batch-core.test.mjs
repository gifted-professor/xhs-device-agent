import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBatchSummary,
  classifyFeedBatchFailure,
  createBatchAttemptId,
  createBatchManifest,
  feedBatchSpecHash,
  normalizeFeedBatchSpec,
} from "../scripts/feed-batch-core.mjs";

function validSpec() {
  return {
    schemaVersion: 1,
    batchId: "feed-batch-001",
    mode: "feed_read_only",
    maxParallel: 2,
    runs: [
      { machine: "04", taskId: "feed-batch-001-04", count: 3 },
      { machine: "05", taskId: "feed-batch-001-05", count: 3 },
    ],
  };
}

test("batch spec accepts one or two explicit read-only runs and normalizes deterministically", () => {
  const spec = normalizeFeedBatchSpec(validSpec());
  assert.equal(spec.runs.length, 2);
  assert.equal(spec.maxParallel, 2);
  assert.equal(feedBatchSpecHash(spec), feedBatchSpecHash(validSpec()));
  const single = normalizeFeedBatchSpec({ ...validSpec(), maxParallel: 1, runs: [validSpec().runs[0]] });
  assert.equal(single.runs.length, 1);
});

test("batch spec rejects interactions, unknown fields, dynamic targets, duplicates, and a third device", () => {
  const cases = [
    { ...validSpec(), likeAt: 1 },
    { ...validSpec(), mode: "trusted-10" },
    { ...validSpec(), maxParallel: 3 },
    { ...validSpec(), maxParallel: 1 },
    { ...validSpec(), runs: [...validSpec().runs, { machine: "06", taskId: "feed-batch-001-06", count: 3 }] },
    { ...validSpec(), runs: [{ ...validSpec().runs[0], group: "content" }] },
    { ...validSpec(), runs: [validSpec().runs[0], { ...validSpec().runs[1], machine: "04" }] },
    { ...validSpec(), runs: [validSpec().runs[0], { ...validSpec().runs[1], taskId: validSpec().runs[0].taskId }] },
  ];
  for (const value of cases) assert.throws(() => normalizeFeedBatchSpec(value));
});

test("batch manifest and summary expose machine numbers but no internal device bindings", () => {
  const manifest = createBatchManifest(validSpec(), { createdAt: "2026-07-15T00:00:00.000Z" });
  const summary = buildBatchSummary({
    manifest,
    attemptId: "attempt-001",
    results: manifest.runs.map((entry) => ({ ...entry, status: "completed", viewedCount: 3, skippedCount: 0 })),
  });
  assert.equal(summary.status, "completed");
  assert.deepEqual(summary.results.map((entry) => entry.machine), ["04", "05"]);
  assert.equal(/serial|deviceAlias|adb/i.test(JSON.stringify(summary)), false);
});

test("failure classification separates mandatory safety from batch integrity and local failures", () => {
  assert.equal(classifyFeedBatchFailure("SENSITIVE_PAGE"), "global_safety");
  assert.equal(classifyFeedBatchFailure("BATCH_PARENT_LOST"), "batch_integrity");
  assert.equal(classifyFeedBatchFailure("UI_DUMP_INVALID"), "device_local");
});

test("attempt IDs are safe and fuse status is reflected in the public summary", () => {
  const attemptId = createBatchAttemptId(new Date("2026-07-15T00:00:00.000Z"), "abcd1234");
  assert.match(attemptId, /^[A-Za-z0-9._-]+$/u);
  const manifest = createBatchManifest(validSpec());
  const summary = buildBatchSummary({
    manifest,
    attemptId,
    fuse: { category: "global_safety", code: "SENSITIVE_PAGE", taskId: validSpec().runs[0].taskId },
  });
  assert.equal(summary.status, "human_required");
  assert.equal(summary.fuse.code, "SENSITIVE_PAGE");
});
