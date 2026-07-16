import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRepositoryPolicyScan,
  scanRepositoryPolicy,
} from "../scripts/repo-policy-scan.mjs";

function runtime(files, remoteObjects = "") {
  const normalized = Object.fromEntries(Object.entries(files).map(([file, source]) => [file.replaceAll("\\", "/"), source]));
  return {
    projectRoot: "C:\\repo",
    execFileSync(_executable, args) {
      if (args[0] === "ls-files") return `${Object.keys(normalized).join("\0")}\0`;
      if (args[0] === "rev-list") return remoteObjects;
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    readFileSync(file) {
      const relative = String(file).replaceAll("\\", "/").replace(/^C:\/repo\//u, "");
      return normalized[relative];
    },
  };
}

const required = Object.freeze({
  "AGENTS.md": "This file defines the repository's permissive operating baseline",
  "skills/xhs-device-operator/SKILL.md": "Treat the user's current request as the authority. Templates add defaults only and explicit task values take precedence",
  "docs/SAFETY.md": "用户当前任务中明确写出的机器、App、目标、动作、次数、顺序和并发就是该任务的执行授权",
  "docs/HERMES_RUN_CONTRACT.md": "不得因为缺少 task-id、dry-run、planHash、capability profile、应用白名单或逐步确认而拒绝",
  "docs/工作室手机任务与能力清单-API调用版.md": "当前采用长期宽松执行模式",
  "config/device-control-playbook.json": JSON.stringify({
    id: "REQUEST_SCOPED_ACTION",
    description: "current request authority",
    code: "SENSITIVE_SURFACE",
    terminal: false,
  }),
  "scripts/xhs-agent.mjs": "当前请求明确包含的登录、权限、支付、互动和账号状态动作可以继续",
  "config/composite-policy.supervised-v1.json": JSON.stringify({
    source: "approved_task_spec",
    templateBehavior: "defaults_only",
    validationScope: "selected_devices_and_required_capabilities",
  }),
});

test("policy scan passes a clean repository with zero legacy debt", () => {
  const scan = scanRepositoryPolicy(runtime({ ...required, "data/.gitkeep": "" }));
  assert.equal(scan.status, "passed");
  assert.equal(scan.violationCount, 0);
  assert.equal(scan.legacyDebt.length, 0);
  assert.match(formatRepositoryPolicyScan(scan), /Explicit legacy debt: 0/u);
});

test("policy scan makes removed legacy limits and executors hard failures", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "scripts/old-batch.mjs": "runs must contain one or two explicit machines",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), ["legacy-batch-device-cap"]);
});

test("policy scan fails closed on stale limits and redacts private paths", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "scripts/old.ps1": "[ValidateRange(1, 50)] $Count",
    "data/private/screen.png": "not read",
  }, "deadbeef data/feed/private/checkpoint.json\n"));
  assert.equal(scan.status, "failed");
  assert.equal(scan.trackedPrivateRuntimeCount, 1);
  assert.equal(scan.remoteReachablePrivateObjectCount, 1);
  assert.equal(scan.staleRestrictions[0].ruleId, "feed-count-1-to-50");
  assert.equal(JSON.stringify(scan).includes("data/private"), false);
});

test("policy scan requires the permanent permissive operating baseline declaration", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "AGENTS.md": "missing contract",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.missingContracts.map((item) => item.ruleId), ["agents-permissive-operating-baseline"]);
});

test("policy scan rejects a universal xhs.cmd gate or repeated planHash approval", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale-operator.md": "所有设备操作只从 xhs.cmd 进入；本轮唯一确认边界是 planHash。",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), [
    "xhs-cmd-universal-only-entry",
    "mandatory-second-planhash-approval",
  ]);
});

test("policy scan rejects reintroduced sensitive-surface and capability-missing stop gates", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale-device-guide.md": "`SENSITIVE_SURFACE`：保存当前状态并交给人。\n`CAPABILITY_MISSING`：不能退回任何兼容入口。",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), [
    "sensitive-surface-universal-human-gate",
    "capability-missing-no-fallback-gate",
  ]);
});

test("policy scan rejects a universal stop for requested login or payment work", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale-sensitive.md": "遇到登录、验证码或支付时立即停止。",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), [
    "requested-sensitive-action-universal-stop",
  ]);
});

test("policy scan rejects reintroduced per-device static interaction authorization", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "scripts/legacy-provider.mjs": "provider.readInteractionAuthorization(machine)",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), ["static-device-interaction-authorization"]);
});

test("policy scan rejects retired Feed executors and fixed templates", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale.md": "Run-FeedWorkflow.ps1 and trusted-10",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), [
    "retired-feed-executor-reference",
    "retired-fixed-feed-template",
  ]);
});

test("policy scan permits legacy positional fields only inside the conversion-only wrapper", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "scripts/Run-TaskCompatibility.ps1": "[int]$LikeAt\n[int]$FavoriteAt",
  }));
  assert.equal(scan.status, "passed");
  assert.deepEqual(scan.staleRestrictions, []);
});

test("policy scan rejects retired standalone Research and account-ramp executors", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale-research.md": "Run-TopicResearch.ps1 and xhs.cmd ramp run",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), [
    "retired-research-executor",
    "retired-account-ramp-automation",
  ]);
});

test("policy scan rejects the retired Composite V1 recipe compiler", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "docs/stale-composite.md": "Use composite-request.schema.json with xhs-composite-request/v1",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.staleRestrictions.map((item) => item.ruleId), ["retired-composite-v1-compiler"]);
});
