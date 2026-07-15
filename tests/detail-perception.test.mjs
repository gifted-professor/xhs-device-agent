import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceCommentCollection,
  applyCountUpdateToFrozenBudget,
  collectCommentSnippets,
  deidentifyCommentSnippet,
  extractDetailMetadata,
  findCommentContainer,
  findNoteContentContainer,
  freezeCommentBudget,
  normalizedCommentHash,
  parseCommentCount,
  resolveCommentCount,
} from "../scripts/detail-perception.mjs";

test("comment counts normalize exact, lower-bound, estimate, and unknown values", () => {
  const cases = [
    ["0", { count: 0, countKind: "exact" }],
    ["5", { count: 5, countKind: "exact" }],
    ["99+", { count: 99, countKind: "lower_bound" }],
    ["1.2\u4e07", { count: 12000, countKind: "estimate" }],
    ["3k", { count: 3000, countKind: "estimate" }],
    ["unknown", { count: null, countKind: "unknown" }],
  ];
  for (const [raw, expected] of cases) {
    assert.deepEqual(parseCommentCount(raw), { ...expected, confidence: expected.countKind === "unknown" ? 0 : 1 });
  }
});

test("invalid, negative, overflow, NaN, low-confidence, and exact conflicts become unknown", () => {
  for (const value of ["-1", Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "12 comments later", ""]) {
    assert.deepEqual(parseCommentCount(value), { count: null, countKind: "unknown", confidence: 0 });
  }
  assert.deepEqual(parseCommentCount("5", { confidence: 0.79 }), { count: null, countKind: "unknown", confidence: 0 });
  assert.deepEqual(resolveCommentCount([
    { value: "5", confidence: 0.99 },
    { value: "6", confidence: 0.98 },
  ]), { count: null, countKind: "unknown", confidence: 0, conflict: "exact_value_conflict" });
});

test("count policy preserves every boundary and freezes the initial 3/20 live cap", () => {
  const cases = [
    [0, "ZERO", 0, 0, 0, 0],
    [1, "ONE_TO_FIVE", 1, 5, 1, 5],
    [5, "ONE_TO_FIVE", 1, 5, 1, 5],
    [6, "SIX_TO_TWENTY", 3, 20, 3, 20],
    [20, "SIX_TO_TWENTY", 3, 20, 3, 20],
    [21, "TWENTY_ONE_TO_NINETY_NINE", 5, 30, 3, 20],
    [99, "TWENTY_ONE_TO_NINETY_NINE", 5, 30, 3, 20],
    [100, "ONE_HUNDRED_PLUS", 8, 50, 3, 20],
  ];
  for (const [count, band, targetScrolls, targetItems, liveScrolls, liveItems] of cases) {
    const budget = freezeCommentBudget({ count, countKind: "exact", confidence: 1 });
    assert.equal(budget.band, band);
    assert.deepEqual(budget.finalTarget, { maxScrolls: targetScrolls, maxItems: targetItems });
    assert.deepEqual(budget.liveBudget, { maxScrolls: liveScrolls, maxItems: liveItems });
    assert.equal(Object.isFrozen(budget), true);
    assert.equal(Object.isFrozen(budget.liveBudget), true);
  }
  const unknown = freezeCommentBudget({ count: null, countKind: "unknown", confidence: 0 });
  assert.equal(unknown.band, "UNKNOWN");
  assert.deepEqual(unknown.liveBudget, { maxScrolls: 1, maxItems: 5 });
  assert.strictEqual(applyCountUpdateToFrozenBudget(unknown, { count: 1000, countKind: "exact", confidence: 1 }), unknown);
});

test("collection stops on an end marker, item budget, or two consecutive no-new scrolls", () => {
  const budget = freezeCommentBudget({ count: 20, countKind: "exact", confidence: 1 });
  let state = advanceCommentCollection(null, { hashes: ["a"], budget });
  assert.equal(state.stop, false);
  state = advanceCommentCollection(state, { hashes: ["a"], budget, scrolled: true });
  assert.equal(state.noNewScrolls, 1);
  state = advanceCommentCollection(state, { hashes: ["a"], budget, scrolled: true });
  assert.equal(state.stop, true);
  assert.equal(state.stopReason, "two_no_new_scrolls");

  const ended = advanceCommentCollection(null, { hashes: [], budget, endMarker: true });
  assert.equal(ended.stopReason, "end_marker");
  const capped = advanceCommentCollection(null, {
    hashes: Array.from({ length: 20 }, (_, index) => `h${index}`), budget,
  });
  assert.equal(capped.stopReason, "item_budget");
});

test("public comment snippets redact identity and contact data before normalized hash dedupe", () => {
  const text = "Alice @alice call 13800138000 mail a@example.com https://example.test wx: wx_abc123 \u5fae\u4fe1 id998877 QQ 123456 contact c7788 account 445566";
  const redacted = deidentifyCommentSnippet(text, { authorNames: ["Alice"], uiAccountIds: ["445566"] });
  for (const secret of ["Alice", "@alice", "13800138000", "a@example.com", "https://example.test", "wx_abc123", "id998877", "123456", "c7788", "445566"]) {
    assert.equal(redacted?.includes(secret), false, secret);
  }
  assert.equal(deidentifyCommentSnippet("\u5fae\u4fe1: wx_only_123456"), null);
  assert.equal(deidentifyCommentSnippet("QQ 123456"), null);

  const firstHash = normalizedCommentHash(" Great\u3000tip ");
  assert.equal(firstHash, normalizedCommentHash("great tip"));
  const seenHashes = new Set();
  const first = collectCommentSnippets({
    nodes: [{ resourceId: "comment_text_1", text: "Great tip" }], maximum: 10, seenHashes,
  });
  const second = collectCommentSnippets({
    nodes: [{ resourceId: "comment_text_2", text: " great   TIP " }], maximum: 10, seenHashes,
  });
  assert.deepEqual(first, ["Great tip"]);
  assert.deepEqual(second, []);
});

test("detail metadata and semantic note/comment containers are extracted without coordinates in output", () => {
  const snapshot = {
    classification: { state: "IMAGE_NOTE" },
    document: { nodes: [
      { resourceId: "note_title", text: "A title", contentDesc: "", scrollable: false, attributes: { bounds: "[0,0][10,10]" } },
      { resourceId: "note_author", text: "Alice", contentDesc: "", scrollable: false, attributes: { bounds: "[0,0][10,10]" } },
      { resourceId: "comment_count", text: "99+", contentDesc: "", scrollable: false, attributes: { bounds: "[0,0][10,10]" } },
      { resourceId: "note_content_scroll", text: "", contentDesc: "", scrollable: true, attributes: { bounds: "[0,100][100,900]" } },
      { resourceId: "comment_list", text: "", contentDesc: "", scrollable: true, attributes: { bounds: "[0,300][100,1000]" } },
      { resourceId: "comment_input", text: "", contentDesc: "", scrollable: true, attributes: { bounds: "[0,900][100,1000]" } },
    ] },
  };
  assert.deepEqual(extractDetailMetadata(snapshot), { title: "A title", author: "Alice", count: "99+" });
  assert.equal(findNoteContentContainer(snapshot).node.resourceId, "note_content_scroll");
  assert.equal(findCommentContainer(snapshot).node.resourceId, "comment_list");
});

test("real-detail-shaped accessibility text binds the count to the comment button", () => {
  const snapshot = {
    classification: { state: "IMAGE_NOTE" },
    document: { nodes: [
      { resourceId: "com.xingin.xhs:id/0_resource_name_obfuscated", text: "42", contentDesc: "收藏 42" },
      { resourceId: "com.xingin.xhs:id/0_resource_name_obfuscated", text: "", contentDesc: "评论框" },
      { resourceId: "com.xingin.xhs:id/0_resource_name_obfuscated", text: "", contentDesc: "评论 42" },
      { resourceId: "com.xingin.xhs:id/0_resource_name_obfuscated", text: "42", contentDesc: "" },
    ] },
  };
  assert.equal(extractDetailMetadata(snapshot).count, "42");
});
