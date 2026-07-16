import assert from "node:assert/strict";
import test from "node:test";

import {
  inferHorizontalOrdinalBounds,
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
