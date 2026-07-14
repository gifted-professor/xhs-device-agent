import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDryRunProvider } from "../scripts/research-core.mjs";
import { buildEffectiveTask, parseJsonLines, runResearchSession } from "../scripts/research-session.mjs";
import { assertSchemaValid } from "./json-schema-lite.mjs";

const example = JSON.parse(await readFile(new URL("../config/research-task.example.json", import.meta.url), "utf8"));
const resultSchema = JSON.parse(await readFile(new URL("../config/research-result.schema.json", import.meta.url), "utf8"));

function task(taskId, overrides = {}) {
  return {
    ...structuredClone(example),
    taskId,
    sources: ["search"],
    seedKeywords: ["seed-a", "seed-b", "seed-c", "seed-d", "seed-e"],
    budgets: { ...example.budgets, wallClockSeconds: 60, maxResultScrollsPerQuery: 0, maxNoteScrolls: 0, maxCommentPanels: 0 },
    ...overrides,
  };
}

async function outputRoot() {
  return mkdtemp(path.join(os.tmpdir(), "xhs-research-session-"));
}

test("effective query building prioritizes planner, suggestions, and trending evidence within strict limits", () => {
  const effective = buildEffectiveTask(task("session-query-order"), ["suggestion-a", "suggestion-b"], {
    rankedQueries: ["planned-a", "planned-b"],
    excludedTerms: ["seed-a"],
  }, ["trending-a"]);
  assert.deepEqual(effective.seedKeywords.slice(0, 4), ["planned-a", "planned-b", "suggestion-a", "suggestion-b"]);
  assert.equal(effective.seedKeywords.includes("trending-a"), true);
  assert.equal(effective.seedKeywords.includes("seed-a"), false);
  assert(effective.seedKeywords.length <= effective.budgets.maxQueries - 1);
});

test("fresh trending keywords are persisted and feed bounded query expansion", async () => {
  const root = await outputRoot();
  const input = task("session-trending-expansion", {
    sources: ["search", "trending"],
    seedKeywords: [],
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  const executed = [];
  const provider = createDryRunProvider({
    devices: ["device-01"],
    outcomeForUnit(context) { executed.push(context.unit); },
  });
  provider.collectTopicSuggestions = async () => ["suggestion-a"];
  provider.collectTrendingKeywords = async () => ["trending-a", "trending-b"];
  const result = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(result.status, "completed");
  const discovery = JSON.parse(await readFile(path.join(root, input.taskId, "topic-discovery.json"), "utf8"));
  assert.deepEqual(discovery.trendingKeywords, ["trending-a", "trending-b"]);
  const searchedKeywords = new Set(executed.filter((unit) => unit.source === "search").map((unit) => unit.keyword));
  assert.equal(searchedKeywords.has("trending-a"), true);
  assert.equal(searchedKeywords.has("trending-b"), true);
});

test("a zero-model deterministic session finalizes once and duplicates without provider work", async () => {
  const root = await outputRoot();
  const input = task("session-zero-model");
  const provider = createDryRunProvider({ devices: ["device-01", "device-02", "device-03"] });
  const first = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(first.status, "completed");
  assert.equal(first.counts.modelCalls, 0);
  assertSchemaValid(assert, resultSchema, first, "session result");
  const calls = provider.calls.length;
  const duplicate = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(provider.calls.length, calls);
});

test("a fresh 30-day topic cache avoids repeating suggestion discovery for a new taskId", async () => {
  const root = await outputRoot();
  let discoveryCalls = 0;
  const firstProvider = createDryRunProvider({ devices: ["device-01"] });
  firstProvider.collectTopicSuggestions = async () => {
    discoveryCalls += 1;
    return ["cached-platform-query"];
  };
  const basePolicy = { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false };
  await runResearchSession(task("session-topic-cache-a", { aiPolicy: basePolicy }), { provider: firstProvider, outputRoot: root });

  const secondProvider = createDryRunProvider({ devices: ["device-01"] });
  secondProvider.collectTopicSuggestions = async () => {
    discoveryCalls += 1;
    return ["must-not-run"];
  };
  const second = await runResearchSession(task("session-topic-cache-b", { aiPolicy: basePolicy }), { provider: secondProvider, outputRoot: root });
  assert.equal(second.status, "completed");
  assert.equal(discoveryCalls, 1);
});

test("topic planning and result analysis share the hard automatic-call budget", async () => {
  const root = await outputRoot();
  const input = task("session-ai-budget");
  const provider = createDryRunProvider({ devices: ["device-01"] });
  provider.collectTopicSuggestions = async () => ["platform-a", "platform-b"];
  const roles = [];
  const request = async ({ role, input: roleInput }) => {
    roles.push(role);
    if (role === "topic_planner") {
      return {
        intentClusters: [{ name: "intent", queries: ["planned-a"] }],
        rankedQueries: ["planned-a", "planned-b"],
        excludedTerms: [],
        rationale: "platform suggestions",
      };
    }
    if (role === "research_analysis") {
      const ids = roleInput.candidates.map((candidate) => candidate.candidateId);
      return {
        clusters: [{ name: "cluster", candidateIds: ids.slice(0, 2) }],
        rankedCandidates: ids.slice(0, 3).map((candidateId, index) => ({ candidateId, score: 1 - index * 0.1, reason: "relevant" })),
        contentGaps: [],
        summary: "summary",
      };
    }
    throw new Error(`unexpected role ${role}`);
  };
  const summary = await runResearchSession(input, {
    provider,
    outputRoot: root,
    ai: { model: "test-model", request },
  });
  assert.deepEqual(roles, ["topic_planner", "research_analysis"]);
  assert.equal(summary.counts.modelCalls, 2);
  assert.equal(summary.aiCallsUsed, 2);
  assert.equal(typeof summary.artifacts.analysis, "string");
  const reviews = parseJsonLines(await readFile(summary.artifacts.reviewQueue, "utf8"));
  assert.equal(reviews.filter((review) => review.aiReason).length, 3);
  assertSchemaValid(assert, resultSchema, summary, "AI session result");
});

test("structured input discovery carries only a deidentified audit into blocked units", async () => {
  const root = await outputRoot();
  const input = task("session-human-input", {
    sources: ["search", "suggestions", "trending"],
    seedKeywords: [],
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  const executed = [];
  const expectedAudit = {
    adapter: "xiaowei_api",
    apiIdentityVerified: true,
    bridgeSelectionVerified: false,
    focusedEditorVerified: true,
    clearVerified: false,
    apiAccepted: false,
    echoVerified: false,
    restoreAttempted: false,
    restoreVerified: false,
  };
  const provider = {
    async listDevices() { return [{ alias: "device-01", online: true }]; },
    async isDeviceOnline() { return true; },
    async collectTopicSuggestions() {
      return {
        status: "human_required",
        suggestions: [],
        failureSignature: "input:xiaowei_app_focus_app_focus_mismatch",
        humanReview: [{ reason: "focus check" }],
        inputMethodAudit: { ...expectedAudit, serial: "must-not-leak", imeService: "must-not-leak" },
      };
    },
    async executeWorkUnit({ unit }) {
      executed.push(unit.source);
      return { status: "skipped", candidates: [], humanReview: [], failureSignature: null };
    },
  };
  const summary = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(summary.status, "human_required");
  assert.deepEqual(executed, ["trending"]);
  assert.equal(summary.globalFuse, null);
  const discovery = JSON.parse(await readFile(path.join(root, input.taskId, "topic-discovery.json"), "utf8"));
  assert.deepEqual(discovery.inputBlockedDevices[0].inputMethodAudit, expectedAudit);
  const checkpoint = JSON.parse(await readFile(path.join(root, input.taskId, "checkpoint.json"), "utf8"));
  const blockedResults = Object.values(checkpoint.units)
    .map((entry) => entry.result)
    .filter((result) => result.failureSignature === "input:xiaowei_app_focus_app_focus_mismatch");
  assert.equal(blockedResults.length, 2);
  assert.deepEqual(blockedResults[0].inputMethodAudit, expectedAudit);
});

test("Unicode suggestion discovery tries the next device and only blocks incapable aliases", async () => {
  const root = await outputRoot();
  const input = task("session-per-device-input", {
    sources: ["search", "suggestions"],
    seedKeywords: [],
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  const discoveryAliases = [];
  const executed = [];
  const provider = {
    async listDevices() { return [{ alias: "device-01", online: true }, { alias: "device-02", online: true }]; },
    async isDeviceOnline() { return true; },
    async collectTopicSuggestions({ deviceAlias }) {
      discoveryAliases.push(deviceAlias);
      if (deviceAlias === "device-01") {
        return { status: "human_required", suggestions: [], failureSignature: "input:unicode_requires_human", humanReview: [{ reason: "manual paste on device-01" }] };
      }
      return ["approved-device-suggestion"];
    },
    async executeWorkUnit(context) {
      executed.push({ deviceAlias: context.deviceAlias, source: context.unit.source });
      return {
        status: "completed",
        candidates: [{ candidateId: context.unit.unitId, noteId: context.unit.unitId, title: context.unit.keyword, mediaType: "image" }],
        humanReview: [],
      };
    },
  };
  const summary = await runResearchSession(input, { provider, outputRoot: root });
  assert.deepEqual(discoveryAliases, ["device-01", "device-02"]);
  assert.equal(executed.some((entry) => entry.deviceAlias === "device-02" && ["search", "suggestions"].includes(entry.source)), true);
  assert.equal(executed.some((entry) => entry.deviceAlias === "device-01" && ["search", "suggestions"].includes(entry.source)), false);
  assert.equal(summary.globalFuse, null);
  const discovery = JSON.parse(await readFile(path.join(root, input.taskId, "topic-discovery.json"), "utf8"));
  assert.deepEqual(discovery.inputBlockedDevices.map((entry) => entry.deviceAlias), ["device-01"]);
});

test("a page-classification discovery failure is preserved once and never copied into input-blocked work", async () => {
  const root = await outputRoot();
  const input = task("session-page-unknown-isolation", {
    sources: ["search"],
    seedKeywords: [],
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  let executed = 0;
  const diagnostics = { hierarchyPath: "diagnostics/page.xml", screenshotPath: "diagnostics/page.png" };
  const provider = {
    async listDevices() { return [{ alias: "device-01", online: true }]; },
    async isDeviceOnline() { return true; },
    async collectTopicSuggestions() {
      return {
        status: "human_required",
        suggestions: [],
        failureSignature: "page:unknown",
        humanReview: [{ reason: "unclassified search page" }],
        diagnostics,
      };
    },
    async executeWorkUnit() {
      executed += 1;
      return { status: "completed", candidates: [], humanReview: [] };
    },
  };
  const summary = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(executed, 1, "the real provider work unit must run after a page discovery failure");
  assert.equal(summary.counts.completedUnits, 1);
  const discovery = JSON.parse(await readFile(path.join(root, input.taskId, "topic-discovery.json"), "utf8"));
  assert.deepEqual(discovery.inputBlockedDevices, []);
  assert.deepEqual(discovery.discoveryDeviceFailures, [{
    deviceAlias: "device-01",
    failureSignature: "page:unknown",
    humanReview: [{ reason: "unclassified search page" }],
    diagnostics,
  }]);
});

test("a sensitive discovery screen stops before probing a peer or executing work", async () => {
  const root = await outputRoot();
  const input = task("session-sensitive-discovery", {
    sources: ["search", "trending"],
    seedKeywords: [],
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  let discoveryCalls = 0;
  let providerWorkCalls = 0;
  const provider = {
    async listDevices() { return [{ alias: "device-01", online: true }, { alias: "device-02", online: true }]; },
    async isDeviceOnline() { return true; },
    async collectTopicSuggestions() {
      discoveryCalls += 1;
      return {
        status: "human_required",
        suggestions: [],
        failureSignature: "safety:permission-prompt",
        humanReview: [{ reason: "permission prompt" }],
        stopAll: true,
      };
    },
    async collectTrendingKeywords() { throw new Error("must not probe trending after a safety stop"); },
    async executeWorkUnit() { providerWorkCalls += 1; throw new Error("must not reach the device provider"); },
  };
  const summary = await runResearchSession(input, { provider, outputRoot: root });
  assert.equal(discoveryCalls, 1);
  assert.equal(providerWorkCalls, 0);
  assert.equal(summary.status, "human_required");
  assert.equal(summary.globalFuse.reason, "PROVIDER_STOP");
});

test("a cross-device failure fuse emits a maintenance-agent request without phone permissions", async () => {
  const root = await outputRoot();
  const provider = createDryRunProvider({
    devices: ["device-01", "device-02", "device-03"],
    outcomeForUnit() { return { status: "failed", candidates: [], humanReview: [], failureSignature: "selector:new-layout" }; },
  });
  const summary = await runResearchSession(task("session-maintenance-fuse", {
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  }), { provider, outputRoot: root });
  assert(summary.globalFuse);
  const request = JSON.parse(await readFile(summary.paths.maintenanceRequestJson, "utf8"));
  assert.equal(request.requestedRole, "maintenance_agent");
  assert.equal(request.permission, "suggest_rules_or_code_only");
  assertSchemaValid(assert, resultSchema, summary, "maintenance-fuse session result");

  const repeated = await runResearchSession(task("session-maintenance-fuse-repeat", {
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  }), { provider, outputRoot: root });
  assert(repeated.globalFuse);
  assert.equal(repeated.paths.maintenanceRequestJson, undefined);
});

test("a Xiaohongshu version change emits one maintenance request and keeps aliases opaque", async () => {
  const root = await outputRoot();
  const policy = { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false };
  const providerForVersion = (version) => {
    const provider = createDryRunProvider({ devices: ["device-01"] });
    provider.getDeviceProfiles = async () => [{
      alias: "device-01", online: true, xhsVersion: version, androidSdk: "33", resolution: "1080x2400", dpi: "420",
    }];
    return provider;
  };
  await runResearchSession(task("session-version-a", { aiPolicy: policy }), {
    provider: providerForVersion("1.0.0"), outputRoot: root,
  });
  const changed = await runResearchSession(task("session-version-b", { aiPolicy: policy }), {
    provider: providerForVersion("2.0.0"), outputRoot: root,
  });
  const request = JSON.parse(await readFile(changed.paths.maintenanceRequestJson, "utf8"));
  assert.equal(request.reason, "XHS_VERSION_CHANGED");
  assert.deepEqual(request.triggers[0].devices, [{ deviceAlias: "device-01", previousVersion: "1.0.0", currentVersion: "2.0.0" }]);
  assert.equal(JSON.stringify(request).includes("serial"), false);
});

test("a comment-panel reservation survives interruption before a work-unit checkpoint", async () => {
  const root = await outputRoot();
  const input = task("session-resource-resume", {
    seedKeywords: [],
    commentMode: "metadata",
    budgets: { ...example.budgets, wallClockSeconds: 60, maxQueries: 1, maxNotes: 1, maxResultScrollsPerQuery: 0, maxNoteScrolls: 0, maxCommentPanels: 1 },
    aiPolicy: { ...example.aiPolicy, topicPlanner: false, resultAnalysis: false },
  });
  await assert.rejects(runResearchSession(input, {
    outputRoot: root,
    providerFactory({ onResourceUsage }) {
      return {
        async listDevices() { return [{ alias: "device-01", online: true }]; },
        async isDeviceOnline() { return true; },
        async executeWorkUnit() {
          await onResourceUsage({ taskId: input.taskId, commentPanelsUsed: 1 });
          const error = new Error("interrupted after comment reservation");
          error.fatal = true;
          throw error;
        },
      };
    },
  }), /interrupted/);

  let restoredUsage = -1;
  const summary = await runResearchSession(input, {
    outputRoot: root,
    providerFactory({ resourceUsage }) {
      restoredUsage = resourceUsage.commentPanelsUsed;
      return createDryRunProvider({ devices: ["device-01"] });
    },
  });
  assert.equal(summary.status, "completed");
  assert.equal(restoredUsage, 1);
});
