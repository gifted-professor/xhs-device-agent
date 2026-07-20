import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRepository,
  CLASSIFICATIONS,
  classifyRepositoryPath,
  formatRepositoryAudit,
} from "../scripts/repo-audit.mjs";

test("repository classification covers keep, integration, deletion and temporary files", () => {
  assert.equal(classifyRepositoryPath("scripts/xhs-page-engine.mjs"), CLASSIFICATIONS.FORMAL_KEEP);
  assert.equal(classifyRepositoryPath("scripts/composite-workflow.mjs"), CLASSIFICATIONS.INTEGRATE);
  assert.equal(classifyRepositoryPath("docs/FEED_WORKFLOW.md"), CLASSIFICATIONS.INTEGRATE);
  assert.equal(classifyRepositoryPath("docs/trusted-runs/obsolete.md"), CLASSIFICATIONS.PENDING_DELETE);
  assert.equal(classifyRepositoryPath("tmp-ocr.mjs"), CLASSIFICATIONS.TEMPORARY);
  assert.equal(classifyRepositoryPath("data/private/evidence.xml"), CLASSIFICATIONS.PRIVATE_RUNTIME);
  assert.equal(classifyRepositoryPath(".env.example"), CLASSIFICATIONS.FORMAL_KEEP);
});

test("repository audit classifies every Git-visible file without enumerating ignored private data", () => {
  const visible = [
    "scripts/xhs-page-engine.mjs",
    "scripts/composite-workflow.mjs",
    "docs/trusted-runs/obsolete.md",
    "tmp-ocr.mjs",
    "data/private/evidence.xml",
  ];
  const audit = auditRepository({
    projectRoot: process.cwd(),
    execFileSync(_executable, args) {
      assert.deepEqual(args, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      return `${visible.join("\0")}\0`;
    },
  });
  assert.equal(audit.visibleFileCount, visible.length);
  assert.equal(Object.values(audit.counts).reduce((sum, value) => sum + value, 0), visible.length);
  assert.equal(audit.ignoredPrivateDataEnumerated, false);
  assert.equal(audit.privateRuntimePathsRedacted, true);
  assert.equal(audit.counts.private_runtime, 1);
  assert.deepEqual(audit.files.private_runtime, []);
  assert.match(formatRepositoryAudit(audit), /Temporary: 1/u);
});
