import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDryRunProvider, runResearchTask, validateResearchTask } from "../scripts/research-core.mjs";
import { assertSchemaValid, schemaErrors } from "./json-schema-lite.mjs";

const configUrl = new URL("../config/", import.meta.url);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, configUrl), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function setAt(root, pathParts, value) {
  const result = clone(root);
  let cursor = result;
  for (const part of pathParts.slice(0, -1)) cursor = cursor[part];
  cursor[pathParts.at(-1)] = value;
  return result;
}

async function outputRoot() {
  return mkdtemp(path.join(os.tmpdir(), "xhs-schema-contract-"));
}

test("public task example matches the JSON schema and runtime validator", async () => {
  const [schema, example] = await Promise.all([
    readJson("research-task.schema.json"),
    readJson("research-task.example.json"),
  ]);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertSchemaValid(assert, schema, example, "public task example");
  assert.deepEqual(validateResearchTask(example), example);
});

test("task schema and runtime reject the same structural boundary violations", async () => {
  const [schema, example] = await Promise.all([
    readJson("research-task.schema.json"),
    readJson("research-task.example.json"),
  ]);
  const missingTopic = clone(example);
  delete missingTopic.topic;
  const invalid = [
    ["missing required field", missingTopic],
    ["unknown field", { ...example, unexpected: true }],
    ["unsafe mode", { ...example, mode: "engage" }],
    ["duplicate source", { ...example, sources: ["search", "search"] }],
    ["unknown source", { ...example, sources: ["search", "nearby"] }],
    ["budget over limit", setAt(example, ["budgets", "maxNotes"], 51)],
    ["fractional budget", setAt(example, ["budgets", "maxQueries"], 1.5)],
    ["AI call budget over limit", setAt(example, ["aiPolicy", "maxAutomaticCalls"], 5)],
    ["unknown nested AI key", { ...example, aiPolicy: { ...example.aiPolicy, model: "any" } }],
    ["whitespace-only topic", { ...example, topic: " \t " }],
    ["whitespace-only keyword", { ...example, seedKeywords: [" \t "] }],
    ["whitespace-only device group", { ...example, deviceGroup: " \t " }],
  ];

  for (const [name, value] of invalid) {
    assert.notDeepEqual(schemaErrors(schema, value), [], `${name} must fail the public schema`);
    assert.throws(() => validateResearchTask(value), undefined, `${name} must fail runtime validation`);
  }
});

test("forbidden interaction fields are rejected before any provider can run", async () => {
  const [schema, example] = await Promise.all([
    readJson("research-task.schema.json"),
    readJson("research-task.example.json"),
  ]);
  const forbiddenFields = [
    ["like", true],
    ["collect", true],
    ["follow", true],
    ["sendComment", "yes"],
    ["messages", []],
    ["publish", true],
    ["delete", true],
    ["payment", true],
  ];

  for (const [field, value] of forbiddenFields) {
    const unsafe = { ...example, [field]: value };
    assert.notDeepEqual(schemaErrors(schema, unsafe), [], `${field} must fail the public schema`);
    assert.throws(
      () => validateResearchTask(unsafe),
      (error) => error.code === "FORBIDDEN_INTERACTION",
      `${field} must trigger the explicit interaction guard`,
    );
  }

  const actionEnvelope = { ...example, engagementAction: "comment" };
  assert.throws(
    () => validateResearchTask(actionEnvelope),
    (error) => error.code === "FORBIDDEN_INTERACTION",
  );
  assert.doesNotThrow(() => validateResearchTask({
    ...example,
    topic: "comment analysis",
    commentMode: "metadata",
  }), "read-only comment analysis must not be a false positive");
});

test("task text boundaries match exactly in the public schema and runtime validator", async () => {
  const [schema, example] = await Promise.all([
    readJson("research-task.schema.json"),
    readJson("research-task.example.json"),
  ]);
  const invalid = [
    { ...example, topic: " capsule wardrobe" },
    { ...example, topic: "capsule wardrobe " },
    { ...example, seedKeywords: [" office outfit"] },
    { ...example, seedKeywords: ["office outfit "] },
    { ...example, deviceGroup: " content" },
    { ...example, deviceGroup: "content " },
    { ...example, topic: "t".repeat(121) },
    { ...example, seedKeywords: ["k".repeat(81)] },
    { ...example, deviceGroup: "g".repeat(41) },
  ];
  for (const value of invalid) {
    assert.notDeepEqual(schemaErrors(schema, value), []);
    assert.throws(() => validateResearchTask(value), (error) => error.code === "INVALID_SCHEMA");
  }

  const exactUnicodeLimits = {
    ...example,
    topic: "😀".repeat(120),
    seedKeywords: ["😀".repeat(80)],
    deviceGroup: "😀".repeat(40),
  };
  assert.deepEqual(schemaErrors(schema, exactUnicodeLimits), []);
  assert.deepEqual(validateResearchTask(exactUnicodeLimits), exactUnicodeLimits);

  const paddedDuplicate = { ...example, seedKeywords: ["office", " office "] };
  assert.notDeepEqual(schemaErrors(schema, paddedDuplicate), []);
  assert.throws(() => validateResearchTask(paddedDuplicate), (error) => error.code === "INVALID_SCHEMA");
});

test("runtime rejects model-call counts outside the public 0..4 budget", async () => {
  const task = await readJson("research-task.example.json");
  const provider = createDryRunProvider({ devices: ["device-01"] });
  for (const modelCalls of [-1, 5, 1.5, Number.NaN]) {
    await assert.rejects(
      runResearchTask({ ...task, taskId: `schema-ai-budget-${String(modelCalls).replace(/\W/g, "x")}` }, {
        provider,
        outputRoot: await outputRoot(),
        modelCalls,
      }),
      (error) => error.code === "INVALID_AI_BUDGET",
    );
  }
  assert.equal(provider.calls.length, 0);
});

test("completed, duplicate, no-device, and human-required results match the public result schema", async () => {
  const [task, schema] = await Promise.all([
    readJson("research-task.example.json"),
    readJson("research-result.schema.json"),
  ]);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");

  const completedTask = { ...task, taskId: "schema-completed", sources: ["search"] };
  const completedRoot = await outputRoot();
  const provider = createDryRunProvider({ devices: ["device-01", "device-02", "device-03"] });
  const completed = await runResearchTask(completedTask, {
    provider,
    outputRoot: completedRoot,
    modelCalls: 4,
  });
  assertSchemaValid(assert, schema, completed, "completed result");
  assertSchemaValid(assert, schema, JSON.parse(await readFile(completed.paths.summaryJson, "utf8")), "persisted result");

  const duplicate = await runResearchTask(completedTask, {
    provider,
    outputRoot: completedRoot,
    modelCalls: 4,
  });
  assert.equal(duplicate.status, "duplicate");
  assertSchemaValid(assert, schema, duplicate, "duplicate result");

  const noDevice = await runResearchTask(
    { ...task, taskId: "schema-no-device", sources: ["search"] },
    {
      outputRoot: await outputRoot(),
      provider: { async listDevices() { return []; }, async executeWorkUnit() { assert.fail("must not execute"); } },
    },
  );
  assert.equal(noDevice.status, "failed");
  assertSchemaValid(assert, schema, noDevice, "no-device result");

  const humanRequired = await runResearchTask(
    { ...task, taskId: "schema-human-required", sources: ["search"], seedKeywords: [] },
    {
      outputRoot: await outputRoot(),
      provider: createDryRunProvider({
        devices: ["device-01"],
        outcomeForUnit() {
          return { status: "human_required", failureSignature: "LOGIN_OR_CHALLENGE", stopAll: true };
        },
      }),
    },
  );
  assert.equal(humanRequired.status, "human_required");
  assert.equal(humanRequired.globalFuse.reason, "PROVIDER_STOP");
  assertSchemaValid(assert, schema, humanRequired, "human-required result");
});

test("unsafe provider aliases cannot become event filenames or public device fields", async () => {
  const task = await readJson("research-task.example.json");
  await assert.rejects(
    runResearchTask(
      { ...task, taskId: "schema-unsafe-alias", sources: ["search"] },
      {
        outputRoot: await outputRoot(),
        provider: {
          async listDevices() { return [{ alias: "../real-device-serial", online: true }]; },
          async executeWorkUnit() { assert.fail("must not execute with an unsafe alias"); },
        },
      },
    ),
    (error) => error.code === "INVALID_PROVIDER",
  );
});

test("result schema rejects leaked identifiers and out-of-budget model counts", async () => {
  const schema = await readJson("research-result.schema.json");
  const valid = {
    schemaVersion: 1,
    taskId: "schema-minimal",
    taskHash: "a".repeat(64),
    effectiveTaskHash: "b".repeat(64),
    status: "completed",
    counts: { queries: 0, notes: 0, duplicates: 0, modelCalls: 0 },
    paths: {
      taskDirectory: "data/research/schema-minimal",
      candidatesJsonl: "data/research/schema-minimal/candidates.jsonl",
      humanReviewJsonl: "data/research/schema-minimal/human-review.jsonl",
      summaryJson: "data/research/schema-minimal/summary.json",
      eventsDirectory: "data/research/schema-minimal/events",
    },
    artifacts: {
      candidates: "data/research/schema-minimal/candidates.jsonl",
      reviewQueue: "data/research/schema-minimal/human-review.jsonl",
      summary: "data/research/schema-minimal/summary.json",
      candidatesJsonl: "data/research/schema-minimal/candidates.jsonl",
      humanReviewJsonl: "data/research/schema-minimal/human-review.jsonl",
      summaryJson: "data/research/schema-minimal/summary.json",
    },
  };
  assertSchemaValid(assert, schema, valid);
  assert.notDeepEqual(schemaErrors(schema, { ...valid, deviceSerial: "real-device-id" }), []);
  assert.notDeepEqual(schemaErrors(schema, { ...valid, counts: { ...valid.counts, modelCalls: 5 } }), []);
  assert.notDeepEqual(schemaErrors(schema, { ...valid, devices: ["safe-alias", "unsafe alias"] }), []);
  assert.notDeepEqual(schemaErrors(schema, { ...valid, paths: { ...valid.paths, screenshot: "screen.png" } }), []);
});

test("supervised composite policy and initial capability candidate match their public schemas", async () => {
  const [policySchema, policy, capabilitySchema, capability] = await Promise.all([
    readJson("composite-policy.schema.json"),
    readJson("composite-policy.supervised-v1.json"),
    readJson("composite-capability.schema.json"),
    readJson("composite-capability.initial-v1.json"),
  ]);

  assertSchemaValid(assert, policySchema, policy, "supervised composite policy");
  assertSchemaValid(assert, capabilitySchema, capability, "initial composite capability candidate");
  assert.equal(capability.profileKind, "production_candidate");
  assert.equal(capability.maxDevices, 2);
  assert.equal(capability.runtimeProfile.validationMode, "startup_strict_runtime_light_account_state_strict");
  assert.ok(
    capability.runtimeProfile.cpaWorkflowSoftTimeoutMs < capability.cpaLimits.providerHardTimeoutMs,
    "CPA workflow soft timeout must degrade before the provider hard timeout",
  );
});
