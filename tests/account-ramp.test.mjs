import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAccountRampTask,
  recordAccountRampResult,
  validateAccountRampProfile,
  writeAccountRampTask,
} from "../scripts/account-ramp.mjs";
import { schemaErrors } from "./json-schema-lite.mjs";

const example = JSON.parse(await readFile(new URL("../config/account-ramp-profile.example.json", import.meta.url), "utf8"));
const schema = JSON.parse(await readFile(new URL("../config/account-ramp-profile.schema.json", import.meta.url), "utf8"));

test("account ramp example matches its schema and generates a bounded read-only task", () => {
  assert.deepEqual(schemaErrors(schema, example), []);
  const profile = validateAccountRampProfile(example);
  const task = buildAccountRampTask(profile, { date: "2026-07-14", sequence: 1 });
  assert.equal(task.taskId, "ramp-account-example-20260714-01");
  assert.equal(task.mode, "research_read_only");
  assert.equal(task.interactionPolicy, "human_final");
  assert.deepEqual(task.sources, ["suggestions", "search"]);
  assert.equal(task.commentMode, "none");
  assert.equal(task.budgets.maxNotes, 5);
  assert.equal(task.budgets.maxCommentPanels, 0);
  assert.equal(task.aiPolicy.resultAnalysis, false);
  for (const field of ["actions", "like", "favorite", "follow", "comment", "message", "publish", "delete"]) {
    assert.equal(Object.hasOwn(task, field), false);
  }
  assert.equal(task.budgets.maxCommentsPerNote, 0);
});

test("later approved phases increase research evidence without enabling engagement", () => {
  for (const phase of ["content_preparation", "steady_operation"]) {
    const profile = {
      ...example,
      phase,
      phaseApproval: { phase, approved: true, approvedAt: "2026-07-14T00:00:00+08:00" },
    };
    const task = buildAccountRampTask(profile, { date: "2026-07-15", sequence: 2 });
    assert.deepEqual(task.sources, ["suggestions", "search", "trending", "recommended"]);
    assert.equal(task.commentMode, "metadata");
    assert.equal(task.budgets.maxCommentsPerNote, 0);
    assert.ok(task.budgets.maxCommentPanels <= 2);
    assert.ok(task.aiPolicy.maxAutomaticCalls <= 3);
  }
});

test("paused, human-required, retired, unapproved, and initialization phases stop before task creation", () => {
  const blocked = [
    [{ ...example, paused: true }, "ACCOUNT_RAMP_PAUSED"],
    [{ ...example, phase: "human_required", phaseApproval: { phase: "human_required", approved: true, approvedAt: "2026-07-14T00:00:00Z" } }, "ACCOUNT_HUMAN_REQUIRED"],
    [{ ...example, phase: "retired", phaseApproval: { phase: "retired", approved: true, approvedAt: "2026-07-14T00:00:00Z" } }, "ACCOUNT_RETIRED"],
    [{ ...example, phase: "profile_ready", phaseApproval: { phase: "profile_ready", approved: true, approvedAt: "2026-07-14T00:00:00Z" } }, "PHASE_NOT_EXECUTABLE"],
  ];
  for (const [profile, code] of blocked) {
    assert.throws(() => buildAccountRampTask(profile, { date: "2026-07-14" }), (error) => error.code === code);
  }
  assert.throws(
    () => buildAccountRampTask({ ...example, phaseApproval: { ...example.phaseApproval, approved: false } }, { date: "2026-07-14" }),
    (error) => error.code === "INVALID_ACCOUNT_PROFILE",
  );
  assert.throws(
    () => buildAccountRampTask({ ...example, password: "must-never-exist" }, { date: "2026-07-14" }),
    (error) => error.code === "INVALID_ACCOUNT_PROFILE",
  );
});

test("daily task generation is deterministic and rejects conflicting reuse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xhs-account-ramp-"));
  const first = await writeAccountRampTask(example, { accountDataRoot: root, date: "2026-07-14", sequence: 1 });
  const duplicate = await writeAccountRampTask(example, { accountDataRoot: root, date: "2026-07-14", sequence: 1 });
  assert.equal(first.taskPath, duplicate.taskPath);
  const persisted = JSON.parse(await readFile(first.taskPath, "utf8"));
  assert.equal(persisted.taskId, first.taskId);
  await assert.rejects(
    writeAccountRampTask({ ...example, primaryTopic: "办公室穿搭", topicPool: ["办公室穿搭"] }, {
      accountDataRoot: root, date: "2026-07-14", sequence: 1,
    }),
    (error) => error.code === "RAMP_TASK_CONFLICT",
  );
});

test("run records never advance phases automatically and retain only safe summary fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xhs-account-ramp-record-"));
  const researchRoot = path.join(root, "research");
  const candidatesPath = path.join(researchRoot, "ramp-account-example-20260714-01", "candidates.jsonl");
  await mkdir(path.dirname(candidatesPath), { recursive: true });
  await writeFile(candidatesPath, `${JSON.stringify({
    candidateId: "candidate-01",
    title: "通勤鞋候选",
    author: "公开作者",
    mediaType: "image",
    source: "search",
    keyword: "通勤鞋",
    deviceAlias: "device-example",
    serial: "must-not-survive",
  })}\n`, "utf8");
  const summary = {
    taskId: "ramp-account-example-20260714-01",
    status: "completed",
    counts: { completedUnits: 2, failedUnits: 0, skippedUnits: 1, candidates: 4, humanReview: 0 },
    sourceSkips: [{ source: "trending", reason: "source_unavailable:trending", deviceAlias: "device-example" }],
    devices: ["device-example"],
    paths: { candidatesJsonl: candidatesPath },
  };
  const record = await recordAccountRampResult(example, summary, {
    accountDataRoot: root,
    researchDataRoot: researchRoot,
    recordedAt: "2026-07-14T03:00:00.000Z",
  });
  assert.equal(record.phase, "topic_learning");
  assert.equal(record.needsHuman, false);
  assert.deepEqual(record.sourceSkips, [{ source: "trending", reason: "source_unavailable:trending" }]);
  const persisted = await readFile(record.reportPath, "utf8");
  assert.equal(persisted.includes("device-example"), false);
  const state = JSON.parse(await readFile(record.statePath, "utf8"));
  assert.equal(state.phase, "topic_learning");
  assert.equal(state.lastStatus, "completed");
  const queue = JSON.parse(await readFile(record.queuePath, "utf8"));
  assert.equal(queue.status, "ready");
  assert.equal(queue.candidates.length, 1);
  assert.equal(queue.candidates[0].candidateId, "candidate-01");
  assert.equal(JSON.stringify(queue).includes("must-not-survive"), false);
  assert.deepEqual(JSON.parse(await readFile(record.todayQueuePath, "utf8")), queue);
});
