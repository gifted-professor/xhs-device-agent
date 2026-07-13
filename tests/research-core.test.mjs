import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkUnits,
  createDryRunProvider,
  dedupeCandidates,
  runResearchTask,
  validateResearchTask,
} from "../scripts/research-core.mjs";

function task(overrides = {}) {
  const value = {
    schemaVersion: 1,
    taskId: "xhs-test-001",
    mode: "research_read_only",
    topic: "夏季通勤穿搭",
    seedKeywords: ["a", "b", "c", "d", "e"],
    sources: ["search", "suggestions", "trending", "recommended"],
    deviceGroup: "content",
    commentMode: "metadata",
    interactionPolicy: "human_final",
    budgets: {
      wallClockSeconds: 60,
      maxQueries: 6,
      maxNotes: 50,
      maxNotesPerQuery: 5,
      maxResultScrollsPerQuery: 4,
      maxNoteScrolls: 3,
      maxCommentPanels: 5,
      maxCommentsPerNote: 5,
      maxNoNewScrolls: 2,
    },
    aiPolicy: {
      topicPlanner: true,
      pageFallback: true,
      resultAnalysis: true,
      maxAutomaticCalls: 4,
    },
  };
  return { ...value, ...overrides };
}

async function temporaryOutput() {
  return mkdtemp(path.join(os.tmpdir(), "xhs-research-core-"));
}

test("strict task validation accepts the public shape and blocks interactions", () => {
  const valid = validateResearchTask(task());
  assert.equal(valid.mode, "research_read_only");
  assert.equal(valid.interactionPolicy, "human_final");
  assert.equal(validateResearchTask({ ...task(), topic: "评论分析" }).topic, "评论分析");

  assert.throws(() => validateResearchTask({ ...task(), actions: ["like"] }), (error) => error.code === "FORBIDDEN_INTERACTION");
  assert.throws(() => validateResearchTask({ ...task(), actions: ["comment"] }), (error) => error.code === "FORBIDDEN_INTERACTION");
  assert.throws(() => validateResearchTask({ ...task(), topic: "请批量点赞这些笔记" }), (error) => error.code === "FORBIDDEN_INTERACTION");
  assert.throws(() => validateResearchTask({ ...task(), extra: true }), (error) => error.code === "INVALID_SCHEMA");
  assert.throws(() => validateResearchTask({ ...task(), mode: "engage" }), (error) => error.code === "INVALID_SCHEMA");
  assert.throws(() => validateResearchTask({ ...task(), aiPolicy: { ...task().aiPolicy, maxAutomaticCalls: 5 } }),
    (error) => error.code === "INVALID_SCHEMA");
});

test("stable assignment uses at most three devices and each device executes serially", async () => {
  const input = task({ taskId: "xhs-serial-001" });
  const first = buildWorkUnits(input, ["d3", "d1", "d2", "d4"]);
  const second = buildWorkUnits(input, ["d2", "d1", "d3"]);
  assert.deepEqual(first.map(({ source, keyword, assignedDevice }) => ({ source, keyword, assignedDevice })),
    second.map(({ source, keyword, assignedDevice }) => ({ source, keyword, assignedDevice })));
  assert.deepEqual([...new Set(first.map((unit) => unit.assignedDevice))].sort(), ["d1", "d2", "d3"]);

  const active = new Set();
  let overlap = false;
  const provider = createDryRunProvider({
    devices: ["d3", "d2", "d1", "d4"],
    async outcomeForUnit(context) {
      if (active.has(context.deviceAlias)) overlap = true;
      active.add(context.deviceAlias);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active.delete(context.deviceAlias);
      return {
        status: "completed",
        candidates: [{ noteId: `n-${context.unit.unitId}`, author: "a", title: context.unit.keyword, mediaType: "image" }],
      };
    },
  });
  const summary = await runResearchTask(input, { provider, outputRoot: await temporaryOutput() });
  assert.equal(summary.status, "completed");
  assert.equal(overlap, false);
  assert.deepEqual(summary.devices, ["d1", "d2", "d3"]);
  assert.equal(summary.counts.modelCalls, 0);
});

test("candidate dedupe prefers noteId, then metadata hash and n-gram similarity", () => {
  const values = dedupeCandidates([
    { candidateId: "c1", noteId: "note-1", author: "甲", title: "原题", mediaType: "image", source: "search", keyword: "a", deviceAlias: "d1" },
    { candidateId: "c2", noteId: "note-1", author: "甲", title: "另一个标题", mediaType: "image", source: "trending", keyword: "b", deviceAlias: "d2" },
    { author: "甲", title: "原题", mediaType: "image", source: "recommended", keyword: "c", deviceAlias: "d3" },
    { author: "乙", title: "夏季通勤穿搭实用技巧完整指南abcdefghijklmnopqrst一", mediaType: "video", source: "search", keyword: "a", deviceAlias: "d1" },
    { author: "乙", title: "夏季通勤穿搭实用技巧完整指南abcdefghijklmnopqrst二", mediaType: "video", source: "suggestions", keyword: "b", deviceAlias: "d3" },
  ]);
  assert.equal(values.length, 2);
  assert.equal(values.find((value) => value.noteId === "note-1").duplicateCount, 3);
  assert.equal(values.find((value) => value.noteId === null).duplicateCount, 2);
});

test("taskId is idempotent and a changed payload is rejected", async () => {
  const outputRoot = await temporaryOutput();
  const input = task({ taskId: "xhs-idempotent-001", sources: ["search"] });
  const provider = createDryRunProvider({ devices: ["d1", "d2", "d3"] });
  const original = await runResearchTask(input, { provider, outputRoot });
  const callCount = provider.calls.length;
  const duplicate = await runResearchTask(input, { provider, outputRoot });
  assert.equal(original.status, "completed");
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.originalStatus, "completed");
  assert.equal(provider.calls.length, callCount);
  for (const key of ["candidates", "reviewQueue", "summary", "candidatesJsonl", "humanReviewJsonl", "summaryJson"]) {
    assert.equal(typeof original.artifacts[key], "string");
  }
  assert.match(await readFile(original.artifacts.candidatesJsonl, "utf8"), /dry-/);
  await assert.rejects(
    runResearchTask({ ...input, topic: "不同主题" }, { provider, outputRoot }),
    (error) => error.code === "TASK_ID_CONFLICT",
  );
});

test("offline unstarted work is reassigned once", async () => {
  const input = task({ taskId: "xhs-offline-001" });
  const provider = createDryRunProvider({
    devices: ["d1", "d2", "d3"],
    isDeviceOnline({ deviceAlias }) { return deviceAlias !== "d1"; },
  });
  const summary = await runResearchTask(input, { provider, outputRoot: await temporaryOutput() });
  assert.equal(summary.status, "completed");
  assert(provider.calls.some((call) => call.attempt === 1));
  assert(provider.calls.every((call) => call.attempt <= 1));
});

test("one device is isolated while peers continue, and duplicate signatures trip the global fuse", async () => {
  const isolatedProvider = createDryRunProvider({
    devices: ["d1", "d2", "d3"],
    outcomeForUnit({ deviceAlias, unit }) {
      if (deviceAlias === "d1") return { status: "failed", failureSignature: `only-d1-${unit.ordinal}` };
      return { status: "completed", candidates: [{ noteId: unit.unitId, author: "a", title: unit.keyword, mediaType: "image" }] };
    },
  });
  const isolated = await runResearchTask(task({ taskId: "xhs-isolation-001" }), {
    provider: isolatedProvider,
    outputRoot: await temporaryOutput(),
  });
  assert.equal(isolated.status, "partial");
  assert(isolated.counts.completedUnits > 0);
  assert(isolated.counts.failedUnits > 0);
  assert(isolatedProvider.calls.filter((call) => call.deviceAlias === "d1").length <= 2);
  assert(isolatedProvider.calls.some((call) => call.deviceAlias !== "d1"));
  assert.equal(isolated.globalFuse, null);

  const fuseProvider = createDryRunProvider({
    devices: ["d1", "d2", "d3"],
    outcomeForUnit() { return { status: "failed", failureSignature: "selector-missing" }; },
  });
  const fused = await runResearchTask(task({ taskId: "xhs-fuse-001" }), {
    provider: fuseProvider,
    outputRoot: await temporaryOutput(),
  });
  assert.equal(fused.status, "failed");
  assert.equal(fused.globalFuse.signature, "selector-missing");
  assert.equal(fused.globalFuse.reason, "SAME_FAILURE_ON_TWO_DEVICES");
});

test("provider-created human review rows always carry task and topic identity", async () => {
  const input = task({
    taskId: "xhs-review-identity-001",
    topic: "review topic",
    sources: ["search"],
    seedKeywords: [],
  });
  const provider = createDryRunProvider({
    devices: ["d1"],
    outcomeForUnit() {
      return {
        status: "human_required",
        candidates: [],
        humanReview: [{ candidateKey: "candidate-1", reason: "manual check" }],
        failureSignature: "input:human_required",
        affectsDeviceHealth: false,
      };
    },
  });
  const summary = await runResearchTask(input, { provider, outputRoot: await temporaryOutput() });
  const rows = (await readFile(summary.paths.humanReviewJsonl, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, input.taskId);
  assert.equal(rows[0].topic, input.topic);
});

test("source-unavailable units are skipped without isolating a healthy device", async () => {
  const provider = createDryRunProvider({
    devices: ["d1"],
    outcomeForUnit({ unit }) {
      if (unit.source === "trending") return { status: "skipped", failureSignature: "source_unavailable:trending" };
      return { status: "completed", candidates: [{ noteId: unit.unitId, title: unit.keyword, mediaType: "image" }] };
    },
  });
  const summary = await runResearchTask(task({
    taskId: "xhs-source-skip-001",
    sources: ["trending", "search"],
  }), { provider, outputRoot: await temporaryOutput() });
  assert.equal(summary.status, "partial");
  assert.equal(summary.counts.skippedUnits, 1);
  assert(summary.counts.completedUnits > 2);
  assert(provider.calls.length > 2, "a skipped source must not trip the two-failure device fuse");
});

test("the global note budget stops later work without turning a successful cap into partial", async () => {
  const provider = createDryRunProvider({ devices: ["d1"] });
  const summary = await runResearchTask(task({
    taskId: "xhs-note-budget-001",
    sources: ["search"],
    budgets: { ...task().budgets, maxNotes: 1 },
  }), { provider, outputRoot: await temporaryOutput() });
  assert.equal(summary.status, "completed");
  assert.equal(summary.counts.notes, 1);
  assert.equal(summary.counts.completedUnits, 1);
  assert(summary.counts.budgetCappedUnits > 0);
  assert.equal(provider.calls.length, 1);
});

test("an interrupted run resumes completed work units from its checkpoint", async () => {
  const outputRoot = await temporaryOutput();
  const input = task({ taskId: "xhs-resume-001", sources: ["search"], seedKeywords: ["a", "b"] });
  let completedBeforeCrash = 0;
  const interrupted = createDryRunProvider({
    devices: ["d1"],
    outcomeForUnit({ unit }) {
      if (unit.ordinal === 1) {
        const error = new Error("simulated process interruption");
        error.fatal = true;
        error.failureSignature = "test:interrupted";
        throw error;
      }
      completedBeforeCrash += 1;
      return { status: "completed", candidates: [{ noteId: unit.unitId, title: unit.keyword, mediaType: "image" }] };
    },
  });
  await assert.rejects(runResearchTask(input, { provider: interrupted, outputRoot }), /interruption/);
  assert.equal(completedBeforeCrash, 1);

  const resumed = createDryRunProvider({ devices: ["d1"] });
  const summary = await runResearchTask(input, { provider: resumed, outputRoot });
  assert.equal(summary.status, "completed");
  assert.equal(summary.counts.workUnits, 3);
  assert.equal(summary.counts.completedUnits, 3);
  assert.equal(resumed.calls.length, 2, "the checkpointed first unit must not execute again");
});
