import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITIES, INVENTORY, summarizeCapabilities } from "../scripts/lib/xiaowei-capabilities.mjs";
import { discoverStaticActions } from "../scripts/xiaowei-discover.mjs";

const REQUIRED_FIELDS = [
  "id", "domain", "uiLabels", "vendorActions", "sources", "availability", "maturity",
  "testOrder", "typedApi", "rawLabApi", "requestSchema", "responseSchema", "verification",
  "restoration", "timeoutMs", "versionRange",
];
const MATURITY = new Set(["D0", "D1", "D2", "D3", "D4", "D5"]);
const TEST_ORDER = new Set(["S0", "S1", "S2", "S3", "S4"]);
const REQUIRED_UI_LABELS = [
  "打开大屏", "修改编号", "修改名称", "移动标签", "安装APK", "文字分发", "文件分发",
  "导入文件", "导出文件", "导出粘贴板", "ADB命令", "自动滑屏", "录制动作", "执行动作",
  "执行任务", "结束任务", "执行列表", "切换输入法", "快捷短语", "设编号为壁纸",
  "转为WIFI模式", "转为ROOT模式", "转为无障碍模式", "关闭屏幕",
];

test("inventory has the expected product and schema version", () => {
  assert.equal(INVENTORY.schemaVersion, 1);
  assert.equal(INVENTORY.product.observedVersion, "9.10.113");
  assert.equal(INVENTORY.product.transport, "ws://127.0.0.1:22222/");
});

test("every capability satisfies the inventory schema", () => {
  const ids = new Set();

  for (const capability of CAPABILITIES) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(Object.hasOwn(capability, field), `${capability.id || "<missing-id>"} lacks ${field}`);
    }
    assert.ok(!ids.has(capability.id), `duplicate capability ID: ${capability.id}`);
    ids.add(capability.id);
    assert.ok(Array.isArray(capability.uiLabels));
    assert.ok(Array.isArray(capability.vendorActions));
    assert.ok(Array.isArray(capability.sources) && capability.sources.length > 0);
    assert.ok(MATURITY.has(capability.maturity), `${capability.id} has invalid maturity`);
    assert.ok(TEST_ORDER.has(capability.testOrder), `${capability.id} has invalid test order`);
    assert.equal(typeof capability.typedApi, "boolean");
    assert.equal(typeof capability.rawLabApi, "boolean");
    assert.ok(capability.timeoutMs > 0);
    assert.ok(capability.verification.length > 0);
    assert.ok(capability.restoration.length > 0);
    if (capability.rawLabApi) {
      assert.ok(capability.vendorActions.length > 0, `${capability.id} rawLabApi lacks vendor action`);
    }
  }
});

test("inventory covers every observed context-menu label", () => {
  const labels = new Set(CAPABILITIES.flatMap((capability) => capability.uiLabels));
  for (const label of REQUIRED_UI_LABELS) {
    assert.ok(labels.has(label), `missing UI label: ${label}`);
  }
});

test("summary counts agree with inventory", () => {
  const summary = summarizeCapabilities();
  assert.equal(summary.total, CAPABILITIES.length);
  assert.equal(summary.rawLab, CAPABILITIES.filter((capability) => capability.rawLabApi).length);
  assert.equal(summary.typed, CAPABILITIES.filter((capability) => capability.typedApi).length);
});

test("static discovery finds sourced action strings without invoking them", () => {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-static-"));
  writeFileSync(join(root, "sample.mjs"), 'request("installApk"); const x = { action: "customProbe" };\n');

  const result = discoverStaticActions(root);
  assert.equal(result.scannedFiles, 1);
  assert.deepEqual(result.actions.map((entry) => entry.action), ["customProbe", "installApk"]);
  assert.match(result.actions[0].sources[0].sha256, /^[a-f0-9]{64}$/);
});
