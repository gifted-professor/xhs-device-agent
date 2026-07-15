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
  "AGENTS.md": "the exact user-approved task is the sole source of business intent",
  "skills/xhs-device-operator/SKILL.md": "Templates add defaults only and explicit task values take precedence",
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

test("policy scan treats a missing authority declaration as a violation", () => {
  const scan = scanRepositoryPolicy(runtime({
    ...required,
    "AGENTS.md": "missing contract",
  }));
  assert.equal(scan.status, "failed");
  assert.deepEqual(scan.missingContracts.map((item) => item.ruleId), ["agents-task-business-authority"]);
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
