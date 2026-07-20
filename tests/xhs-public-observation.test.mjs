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
      <node bounds="[100,200][500,1000]" content-desc="笔记 ${title} 来自公开作者 ${likes}赞" />
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
    ordinal: 1,
  }]);
  assert.deepEqual(observation.visibleLabels, ["公开话题"]);
  assert.doesNotMatch(JSON.stringify(observation), /消息|未读|serial|alias|coordinate/iu);
});

test("XHS public observation does not merge a standalone like label into the author identity", () => {
  const observation = observeXhsHierarchy(hierarchy({ likes: "" }), RULES);
  assert.deepEqual(observation.notes, [{
    title: "公开笔记标题",
    author: "公开作者",
    mediaType: "image",
    metrics: { likes: null },
    ordinal: 1,
  }]);
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
  assert.equal(stable.notes[0].ordinal, 1);
  assert.throws(
    () => intersectXhsObservations(first, { ...second, page: { ...second.page, state: "IMAGE_NOTE" } }),
    /not stable/u,
  );
});

test("visible XHS notes resolve by one-based ordinal without exposing coordinates", () => {
  const resolved = resolveVisibleXhsNote(
    hierarchy(),
    1,
    { width: 1080, height: 2400 },
  );
  assert.equal(resolved.note.title, "公开笔记标题");
  assert.equal(resolved.note.ordinal, 1);
  assert.deepEqual(resolved.point, { x: "27.777778", y: "25" });
  assert.throws(() => resolveVisibleXhsNote(
    hierarchy().replace(' bounds="[100,200][500,1000]"', ""), 1, { width: 1080, height: 2400 },
  ), /not present/u);
  assert.throws(() => resolveVisibleXhsNote(hierarchy(), 0, { width: 1080, height: 2400 }), /ordinal/u);
});

test("stable XHS note ordinals always come from the second fresh hierarchy", () => {
  const twoCards = (reversed) => `<hierarchy><node package="com.xingin.xhs" resource-id="home_feed">
    ${reversed
      ? '<node bounds="[100,200][500,700]" content-desc="视频 第二条 来自作者乙 2赞" /><node bounds="[100,800][500,1300]" content-desc="笔记 第一条 来自作者甲 1赞" />'
      : '<node bounds="[100,200][500,700]" content-desc="笔记 第一条 来自作者甲 1赞" /><node bounds="[100,800][500,1300]" content-desc="视频 第二条 来自作者乙 2赞" />'}
  </node></hierarchy>`;
  const first = observeXhsHierarchy(twoCards(false), RULES);
  const second = observeXhsHierarchy(twoCards(true), RULES);
  const stable = intersectXhsObservations(first, second);
  assert.deepEqual(stable.notes.map(({ title, ordinal }) => ({ title, ordinal })), [
    { title: "第一条", ordinal: 2 },
    { title: "第二条", ordinal: 1 },
  ]);
});

test("comment panel with minute-based reply metadata and a translate chip classifies as COMMENT_PANEL", async () => {
  const { loadRules } = await import("../scripts/xhs-page-engine.mjs");
  const { fileURLToPath } = await import("node:url");
  const rules = await loadRules(fileURLToPath(new URL("../config/xhs-page-rules.json", import.meta.url)));
  const hierarchy = `<hierarchy><node package="com.xingin.xhs" bounds="[0,0][1080,2400]">
    <node package="com.xingin.xhs" text="共 1 条评论" clickable="true" bounds="[41,267][228,324]" />
    <node package="com.xingin.xhs" text="留下你的想法吧" bounds="[222,395][488,451]" />
    <node package="com.xingin.xhs" text="7分钟前 中国台湾 回复 翻译" bounds="[168,769][810,824]" />
  </hierarchy>`;
  const observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: "device-public" });
  assert.equal(observation.page.state, "COMMENT_PANEL");
});
