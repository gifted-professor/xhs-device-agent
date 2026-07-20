import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { formatRepositoryStatus, getRepositoryStatus } from "../scripts/repo-status.mjs";

test("repository status reports the required version identity fields", () => {
  const calls = [];
  const outputs = new Map([
    ["status --porcelain=v1 -uall", " M README.md\n?? new-file.mjs\n"],
    ["branch --show-current", "codex/example\n"],
    ["rev-parse HEAD", `${"a".repeat(40)}\n`],
  ]);
  const status = getRepositoryStatus({
    projectRoot: "C:\\work\\xhs-device-agent",
    hostname: () => "WINDOWS-TEST",
    execFileSync(_executable, args, options) {
      calls.push({ args, options });
      return outputs.get(args.join(" "));
    },
  });
  assert.deepEqual(status, {
    computer: "WINDOWS-TEST",
    repositoryPath: path.resolve("C:\\work\\xhs-device-agent"),
    branch: "codex/example",
    commit: "a".repeat(40),
    uncommittedFileCount: 2,
  });
  assert.equal(calls.length, 3);
  assert.match(formatRepositoryStatus(status), /Uncommitted files: 2/u);
});
