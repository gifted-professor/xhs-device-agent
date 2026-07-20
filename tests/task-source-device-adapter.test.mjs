import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskSourceDeviceAdapter,
  unsupportedLiveUrl,
} from "../scripts/task-source-device-adapter.mjs";

function detailSnapshot(noteId) {
  return {
    classification: { state: "IMAGE_NOTE", safety: { sensitive: false } },
    document: { nodes: [{ text: "", contentDesc: `noteId=${noteId}`, resourceId: "", attributes: {} }] },
  };
}

test("search source delegates exact compiled query and ordered result ordinals", async () => {
  const calls = [];
  const session = {
    inputMethodAudit: { adapter: "xiaowei_api", echoVerified: true },
    async openNextResult(input) { calls.push(["result", input]); return { status: "verified", ...input }; },
    async returnToResults() { calls.push(["return"]); return { status: "verified", pageState: "SEARCH_RESULTS" }; },
  };
  const adapter = new TaskSourceDeviceAdapter({
    feedAdapter: { stableUiWhileTransitioning() {} },
    searchProvider: {
      async createUnifiedSearchSession(input) { calls.push(["open", input]); return session; },
    },
    taskSource: { type: "search_results", queryRef: "query-001", query: "通勤", count: 2 },
    taskId: "source-search-001",
    deviceAlias: "device-02",
    assertFastGate: (input) => calls.push(["gate", input.action]),
  });
  const opened = await adapter.openSearchResults({ queryRef: "query-001" });
  assert.equal(opened.pageState, "SEARCH_RESULTS");
  assert.equal(opened.inputMethodAudit.echoVerified, true);
  await adapter.openSearchResult({ resultOrdinal: 1, maxScrolls: 3 });
  await adapter.returnToSearchResults();
  assert.deepEqual(calls.filter(([kind]) => kind === "result"), [["result", { resultOrdinal: 1, maxScrolls: 3 }]]);
  assert.deepEqual(calls.find(([kind]) => kind === "open")[1], {
    taskId: "source-search-001", query: "通勤", count: 2, deviceAlias: "device-02",
  });
});

test("direct URL source verifies the approved note identity after one bounded app open", async () => {
  const noteId = "64abcde01234567890fedcba";
  const adbCalls = [];
  const feedAdapter = {
    adb(args) {
      adbCalls.push(args);
      return args.includes("dumpsys") ? `Intent { dat=https://www.xiaohongshu.com/explore/${noteId} }` : "Starting";
    },
    async stableUiWhileTransitioning() { return { sample: detailSnapshot(noteId) }; },
    assertOperable(snapshot, expected) { assert.equal(expected.has(snapshot.classification.state), true); },
  };
  const adapter = new TaskSourceDeviceAdapter({
    feedAdapter,
    taskSource: { type: "url_list", urls: [{ urlRef: "url-001", url: `https://www.xiaohongshu.com/explore/${noteId}` }] },
    taskId: "source-url-001",
    deviceAlias: "device-02",
    assertFastGate() {},
  });
  const result = await adapter.openXhsUrl({ urlRef: "url-001" });
  assert.equal(result.status, "verified");
  assert.equal(result.verifiedBy, "activity_intent");
  assert.equal(adbCalls.filter((args) => args.includes("android.intent.action.VIEW")).length, 1);
});

test("short URLs are rejected before live execution because target identity cannot be prebound", () => {
  assert.deepEqual(unsupportedLiveUrl({
    type: "url_list",
    urls: [{ urlRef: "url-001", url: "https://xhslink.com/abc123" }],
  }), { urlRef: "url-001", url: "https://xhslink.com/abc123" });
});

test("research source executes only the exact compiled machine shard", async () => {
  const task = { taskId: "research-worker-02", budgets: { maxNotes: 3 } };
  const calls = [];
  const adapter = new TaskSourceDeviceAdapter({
    feedAdapter: { stableUiWhileTransitioning() {} },
    taskSource: {
      type: "research_read_only",
      assignments: [{ machine: "02", task }],
    },
    taskId: task.taskId,
    deviceAlias: "device-02",
    machine: "02",
    assertFastGate: (input) => calls.push(["gate", input.action]),
    researchRunner: async (input) => {
      calls.push(["run", input]);
      return { status: "completed", counts: { candidates: 3 } };
    },
  });
  const result = await adapter.collectResearch({ policyRef: "research-read-only-v1" });
  assert.equal(result.status, "verified");
  assert.equal(result.researchStatus, "completed");
  assert.deepEqual(result.counts, { candidates: 3 });
  assert.deepEqual(calls.find(([kind]) => kind === "run")[1], task);
  assert.notEqual(calls.find(([kind]) => kind === "run")[1], task);
});
