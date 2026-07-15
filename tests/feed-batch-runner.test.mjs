import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";

import { batchControlPaths, markBatchWorkerReady } from "../scripts/feed-batch-control.mjs";
import { runFeedBatch } from "../scripts/feed-batch-runner.mjs";

function spec() {
  return {
    schemaVersion: 1,
    batchId: "feed-batch-runner-001",
    mode: "feed_read_only",
    maxParallel: 2,
    runs: [
      { machine: "04", taskId: "feed-batch-runner-001-04", count: 2 },
      { machine: "05", taskId: "feed-batch-runner-001-05", count: 2 },
    ],
  };
}

function fakeWorker({ batchRoot, attemptId, outputRoot, run }, timeline) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", 2, "SIGTERM"));
    return true;
  };
  const paths = batchControlPaths(batchRoot, attemptId);
  queueMicrotask(async () => {
    timeline.push("spawn:" + run.machine);
    markBatchWorkerReady(paths, { stage: "lock", taskId: run.taskId, machine: run.machine });
    while (!existsSync(paths.preflightGo)) await new Promise((resolve) => setTimeout(resolve, 2));
    timeline.push("preflight:" + run.machine);
    markBatchWorkerReady(paths, { stage: "preflight", taskId: run.taskId, machine: run.machine });
    while (!existsSync(paths.start)) await new Promise((resolve) => setTimeout(resolve, 2));
    timeline.push("start:" + run.machine);
    const runDir = path.join(outputRoot, run.taskId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
      taskId: run.taskId,
      status: "completed",
      viewedCount: run.count,
      skippedCount: 0,
    }));
    child.emit("exit", 0, null);
  });
  return child;
}

test("two workers acquire locks and finish preflight before either receives GO", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "xhs-feed-batch-runner-"));
  const timeline = [];
  try {
    const summary = await runFeedBatch(spec(), {
      projectRoot: root,
      outputRoot: path.join(root, "batch-output"),
      feedOutputRoot: path.join(root, "feed-output"),
      attemptId: "attempt-001",
      barrierTimeoutMs: 1000,
      pollMs: 2,
    }, {
      disableSignalHandlers: true,
      spawnWorker: (input) => fakeWorker(input, timeline),
    });
    assert.equal(summary.status, "completed");
    assert.deepEqual(summary.results.map((entry) => entry.machine), ["04", "05"]);
    const firstStart = timeline.findIndex((entry) => entry.startsWith("start:"));
    assert.equal(timeline.slice(0, firstStart).filter((entry) => entry.startsWith("preflight:")).length, 2);
    const paths = batchControlPaths(path.join(root, "batch-output", spec().batchId), "attempt-001");
    assert.equal(readFileSync(paths.events, "utf8").trim().split(/\r?\n/u).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run writes a plan without spawning workers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "xhs-feed-batch-dry-"));
  let spawned = false;
  try {
    const summary = await runFeedBatch(spec(), {
      projectRoot: root,
      outputRoot: path.join(root, "batch-output"),
      attemptId: "attempt-dry-001",
      dryRun: true,
    }, {
      spawnWorker: () => { spawned = true; },
    });
    assert.equal(summary.status, "dry_run");
    assert.equal(spawned, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
