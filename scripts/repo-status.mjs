import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

function git(args, runtime) {
  return runtime.execFileSync("git", args, {
    cwd: runtime.projectRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

export function getRepositoryStatus(runtime = {}) {
  const effective = {
    execFileSync: runtime.execFileSync ?? execFileSync,
    hostname: runtime.hostname ?? os.hostname,
    projectRoot: path.resolve(runtime.projectRoot ?? PROJECT_ROOT),
  };
  const porcelain = git(["status", "--porcelain=v1", "-uall"], effective);
  return Object.freeze({
    computer: String(effective.hostname()),
    repositoryPath: effective.projectRoot,
    branch: git(["branch", "--show-current"], effective) || "DETACHED",
    commit: git(["rev-parse", "HEAD"], effective),
    uncommittedFileCount: porcelain ? porcelain.split(/\r?\n/u).length : 0,
  });
}

export function formatRepositoryStatus(status) {
  return [
    `Computer: ${status.computer}`,
    `Repository: ${status.repositoryPath}`,
    `Branch: ${status.branch}`,
    `Commit: ${status.commit}`,
    `Uncommitted files: ${status.uncommittedFileCount}`,
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  if (argv.some((value) => value !== "--json") || argv.filter((value) => value === "--json").length > 1) {
    throw new Error("repo status accepts only an optional --json flag");
  }
  const status = getRepositoryStatus();
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(status)}\n` : `${formatRepositoryStatus(status)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
