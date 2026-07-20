import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XHS_CMD = path.join(PROJECT_ROOT, "xhs.cmd");
const XHS_PS1 = path.join(PROJECT_ROOT, "xhs.ps1");
const PROBE = path.join(PROJECT_ROOT, "tests", "fixtures", "argv-probe.cjs");
const CONFIG_PATH = "C:\\Users\\windows 10\\Desktop\\coding\\xhs-device-agent\\data\\candidate config.psd1";
const EXPECTED = [
  "__argv_probe__",
  "--config",
  CONFIG_PATH,
  "--sentinel",
  "tail value",
  "--unicode",
  "中文 路径",
];

function probeEnvironment() {
  const nodeOptionsProbe = PROBE.replaceAll("\\", "/");
  return {
    ...process.env,
    XHS_ARGV_PROBE: "1",
    NODE_OPTIONS: `--require "${nodeOptionsProbe}"`,
  };
}

function assertArgumentProbe(result, origin) {
  assert.equal(result.status, 0, `${origin} failed:\n${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "", `${origin} wrote stderr`);
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `${origin} produced unexpected output:\n${result.stdout}`);
  assert.deepEqual(JSON.parse(lines[0]), EXPECTED, `${origin} changed an argument boundary`);
}

function powershellEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

test("xhs.cmd preserves spaced and Unicode values through cmd.exe and PowerShell", {
  skip: process.platform !== "win32",
}, () => {
  const env = probeEnvironment();
  const cmdCommand = [
    ".\\xhs.cmd __argv_probe__",
    `--config "${CONFIG_PATH}"`,
    "--sentinel \"tail value\"",
    "--unicode \"中文 路径\"",
  ].join(" ");
  const cmdResult = spawnSync("cmd.exe", ["/d", "/s", "/c", cmdCommand], {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assertArgumentProbe(cmdResult, "cmd.exe → xhs.cmd");

  const psCommand = [
    "$ProgressPreference = 'SilentlyContinue'; & '.\\xhs.cmd' __argv_probe__",
    `--config '${CONFIG_PATH}'`,
    "--sentinel 'tail value'",
    "--unicode '中文 路径'",
  ].join(" ");
  const psResult = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncoded(psCommand),
  ], {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assertArgumentProbe(psResult, "PowerShell → xhs.cmd");
});

test("xhs.ps1 preserves the same argv as the batch entry", {
  skip: process.platform !== "win32",
}, () => {
  const psCommand = [
    `$ProgressPreference = 'SilentlyContinue'; & '${XHS_PS1.replaceAll("'", "''")}' __argv_probe__`,
    `--config '${CONFIG_PATH}'`,
    "--sentinel 'tail value'",
    "--unicode '中文 路径'",
  ].join(" ");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncoded(psCommand),
  ], {
    cwd: PROJECT_ROOT,
    env: probeEnvironment(),
    encoding: "utf8",
    windowsHide: true,
  });
  assertArgumentProbe(result, "PowerShell → xhs.ps1");
});

const gitExecutables = process.platform === "win32"
  ? spawnSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
    .stdout.split(/\r?\n/u).filter(Boolean)
  : [];
const gitDerivedBash = gitExecutables.flatMap((gitExecutable) => {
  const gitRoot = path.dirname(path.dirname(gitExecutable));
  return [path.join(gitRoot, "bin", "bash.exe"), path.join(gitRoot, "usr", "bin", "bash.exe")];
});
const gitBash = [
  process.env.GIT_BASH,
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ...gitDerivedBash,
].find((candidate) => candidate && existsSync(candidate));
const gitBashVersion = gitBash
  ? spawnSync(gitBash, ["--version"], { encoding: "utf8", windowsHide: true }).stdout
  : "";
const isMsysBash = /msys|mingw/iu.test(gitBashVersion);

test("Git Bash preserves project-relative xhs.cmd arguments when available", {
  skip: process.platform !== "win32" || !gitBash || !isMsysBash
    ? "MSYS/Git Bash is not installed on this host"
    : false,
}, () => {
  const command = [
    "bash ./xhs.cmd __argv_probe__",
    `--config '${CONFIG_PATH.replaceAll("'", "'\\''")}'`,
    "--sentinel 'tail value'",
    "--unicode '中文 路径'",
  ].join(" ");
  const result = spawnSync(gitBash, ["--noprofile", "--norc", "-lc", command], {
    cwd: PROJECT_ROOT,
    env: probeEnvironment(),
    encoding: "utf8",
    windowsHide: true,
  });
  assertArgumentProbe(result, "Git Bash → xhs.cmd");
});
