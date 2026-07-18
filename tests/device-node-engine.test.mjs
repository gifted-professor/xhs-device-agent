import assert from "node:assert/strict";
import test from "node:test";

import {
  inferHorizontalOrdinalBounds,
  parseVisionNodeResponse,
  publicNodeDescription,
  stableNodeBounds,
  validateDeviceNodeSelector,
} from "../scripts/device-node-engine.mjs";

const relationSelector = {
  label: "我",
  role: "tab",
  sources: ["accessibility", "ocr", "relation"],
  relation: {
    algorithm: "horizontal_equal_spacing",
    region: "bottom_navigation",
    anchors: [
      { label: "通讯录", ordinal: 2 },
      { label: "发现", ordinal: 3 },
    ],
    targetOrdinal: 4,
  },
};

test("node selector accepts only closed exact strategies", () => {
  assert.deepEqual(validateDeviceNodeSelector(relationSelector), relationSelector);
  for (const selector of [
    { ...relationSelector, x: 900 },
    { ...relationSelector, path: "/tmp/screen.png" },
    { ...relationSelector, expression: "find anything resembling me" },
    { ...relationSelector, sources: ["vision_model"] },
    { label: "我", role: "tab", sources: ["relation"] },
  ]) {
    assert.throws(() => validateDeviceNodeSelector(selector), /unsupported|invalid|relation/u);
  }
});

test("node selector accepts vision and validates its prompt contract", () => {
  assert.deepEqual(validateDeviceNodeSelector({
    label: "Profile", role: "tab", sources: ["accessibility", "ocr", "relation", "vision"],
    relation: relationSelector.relation,
    visionPrompt: "person-shaped profile tab in the bottom navigation",
  }), {
    label: "Profile", role: "tab", sources: ["accessibility", "ocr", "relation", "vision"],
    relation: relationSelector.relation,
    visionPrompt: "person-shaped profile tab in the bottom navigation",
  });
  assert.deepEqual(validateDeviceNodeSelector({
    label: "Profile", role: "tab", sources: ["vision"],
  }), {
    label: "Profile", role: "tab", sources: ["vision"], visionPrompt: "Profile",
  });
  assert.throws(() => validateDeviceNodeSelector({
    label: "Profile", role: "tab", sources: ["ocr"], visionPrompt: "profile icon",
  }), /requires the vision source/u);
});

test("node selector accepts closed accessibility attributes and near-text relation", () => {
  const selector = {
    label: "评论点赞",
    role: "button",
    sources: ["accessibility"],
    className: "android.widget.ImageView",
    clickable: true,
    nearText: "一条唯一评论",
    nearTextPosition: "right",
  };
  assert.deepEqual(validateDeviceNodeSelector(selector), selector);
  assert.throws(() => validateDeviceNodeSelector({
    ...selector, sources: ["ocr"],
  }), /require the accessibility source/u);
  assert.throws(() => validateDeviceNodeSelector({
    ...selector, clickable: "true",
  }), /clickable is invalid/u);
  assert.throws(() => validateDeviceNodeSelector({
    ...selector, nearTextPosition: "diagonal",
  }), /nearTextPosition is invalid/u);
});

test("content-description shorthand derives a bounded accessibility button selector", () => {
  assert.deepEqual(validateDeviceNodeSelector({ contentDesc: "打开评论" }), {
    label: "打开评论", role: "button", sources: ["accessibility"], contentDesc: "打开评论",
  });
  assert.throws(() => validateDeviceNodeSelector({ className: "android.widget.ImageView" }), /selector.label is invalid/u);
  assert.throws(() => validateDeviceNodeSelector({
    label: "我", sources: ["vision"], visionPrompt: "底部个人页图标",
  }), /selector.role is invalid/u);
});

test("node selector accepts a bounded local icon region and ordinal", () => {
  const selector = {
    label: "分享", role: "button", sources: ["accessibility"],
    className: "android.widget.ImageView", clickable: true, screenRegion: "top_right", regionOrdinal: 2,
  };
  assert.deepEqual(validateDeviceNodeSelector(selector), selector);
  assert.throws(() => validateDeviceNodeSelector({ ...selector, screenRegion: "middle" }), /screenRegion is invalid/u);
  assert.throws(() => validateDeviceNodeSelector({ ...selector, screenRegion: undefined }), /requires selector.screenRegion/u);
});

test("vision node response requires one unique in-display integer rectangle", () => {
  assert.deepEqual(parseVisionNodeResponse(JSON.stringify({
    matches: [{ left: 810, top: 2100, right: 900, bottom: 2190 }],
  }), { width: 1080, height: 2400 }), {
    left: 810, top: 2100, right: 900, bottom: 2190,
  });
  assert.equal(parseVisionNodeResponse({ matches: [] }, { width: 1080, height: 2400 }), null);
  assert.throws(() => parseVisionNodeResponse({ matches: [
    { left: 10, top: 10, right: 20, bottom: 20 },
    { left: 30, top: 30, right: 40, bottom: 40 },
  ] }, { width: 1080, height: 2400 }), /NODE_AMBIGUOUS/u);
  assert.throws(() => parseVisionNodeResponse({
    matches: [{ left: 0, top: 0, right: 1081, bottom: 2400 }],
  }, { width: 1080, height: 2400 }), /CAPABILITY_MISSING/u);
  assert.throws(() => parseVisionNodeResponse('{"bounds":[]}', { width: 1080, height: 2400 }), /CAPABILITY_MISSING/u);
});

test("horizontal equal-spacing inference is generic and fail closed", () => {
  const bounds = inferHorizontalOrdinalBounds([
    { left: 231, top: 2240, right: 309, bottom: 2288 },
    { left: 501, top: 2242, right: 579, bottom: 2290 },
  ], relationSelector.relation, { width: 1080, height: 2400 });
  assert.deepEqual(bounds, { left: 771, top: 2241, right: 849, bottom: 2289 });
  assert.throws(() => inferHorizontalOrdinalBounds([
    { left: 231, top: 1400, right: 309, bottom: 1448 },
    { left: 501, top: 1800, right: 579, bottom: 1848 },
  ], relationSelector.relation, { width: 1080, height: 2400 }), /LAYOUT_DRIFT/u);
});

test("public node description never exposes coordinates or internal identity", () => {
  const value = publicNodeDescription(relationSelector, "relation");
  assert.deepEqual(value, {
    label: "我", role: "tab", group: "bottom_navigation", ordinal: 4,
    source: "relation", unique: true,
  });
  assert.doesNotMatch(JSON.stringify(value), /"(?:serial|alias|deviceId|left|right|top|bottom|x|y)"/iu);
  assert.equal(stableNodeBounds(
    { left: 771, top: 2241, right: 849, bottom: 2289 },
    { left: 776, top: 2243, right: 854, bottom: 2291 },
  ), true);
});
