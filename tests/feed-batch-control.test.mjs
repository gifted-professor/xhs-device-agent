import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertBatchControlActiveSync,
  initializeBatchControl,
  markBatchWorkerReady,
  readBatchFuse,
  releaseBatchBarrier,
  tripBatchFuse,
  writeBatchLease,
  writeManifestOnce,
} from "../scripts/feed-batch-control.mjs";
import { createBatchManifest } from "../scripts/feed-batch-core.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "xhs-feed-batch-control-"));
  const attemptId = "attempt-001";
  return { root, attemptId, paths: initializeBatchControl(root, attemptId) };
}

function spec(batchId = "feed-batch-001") {
  return {
    schemaVersion: 1,
    batchId,
    mode: "feed_read_only",
    maxParallel: 1,
    runs: [{ machine: "04", taskId: batchId + "-04", count: 3 }],
  };
}

test("manifest is immutable for one batchId and conflicting reuse fails", () => {
  const { root, paths } = fixture();
  try {
    const manifest = createBatchManifest(spec());
    assert.equal(writeManifestOnce(paths, manifest).created, true);
    assert.equal(writeManifestOnce(paths, manifest).created, false);
    assert.throws(() => writeManifestOnce(paths, createBatchManifest({ ...spec(), maxParallel: 1, runs: [{ ...spec().runs[0], count: 4 }] })));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ready markers and two barriers are attempt-scoped", () => {
  const { root, attemptId, paths } = fixture();
  try {
    writeBatchLease(paths, { attemptId, updatedAt: "2026-07-15T00:00:00.000Z" });
    const ready = markBatchWorkerReady(paths, { stage: "lock", taskId: "feed-batch-001-04", machine: "04" });
    assert.equal(JSON.parse(readFileSync(ready, "utf8")).stage, "lock");
    releaseBatchBarrier(paths, "preflight");
    releaseBatchBarrier(paths, "start");
    assert.throws(() => releaseBatchBarrier(paths, "start"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fuse is monotonic and the first reason cannot be overwritten", () => {
  const { root, attemptId, paths } = fixture();
  try {
    const first = tripBatchFuse(paths, { attemptId, category: "global_safety", code: "SENSITIVE_PAGE", taskId: "task-001" });
    const second = tripBatchFuse(paths, { attemptId, category: "batch_integrity", code: "BATCH_PARENT_LOST" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(readBatchFuse(paths).code, "SENSITIVE_PAGE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutation control requires a current lease, released start barrier, and no fuse", () => {
  const { root, attemptId, paths } = fixture();
  const now = Date.parse("2026-07-15T00:00:10.000Z");
  try {
    assert.throws(() => assertBatchControlActiveSync(paths, { attemptId, requireStart: true, nowMs: now }));
    writeBatchLease(paths, { attemptId, updatedAt: "2026-07-15T00:00:00.000Z" });
    assert.throws(() => assertBatchControlActiveSync(paths, { attemptId, requireStart: true, nowMs: now }));
    releaseBatchBarrier(paths, "start");
    assert.doesNotThrow(() => assertBatchControlActiveSync(paths, { attemptId, requireStart: true, nowMs: now }));
    assert.throws(() => assertBatchControlActiveSync(paths, { attemptId, requireStart: true, nowMs: now + 6000 }));
    writeBatchLease(paths, { attemptId, updatedAt: "2026-07-15T00:00:16.000Z" });
    tripBatchFuse(paths, { attemptId, category: "batch_integrity", code: "BATCH_TEST_FUSE" });
    assert.throws(() => assertBatchControlActiveSync(paths, { attemptId, requireStart: true, nowMs: now + 6000 }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
