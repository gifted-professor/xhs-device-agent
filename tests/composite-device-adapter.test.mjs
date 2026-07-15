import assert from "node:assert/strict";
import test from "node:test";

import {
  CompositeDeviceAdapter,
  observeCommentCountCascade,
} from "../scripts/composite-device-adapter.mjs";

function node(resourceId, { text = "", contentDesc = "", scrollable = false, clickable = false, bounds = "[0,0][100,100]" } = {}) {
  return { resourceId, text, contentDesc, scrollable, clickable, enabled: true, attributes: { bounds } };
}

function snapshot(state, nodes, fingerprint = state.toLowerCase()) {
  const normalizedNodes = nodes.map((entry, nodeIndex) => ({ children: [], parentIndex: null, nodeIndex, path: `/${nodeIndex}`, className: "android.view.View", ...entry }));
  return {
    classification: { state, safety: { sensitive: false } },
    document: { nodes: normalizedNodes, roots: normalizedNodes.map((entry) => entry.nodeIndex) },
    fingerprint,
    foregroundPackage: "com.xingin.xhs",
    path: `evidence/${fingerprint}.xml`,
  };
}

const detailNodes = [
  node("note_title", { text: "Bound public note" }),
  node("note_author", { text: "Public author" }),
  node("comment_entry", { text: "评论", clickable: true, bounds: "[10,800][100,900]" }),
];

const cpaExecution = Object.freeze({
  execution: Object.freeze({ planHash: "a".repeat(64), attemptId: "attempt-0123456789abcdef", stepId: "m01.s001" }),
  runtime: Object.freeze({ cpaWorkflowSoftTimeoutMs: 15_000 }),
});

test("comment count cascade stops at UI, then local OCR, then CPA", async () => {
  const calls = { local: 0, cpa: 0, artifact: 0 };
  const dependencies = {
    localNumericOcr: async () => { calls.local += 1; return { count: 8, countKind: "exact", confidence: 1 }; },
    createCommentCountArtifact: async () => { calls.artifact += 1; return { cleanup: async () => {} }; },
    analyzeCpa: async () => { calls.cpa += 1; return { status: "ok", result: { count: 9, countKind: "exact", confidence: 1 } }; },
    assertFastGate: () => {},
    ...cpaExecution,
  };

  const ui = await observeCommentCountCascade({
    snapshot: snapshot("IMAGE_NOTE", [...detailNodes, node("comment_count", { text: "7" })]),
    dependencies,
  });
  assert.equal(ui.source, "ui");
  assert.equal(ui.observation.count, 7);
  assert.deepEqual(calls, { local: 0, cpa: 0, artifact: 0 });

  const local = await observeCommentCountCascade({
    snapshot: snapshot("IMAGE_NOTE", detailNodes), dependencies,
  });
  assert.equal(local.source, "local_ocr");
  assert.equal(local.observation.count, 8);
  assert.deepEqual(calls, { local: 1, cpa: 0, artifact: 0 });

  dependencies.localNumericOcr = async () => { calls.local += 1; return null; };
  const cpa = await observeCommentCountCascade({
    snapshot: snapshot("IMAGE_NOTE", detailNodes), dependencies,
  });
  assert.equal(cpa.source, "cpa");
  assert.equal(cpa.observation.count, 9);
  assert.deepEqual(calls, { local: 2, cpa: 1, artifact: 1 });
});

test("CPA degradation freezes unknown at 1/5 and the initial live cap stays 3/20", async () => {
  const unknown = await observeCommentCountCascade({
    snapshot: snapshot("VIDEO_NOTE", detailNodes),
    dependencies: {
      localNumericOcr: async () => null,
      createCommentCountArtifact: async () => ({ cleanup: async () => {} }),
      analyzeCpa: async () => ({ status: "unknown", result: { count: null, countKind: "unknown", confidence: 0 } }),
      assertFastGate: () => {},
      ...cpaExecution,
    },
  });
  assert.equal(unknown.source, "unknown");
  assert.deepEqual(unknown.budget.liveBudget, { maxScrolls: 1, maxItems: 5 });

  const high = await observeCommentCountCascade({
    snapshot: snapshot("VIDEO_NOTE", [...detailNodes, node("comment_count", { text: "100+" })]),
    dependencies: { assertFastGate: () => {} },
  });
  assert.deepEqual(high.budget.finalTarget, { maxScrolls: 8, maxItems: 50 });
  assert.deepEqual(high.budget.liveBudget, { maxScrolls: 3, maxItems: 20 });
  assert.strictEqual(high.budget, high.applyLaterObservation({ count: 2, countKind: "exact", confidence: 1 }));
});

test("comments open, collect, and close stay target-bound and scroll only the comment container", async () => {
  const detail = snapshot("IMAGE_NOTE", detailNodes, "detail-a");
  const firstPanel = snapshot("COMMENT_PANEL", [
    node("comment_title", { text: "12 comments" }),
    node("comments_container", { scrollable: true, bounds: "[20,200][980,1800]" }),
    node("comment_content_1", { text: "Alice useful tip" }),
    node("comment_input", { text: "Say something", clickable: true }),
  ], "panel-1");
  const secondPanel = snapshot("COMMENT_PANEL", [
    node("comments_container", { scrollable: true, bounds: "[30,210][970,1790]" }),
    node("comment_content_1", { text: " alice   USEFUL tip " }),
    node("comment_content_2", { text: "Contact 13800138000 for more" }),
  ], "panel-2");
  const thirdPanel = snapshot("COMMENT_PANEL", [
    node("comments_container", { scrollable: true, bounds: "[40,220][960,1780]" }),
    node("comment_content_1", { text: "Alice useful tip" }),
  ], "panel-3");
  const fourthPanel = snapshot("COMMENT_PANEL", [
    node("comments_container", { scrollable: true, bounds: "[50,230][950,1770]" }),
    node("comment_content_1", { text: "Alice useful tip" }),
  ], "panel-4");
  const queue = [detail, firstPanel, secondPanel, thirdPanel, fourthPanel, detail];
  const calls = [];
  const feedAdapter = {
    stableUi: async (stage) => { calls.push(["stableUi", stage]); return queue.shift(); },
    assertOperable: (value, expected) => {
      assert.equal(value.classification.safety.sensitive, false);
      if (expected) assert.equal(expected.has(value.classification.state), true);
    },
    tapNode: (target) => calls.push(["tap", target.resourceId]),
    adb: (args, options) => calls.push(["adb", args, options]),
  };
  let fused = false;
  const adapter = new CompositeDeviceAdapter({
    feedAdapter,
    rules: { semanticTargets: {
      comments_entry: [{ strategy: "resource-id", match: "includes", values: ["comment_entry"] }],
      comments_container: [{ strategy: "resource-id", match: "includes", values: ["comments_container"] }],
    } },
    runtimeProfile: { uiSnapshotReuseMs: 1000 },
    assertFastGate: () => { if (fused) throw new Error("FUSE_OPEN"); },
  });

  const binding = await adapter.bindCurrentDetail("bind");
  const opened = await adapter.openComments(binding);
  assert.equal(opened.status, "verified");
  assert.equal(opened.targetHash, binding.targetHash);
  const budget = Object.freeze({
    frozen: true,
    liveBudget: Object.freeze({ maxScrolls: 5, maxItems: 20 }),
    maxNoNewScrolls: 2,
  });
  const collected = await adapter.collectComments(binding, budget);
  assert.equal(collected.stopReason, "two_no_new_scrolls");
  assert.equal(collected.scrolls, 3);
  assert.equal(new Set(collected.hashes).size, collected.hashes.length);
  assert.equal(collected.snippets.some((value) => value.includes("13800138000")), false);
  const closed = await adapter.closeComments(binding);
  assert.equal(closed.status, "verified");
  assert.equal(closed.targetHash, binding.targetHash);

  assert.equal(calls.filter(([kind]) => kind === "tap").length, 1);
  const gestures = calls.filter(([kind, args]) => kind === "adb" && args?.[2] === "swipe");
  assert.equal(gestures.length, 3);
  assert.equal(calls.some((entry) => JSON.stringify(entry).match(/inputText|sendComment|message|follow|profile|publish|delete/iu)), false);

  fused = true;
  await assert.rejects(() => adapter.openComments(binding), /FUSE_OPEN/);
  assert.equal(calls.filter(([kind]) => kind === "tap").length, 1);
});

test("fuse prevents a new CPA request before artifact creation", async () => {
  let artifacts = 0;
  let cpa = 0;
  await assert.rejects(() => observeCommentCountCascade({
    snapshot: snapshot("IMAGE_NOTE", detailNodes),
    dependencies: {
      localNumericOcr: async () => null,
      assertFastGate: () => { throw new Error("FUSE_OPEN"); },
      createCommentCountArtifact: async () => { artifacts += 1; return {}; },
      analyzeCpa: async () => { cpa += 1; return {}; },
      ...cpaExecution,
    },
  }), /FUSE_OPEN/);
  assert.equal(artifacts, 0);
  assert.equal(cpa, 0);
});

test("CPA fallback carries the immutable execution binding and workflow timeout", async () => {
  let request = null;
  await observeCommentCountCascade({
    snapshot: snapshot("IMAGE_NOTE", detailNodes),
    dependencies: {
      localNumericOcr: async () => null,
      assertFastGate: () => {},
      createCommentCountArtifact: async () => ({ artifactId: "test-artifact" }),
      analyzeCpa: async (input) => {
        request = input;
        return { status: "unknown", result: { count: null, countKind: "unknown", confidence: 0 } };
      },
      ...cpaExecution,
    },
  });
  assert.equal(request.role, "comment_count");
  assert.deepEqual(request.execution, cpaExecution.execution);
  assert.deepEqual(request.runtime, cpaExecution.runtime);
  assert.equal(typeof request.gate.assertFastGate, "function");
  assert.equal(Object.hasOwn(request, "snapshot"), false);
});
