import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  XiaoweiAutoScrollService,
  readAutoScrollJson,
  writeAutoScrollJson,
} from "../scripts/lib/xiaowei-auto-scroll-service.mjs";
import { runWorker } from "../scripts/xiaowei-auto-scroll-worker.mjs";

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), "xiaowei-auto-scroll-test-"));
}

test("managed auto-scroll start is bounded, detached, private, and idempotent", () => {
  const stateDir = tempStateDir();
  const spawns = [];
  const service = new XiaoweiAutoScrollService({
    stateDir,
    workerPath: "/worker.mjs",
    createRunId: () => "run-1",
    now: () => 1000,
    isProcessAlive: () => true,
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return { pid: 4321, unref() {} };
    },
  });

  const started = service.start({ deviceAlias: "01", direction: "up", intervalMs: 1500, maxSwipes: 5 });
  assert.equal(started.state, "starting");
  assert.equal(started.runId, "run-1");
  assert.equal(started.maxSwipes, 5);
  assert.equal(Object.hasOwn(started, "pid"), false);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.detached, true);
  assert.match(spawns[0].args.join(" "), /--run-id run-1/);

  const again = service.start({ deviceAlias: "01", direction: "up", intervalMs: 1500, maxSwipes: 5 });
  assert.equal(again.idempotent, true);
  assert.equal(spawns.length, 1);
  assert.throws(
    () => service.start({ deviceAlias: "01", direction: "down", intervalMs: 1500, maxSwipes: 5 }),
    /already has an auto-scroll task/,
  );
  assert.doesNotMatch(readFileSync(join(stateDir, "01.json"), "utf8"), /runtime-device|serial/);
});

test("managed auto-scroll validates bounds and reports idle without spawning", () => {
  const service = new XiaoweiAutoScrollService({ stateDir: tempStateDir() });
  assert.deepEqual(service.status({ deviceAlias: "01" }), { status: "idle", state: "idle", deviceAlias: "01" });
  assert.throws(() => service.start({ deviceAlias: "01", maxSwipes: 0 }), /maxSwipes/);
  assert.throws(() => service.start({ deviceAlias: "01", maxSwipes: 1, intervalMs: 499 }), /intervalMs/);
  assert.throws(() => service.start({ deviceAlias: "1", maxSwipes: 1 }), /two-digit/);
  assert.throws(() => service.start({ deviceAlias: "02", maxSwipes: 1 }), /only device alias 01/);
});

test("managed stop uses a run-scoped control file and waits for worker acknowledgement", async () => {
  const stateDir = tempStateDir();
  const statePath = join(stateDir, "01.json");
  const stopPath = join(stateDir, "01.stop.json");
  writeAutoScrollJson(statePath, {
    status: "running",
    state: "running",
    runId: "run-2",
    deviceAlias: "01",
    direction: "up",
    intervalMs: 2000,
    maxSwipes: 20,
    completedSwipes: 3,
    startedAt: 10,
    updatedAt: 10,
    finishedAt: null,
    errorClass: null,
    pid: 99,
  });
  let now = 20;
  const service = new XiaoweiAutoScrollService({
    stateDir,
    now: () => now,
    isProcessAlive: () => true,
    async sleepImpl() {
      now += 100;
      const state = readAutoScrollJson(statePath);
      writeAutoScrollJson(statePath, { ...state, status: "stopped", state: "stopped", finishedAt: now, updatedAt: now });
    },
  });

  const stopped = await service.stop({ deviceAlias: "01", waitMs: 500 });
  assert.equal(stopped.state, "stopped");
  assert.deepEqual(readAutoScrollJson(stopPath), { runId: "run-2", requestedAt: 20 });
  const repeated = await service.stop({ deviceAlias: "01" });
  assert.equal(repeated.status, "not_running");
  assert.equal(repeated.idempotent, true);
});

test("worker performs only the bounded number of one-shot swipes", async () => {
  const stateDir = tempStateDir();
  const statePath = join(stateDir, "01.json");
  const stopPath = join(stateDir, "01.stop.json");
  writeAutoScrollJson(statePath, {
    status: "starting",
    state: "starting",
    runId: "run-3",
    deviceAlias: "01",
    direction: "down",
    intervalMs: 1,
    maxSwipes: 3,
    completedSwipes: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    errorClass: null,
    pid: null,
  });
  const calls = [];
  const result = await runWorker({
    statePath,
    stopPath,
    runId: "run-3",
    client: { async swipe(input) { calls.push(input); } },
  });
  assert.equal(result.state, "completed");
  assert.equal(result.completedSwipes, 3);
  assert.deepEqual(calls, [
    { deviceAlias: "01", direction: "down" },
    { deviceAlias: "01", direction: "down" },
    { deviceAlias: "01", direction: "down" },
  ]);
});

test("worker honors a matching stop request before sending another swipe", async () => {
  const stateDir = tempStateDir();
  const statePath = join(stateDir, "01.json");
  const stopPath = join(stateDir, "01.stop.json");
  writeAutoScrollJson(statePath, {
    status: "starting", state: "starting", runId: "run-4", deviceAlias: "01",
    direction: "up", intervalMs: 1000, maxSwipes: 10, completedSwipes: 2,
    startedAt: 1, updatedAt: 1, finishedAt: null, errorClass: null, pid: null,
  });
  writeAutoScrollJson(stopPath, { runId: "run-4", requestedAt: 2 });
  let called = false;
  const result = await runWorker({
    statePath,
    stopPath,
    runId: "run-4",
    client: { async swipe() { called = true; } },
  });
  assert.equal(result.state, "stopped");
  assert.equal(called, false);
});
