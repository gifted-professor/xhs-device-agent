import { readFileSync } from "node:fs";
import { execFileSync as runFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

const PRIVATE_PATH_PATTERNS = Object.freeze([
  /^data\/(?!\.gitkeep$)/u,
  /^(?:\.env(?!\.example$)(?:\..+)?|config\/(?:local\.psd1|input-methods\.local\.psd1))$/iu,
  /(?:^|\/)(?:accounts?|credentials?|secrets?|tokens?|sessions?)(?:\/|$)/iu,
  /\.(?:png|jpe?g|webp|bmp|gif|xml|csv|log)$/iu,
]);

const SOURCE_EXTENSIONS = /\.(?:md|mjs|js|ps1|psd1|json|cmd)$/iu;
const STALE_SCAN_EXCLUSIONS = new Set([
  "scripts/repo-policy-scan.mjs",
  "tests/repo-policy-scan.test.mjs",
]);

export const STALE_RESTRICTION_RULES = Object.freeze([
  Object.freeze({ id: "permanent-business-block", pattern: /permanently blocked/iu }),
  Object.freeze({ id: "confirmation-cannot-override", pattern: /confirmation cannot override/iu }),
  Object.freeze({ id: "static-device-interaction-allowlist", pattern: /Xhs\.Interactions\.AllowedActionsByAlias|AllowedActionsByAlias\s*=\s*@\{/u }),
  Object.freeze({ id: "static-device-interaction-authorization", pattern: /readInteractionAuthorization\s*\(|interactionAuthorization\s*:/u }),
  Object.freeze({ id: "feed-count-1-to-50", pattern: /ValidateRange\(1,\s*50\)|asBoundedInteger\(input\.count,\s*["']count["'],\s*1,\s*50\)/u }),
  Object.freeze({ id: "same-position-action-ban", pattern: /likeAt and favoriteAt must target different feed positions|LikeAt and FavoriteAt must target different feed positions/iu }),
  Object.freeze({ id: "legacy-feed-single-device-entry", pattern: /Feed run requires exactly one machine number or machine name/iu }),
  Object.freeze({
    id: "legacy-feed-single-action-slots",
    pattern: /\[int\]\$LikeAt[\s\S]*\[int\]\$FavoriteAt/u,
    compatibilityFiles: new Set(["scripts/Run-TaskCompatibility.ps1"]),
  }),
  Object.freeze({ id: "legacy-batch-device-cap", pattern: /runs must contain one or two explicit machines/iu }),
  Object.freeze({ id: "legacy-batch-read-only-executor", pattern: /Feed batch V1 is read-only and rejects interactions/iu }),
  Object.freeze({ id: "legacy-matrix-interaction-implementation", pattern: /"Follow"\s*\{|"Comment"\s*\{|"Publish"\s*\{|"Delete"\s*\{/u }),
  Object.freeze({ id: "template-overrides-explicit-value", pattern: /Feed template .* fixes --|模板参数不允许冲突覆盖|拒绝冲突覆盖/iu }),
  Object.freeze({ id: "retired-feed-executor-reference", pattern: /Run-FeedWorkflow\.ps1|Run-FeedBatch\.ps1|feed-batch-(?:core|control|runner)\.mjs|feed-workflow\.mjs/iu }),
  Object.freeze({ id: "retired-fixed-feed-template", pattern: /trusted-10/iu }),
]);

const REQUIRED_CONTRACTS = Object.freeze([
  Object.freeze({
    id: "agents-task-business-authority",
    file: "AGENTS.md",
    pattern: /exact user-approved task is the sole source of business intent/u,
  }),
  Object.freeze({
    id: "skill-template-defaults-only",
    file: "skills/xhs-device-operator/SKILL.md",
    pattern: /Templates add defaults only and explicit task values take precedence/u,
  }),
  Object.freeze({
    id: "policy-approved-task-source",
    file: "config/composite-policy.supervised-v1.json",
    pattern: /"source"\s*:\s*"approved_task_spec"/u,
  }),
  Object.freeze({
    id: "policy-template-defaults-only",
    file: "config/composite-policy.supervised-v1.json",
    pattern: /"templateBehavior"\s*:\s*"defaults_only"/u,
  }),
  Object.freeze({
    id: "policy-selected-required-scope",
    file: "config/composite-policy.supervised-v1.json",
    pattern: /"validationScope"\s*:\s*"selected_devices_and_required_capabilities"/u,
  }),
]);

function normalize(value) {
  return String(value).replaceAll("\\", "/");
}

function splitNull(value) {
  return String(value).split("\0").filter(Boolean).map(normalize);
}

function isPrivatePath(file) {
  return PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/u).length;
}

function readTrackedSources(runtime, trackedFiles) {
  const values = new Map();
  for (const file of trackedFiles) {
    if (isPrivatePath(file) || !SOURCE_EXTENSIONS.test(file)) continue;
    try {
      values.set(file, runtime.readFileSync(path.join(runtime.projectRoot, file), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return values;
}

function listRemotePrivateObjects(runtime) {
  try {
    const output = runtime.execFileSync("git", ["rev-list", "--objects", "--remotes=origin"], {
      cwd: runtime.projectRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    const count = String(output).split(/\r?\n/u).filter((line) => {
      const separator = line.indexOf(" ");
      return separator >= 0 && isPrivatePath(normalize(line.slice(separator + 1)));
    }).length;
    return Object.freeze({ available: true, count });
  } catch {
    return Object.freeze({ available: false, count: 0 });
  }
}

export function scanRepositoryPolicy(runtime = {}) {
  const effective = {
    execFileSync: runtime.execFileSync ?? runFileSync,
    readFileSync: runtime.readFileSync ?? readFileSync,
    projectRoot: path.resolve(runtime.projectRoot ?? PROJECT_ROOT),
  };
  const trackedFiles = splitNull(effective.execFileSync("git", ["ls-files", "-z"], {
    cwd: effective.projectRoot,
    encoding: "utf8",
    windowsHide: true,
  })).sort((left, right) => left.localeCompare(right));
  const trackedPrivateCount = trackedFiles.filter(isPrivatePath).length;
  const sources = readTrackedSources(effective, trackedFiles);
  const staleRestrictions = [];
  for (const [file, source] of sources) {
    if (STALE_SCAN_EXCLUSIONS.has(file)) continue;
    for (const rule of STALE_RESTRICTION_RULES) {
      if (rule.compatibilityFiles?.has(file)) continue;
      const match = rule.pattern.exec(source);
      if (match) staleRestrictions.push(Object.freeze({ ruleId: rule.id, file, line: lineOf(source, match.index) }));
    }
  }
  const missingContracts = [];
  for (const contract of REQUIRED_CONTRACTS) {
    const source = sources.get(contract.file);
    if (!source || !contract.pattern.test(source)) missingContracts.push(Object.freeze({ ruleId: contract.id, file: contract.file }));
  }
  const legacyDebt = [];
  const remotePrivate = listRemotePrivateObjects(effective);
  const violationCount = trackedPrivateCount + remotePrivate.count + staleRestrictions.length + missingContracts.length;
  return Object.freeze({
    schemaVersion: "xhs-repository-policy-scan/v1",
    status: violationCount === 0 ? "passed" : "failed",
    trackedFileCount: trackedFiles.length,
    trackedPrivateRuntimeCount: trackedPrivateCount,
    remoteHistoryScanAvailable: remotePrivate.available,
    remoteReachablePrivateObjectCount: remotePrivate.count,
    privatePathsRedacted: true,
    staleRestrictions,
    missingContracts,
    legacyDebt,
    violationCount,
  });
}

export function formatRepositoryPolicyScan(scan) {
  return [
    `Repository policy scan: ${scan.status}`,
    `Tracked private runtime files (paths redacted): ${scan.trackedPrivateRuntimeCount}`,
    `Remote-reachable private objects (paths redacted): ${scan.remoteReachablePrivateObjectCount}`,
    `Stale restriction violations: ${scan.staleRestrictions.length}`,
    `Missing authority contracts: ${scan.missingContracts.length}`,
    `Explicit legacy debt: ${scan.legacyDebt.length}`,
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  if (argv.some((value) => value !== "--json") || argv.filter((value) => value === "--json").length > 1) {
    throw new Error("repo policy accepts only an optional --json flag");
  }
  const scan = scanRepositoryPolicy();
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(scan)}\n` : `${formatRepositoryPolicyScan(scan)}\n`);
  if (scan.violationCount !== 0) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
