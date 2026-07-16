import assert from "node:assert/strict";
import test from "node:test";

import {
  intersectXhsObservations,
  observeXhsHierarchy,
  resolveVisibleXhsNote,
} from "../scripts/xhs-public-observation.mjs";

const RULES = {
  thresholds: { minimumScore: 0.85, minimumMargin: 0.15 },
  states: [{
    state: "HOME_FEED",
    evidence: [{
      id: "home-feed",
      weight: 1,
      any: [{ attribute: "resourceId", match: "includes", values: ["home_feed"] }],
    }],
  }],
  safety: { patterns: [], humanRequiredStates: [], blockCloudStates: [] },
};

function hierarchy({ title = "公开笔记标题", likes = "12", includePrivate = true } = {}) {
  return `<hierarchy rotation="0">
    <node package="com.xingin.xhs" resource-id="com.xingin.xhs:id/home_feed" scrollable="true">
      <node content-desc="笔记 ${title} 来自公开作者 ${likes}赞" />
      <node text="公开话题" />
      ${includePrivate ? '<node content-desc="消息,1条未读" />' : ""}
    </node>
  </hierarchy>`;
}

test("XHS public observation returns bounded public cards and excludes private chrome", () => {
  const observation = observeXhsHierarchy(hierarchy(), RULES);
  assert.deepEqual(observation.notes, [{
    title: "公开笔记标题",
    author: "公开作者",
    mediaType: "image",
    metrics: { likes: "12" },
  }]);
  assert.deepEqual(observation.visibleLabels, ["公开话题"]);
  assert.doesNotMatch(JSON.stringify(observation), /消息|未读|serial|alias|coordinate/iu);
});

test("XHS public observation requires the exact app, a classified page, and two stable reads", () => {
  assert.throws(
    () => observeXhsHierarchy(hierarchy().replaceAll("com.xingin.xhs", "com.example.other"), RULES),
    /foreground/u,
  );
  const first = observeXhsHierarchy(hierarchy(), RULES);
  const second = observeXhsHierarchy(hierarchy({ likes: "13" }), RULES);
  const stable = intersectXhsObservations(first, second);
  assert.equal(stable.stability, "two_fresh_ui_intersection");
  assert.equal(stable.notes[0].metrics.likes, null);
  assert.throws(
    () => intersectXhsObservations(first, { ...second, page: { ...second.page, state: "IMAGE_NOTE" } }),
    /not stable/u,
  );
});

test("visible XHS notes resolve by one-based ordinal without exposing coordinates", () => {
  const resolved = resolveVisibleXhsNote(
    hierarchy().replace('<node content-desc="笔记 ', '<node bounds="[100,200][500,1000]" content-desc="笔记 '),
    1,
    { width: 1080, height: 2400 },
  );
  assert.equal(resolved.note.title, "公开笔记标题");
  assert.deepEqual(resolved.point, { x: "27.777778", y: "25" });
  assert.throws(() => resolveVisibleXhsNote(hierarchy(), 1, { width: 1080, height: 2400 }), /not present/u);
  assert.throws(() => resolveVisibleXhsNote(hierarchy(), 0, { width: 1080, height: 2400 }), /ordinal/u);
});
