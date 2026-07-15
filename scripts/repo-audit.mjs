import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export const CLASSIFICATIONS = Object.freeze({
  FORMAL_KEEP: "formal_keep",
  INTEGRATE: "integrate",
  PENDING_DELETE: "pending_delete",
  TEMPORARY: "temporary",
  PRIVATE_RUNTIME: "private_runtime",
});

const PRIVATE_RUNTIME_PATTERNS = Object.freeze([
  /^data\/(?!\.gitkeep$)/u,
  /\.(?:png|jpe?g|webp|bmp|gif|xml|csv|log)$/iu,
  /^(?:\.env|config\/(?:local\.psd1|input-methods\.local\.psd1))$/u,
  /(?:^|\/)(?:accounts?|credentials?|secrets?|tokens?|sessions?)(?:\/|$)/iu,
]);

const INTEGRATION_PATTERNS = Object.freeze([
  /^(?:xhs\.cmd|xhs\.ps1|package\.json)$/u,
  /^scripts\/(?:xhs-agent|repo-policy-scan|Run-Feed|feed-|Run-TopicResearch|run-topic-research|research-core|research-session|adb-research-provider|composite-)/u,
  /^config\/composite-/u,
  /^tests\/(?:xhs-agent|xhs-entry|feed-|research-|run-topic-research|composite-)/u,
  /^(?:AGENTS\.md|README\.md|skills\/xhs-device-operator\/SKILL\.md)$/u,
  /^docs\/(?:ARCHITECTURE|FEED_RUNBOOK|RESEARCH_AUTOMATION|HERMES_RUN_CONTRACT|XIAOWEI_DEVICE_OPERATOR_GUIDE)\.md$/u,
]);

const PENDING_DELETE_PATTERNS = Object.freeze([
  /^docs\/HERMES_CAPABILITY_ACCEPTANCE\.md$/u,
  /^docs\/plans\//u,
  /^docs\/trusted-runs\//u,
  /^docs\/FEED_WORKFLOW\.md$/u,
]);

function normalize(value) {
  return String(value).replaceAll("\\", "/");
}

export function classifyRepositoryPath(file) {
  const normalized = normalize(file);
  if (PRIVATE_RUNTIME_PATTERNS.some((pattern) => pattern.test(normalized))) return CLASSIFICATIONS.PRIVATE_RUNTIME;
  if (/^(?:.*\/)?tmp-[^/]+\.(?:mjs|js|ps1)$/u.test(normalized)) return CLASSIFICATIONS.TEMPORARY;
  if (PENDING_DELETE_PATTERNS.some((pattern) => pattern.test(normalized))) return CLASSIFICATIONS.PENDING_DELETE;
  if (INTEGRATION_PATTERNS.some((pattern) => pattern.test(normalized))) return CLASSIFICATIONS.INTEGRATE;
  return CLASSIFICATIONS.FORMAL_KEEP;
}

function listVisibleRepositoryFiles(runtime) {
  const output = runtime.execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: runtime.projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return output.split("\0").filter(Boolean).map(normalize).sort((left, right) => left.localeCompare(right));
}

export function auditRepository(runtime = {}) {
  const effective = {
    execFileSync: runtime.execFileSync ?? execFileSync,
    projectRoot: path.resolve(runtime.projectRoot ?? PROJECT_ROOT),
  };
  const files = listVisibleRepositoryFiles(effective);
  const byClassification = Object.fromEntries(Object.values(CLASSIFICATIONS).map((name) => [name, []]));
  const counts = Object.fromEntries(Object.values(CLASSIFICATIONS).map((name) => [name, 0]));
  for (const file of files) {
    const classification = classifyRepositoryPath(file);
    counts[classification] += 1;
    if (classification !== CLASSIFICATIONS.PRIVATE_RUNTIME) byClassification[classification].push(file);
  }
  return Object.freeze({
    schemaVersion: "xhs-repository-audit/v1",
    repositoryPath: effective.projectRoot,
    visibleFileCount: files.length,
    ignoredPrivateDataEnumerated: false,
    privateRuntimePathsRedacted: true,
    privateDataPolicy: [
      "data/** except data/.gitkeep",
      ".env and local configuration; .env.example is a non-secret template",
      "screenshots, UI XML, CSV and logs",
      "account, credential, token and session material",
    ],
    counts,
    files: byClassification,
  });
}

export function formatRepositoryAudit(audit) {
  return [
    `Visible repository files: ${audit.visibleFileCount}`,
    `Formal keep: ${audit.counts.formal_keep}`,
    `Integrate: ${audit.counts.integrate}`,
    `Pending delete/rewrite: ${audit.counts.pending_delete}`,
    `Temporary: ${audit.counts.temporary}`,
    `Tracked private runtime files (paths redacted): ${audit.counts.private_runtime}`,
    "Ignored private runtime data: not enumerated",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  if (argv.some((value) => value !== "--json") || argv.filter((value) => value === "--json").length > 1) {
    throw new Error("repo audit accepts only an optional --json flag");
  }
  const audit = auditRepository();
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(audit)}\n` : `${formatRepositoryAudit(audit)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
