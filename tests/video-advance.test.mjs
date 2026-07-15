import assert from "node:assert/strict";
import test from "node:test";

import { CompositeDeviceAdapter } from "../scripts/composite-device-adapter.mjs";
import { resolveSemanticNode } from "../scripts/xhs-page-engine.mjs";

function snapshot(state, fingerprint, specs, sensitive = false) {
  const nodes = specs.map((entry, nodeIndex) => ({
    children: [], parentIndex: null, nodeIndex, className: entry.className ?? "android.view.View",
    packageName: "com.xingin.xhs",
    resourceId: entry.resourceId ?? "", text: entry.text ?? "", contentDesc: entry.contentDesc ?? "",
    clickable: entry.clickable ?? false, enabled: true, scrollable: entry.scrollable ?? false,
    attributes: { bounds: entry.bounds ?? "[0,0][100,100]" },
  }));
  return {
    classification: { state, safety: { sensitive } }, document: { nodes, roots: nodes.map((entry) => entry.nodeIndex) },
    fingerprint, foregroundPackage: "com.xingin.xhs", path: `evidence/${fingerprint}.xml`,
  };
}

const rules = { semanticTargets: {
  note_content_container: [{ strategy: "resource-id", match: "includes", values: ["note_content_container"] }],
  video_player_surface: [{ strategy: "resource-id", match: "includes", values: ["video_player_surface"] }],
} };

function createAdapter(queue, { onFuse = () => {} } = {}) {
  const calls = [];
  const feedAdapter = {
    stableUi: async () => queue.shift(),
    assertOperable: (value, expected) => {
      if (value.classification.safety.sensitive) return;
      if (expected) assert.equal(expected.has(value.classification.state), true);
    },
    adb: (args, options) => calls.push({ args, options }),
  };
  const adapter = new CompositeDeviceAdapter({
    feedAdapter, rules, runtimeProfile: { uiSnapshotReuseMs: 1000 }, assertFastGate: () => {}, tripFuse: onFuse,
  });
  return { adapter, calls };
}

test("semantic gesture nodes retain only current-snapshot bounds for runtime use", () => {
  const first = snapshot("VIDEO_NOTE", "video-a", [{ resourceId: "video_player_surface", bounds: "[0,100][1000,1900]" }]);
  const second = snapshot("VIDEO_NOTE", "video-b", [{ resourceId: "video_player_surface", bounds: "[100,300][700,1200]" }]);
  assert.equal(resolveSemanticNode(first.document, rules, "video_player_surface").node.attributes.bounds, "[0,100][1000,1900]");
  assert.equal(resolveSemanticNode(second.document, rules, "video_player_surface").node.attributes.bounds, "[100,300][700,1200]");
});

test("image scroll uses only the note container and preserves the target identity", async () => {
  const before = snapshot("IMAGE_NOTE", "image-a", [
    { resourceId: "note_title", text: "Image A" },
    { resourceId: "note_content_container", scrollable: true, bounds: "[20,200][980,1600]" },
  ]);
  const after = structuredClone(before);
  const { adapter, calls } = createAdapter([before, after]);
  const binding = await adapter.bindCurrentDetail("image-bind");
  const result = await adapter.scrollImageContent(binding);
  assert.equal(result.status, "verified");
  assert.equal(result.targetHash, binding.targetHash);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[2], "swipe");
  assert.equal(JSON.stringify(result).includes("coordinate"), false);
  assert.equal(JSON.stringify(result).includes("bounds"), false);
});

test("video advance sends exactly once and requires a different verified video identity", async () => {
  const before = snapshot("VIDEO_NOTE", "video-a", [
    { resourceId: "note_title", text: "Video A" },
    { resourceId: "video_player_surface", bounds: "[0,100][1000,1900]" },
  ]);
  const after = snapshot("VIDEO_NOTE", "video-b", [
    { resourceId: "note_title", text: "Video B" },
    { resourceId: "video_player_surface", bounds: "[100,300][700,1200]" },
  ]);
  const { adapter, calls } = createAdapter([before, after]);
  const binding = await adapter.bindCurrentDetail("video-bind");
  const result = await adapter.advanceVideo(binding);
  assert.equal(result.status, "verified");
  assert.notEqual(result.targetHash, binding.targetHash);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["shell", "input", "swipe"]);
});

test("unchanged or unknown video identity stops without a retry", async () => {
  const before = snapshot("VIDEO_NOTE", "video-a", [
    { resourceId: "note_title", text: "Video A" },
    { resourceId: "video_player_surface", bounds: "[0,100][1000,1900]" },
  ]);
  for (const after of [structuredClone(before), snapshot("UNKNOWN", "unknown", [])]) {
    const { adapter, calls } = createAdapter([structuredClone(before), after]);
    const binding = await adapter.bindCurrentDetail("video-bind");
    const result = await adapter.advanceVideo(binding);
    assert.equal(result.status, "ambiguous");
    assert.equal(calls.length, 1);
  }
});

test("comment panel blocks video advance and a sensitive post-state opens the fuse", async () => {
  const panel = snapshot("COMMENT_PANEL", "panel", [{ resourceId: "comments_container", scrollable: true }]);
  const blocked = createAdapter([panel]);
  blocked.adapter.currentBinding = { targetHash: "a".repeat(64) };
  await assert.rejects(() => blocked.adapter.advanceVideo(blocked.adapter.currentBinding), /VIDEO_NOTE/);
  assert.equal(blocked.calls.length, 0);

  const before = snapshot("VIDEO_NOTE", "video-a", [
    { resourceId: "note_title", text: "Video A" },
    { resourceId: "video_player_surface", bounds: "[0,100][1000,1900]" },
  ]);
  const sensitive = snapshot("LOGIN_OR_CHALLENGE", "login", [], true);
  const fuses = [];
  const active = createAdapter([before, sensitive], { onFuse: (reason) => fuses.push(reason) });
  const binding = await active.adapter.bindCurrentDetail("video-bind");
  await assert.rejects(() => active.adapter.advanceVideo(binding), /SENSITIVE_PAGE/);
  assert.deepEqual(fuses, ["SENSITIVE_PAGE"]);
  assert.equal(active.calls.length, 1);
});
