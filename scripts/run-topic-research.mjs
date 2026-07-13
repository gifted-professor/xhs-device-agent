import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createAdbResearchProvider } from "./adb-research-provider.mjs";
import { createWindowsLocalOcr } from "./local-ocr.mjs";
import { createDryRunProvider, validateResearchTask } from "./research-core.mjs";
import { runResearchSession } from "./research-session.mjs";

const execFileAsync = promisify(execFile);
const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_SERIAL = /^\S{1,512}$/u;

function entryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseOnlineAdbDevices(output) {
  return [...new Set(String(output ?? "").split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+)\s+device(?:\s|$)/u.exec(line.trim());
    return match ? [match[1]] : [];
  }))];
}

async function listOnlineAdbDevices(adbPath) {
  try {
    const { stdout } = await execFileAsync(adbPath, ["devices"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return parseOnlineAdbDevices(stdout);
  } catch {
    throw entryError("ADB_INVENTORY_FAILED", "Unable to inventory online ADB devices");
  }
}

function validGroupName(value) {
  return typeof value === "string" && value === value.trim() && [...value].length >= 1 && [...value].length <= 40;
}

export async function validateLiveProviderConfig(taskInput, providerConfig, options = {}) {
  const task = validateResearchTask(taskInput);
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    throw entryError("INVALID_PROVIDER_CONFIG", "Provider config must be an object");
  }
  if (typeof providerConfig.adbPath !== "string" || !providerConfig.adbPath.trim()) {
    throw entryError("INVALID_PROVIDER_CONFIG", "Provider config requires an ADB executable path");
  }
  if (!Array.isArray(providerConfig.devices) || providerConfig.devices.length === 0) {
    throw entryError("INVALID_PROVIDER_CONFIG", "Provider config has no mapped devices");
  }

  const aliases = new Set();
  const serials = new Set();
  let taskGroupMembers = 0;
  for (let index = 0; index < providerConfig.devices.length; index += 1) {
    const device = providerConfig.devices[index];
    if (!device || typeof device !== "object" || Array.isArray(device)) {
      throw entryError("INVALID_PROVIDER_CONFIG", `Provider device ${index + 1} is invalid`);
    }
    if (typeof device.alias !== "string" || device.alias === "unmapped" || !SAFE_ALIAS.test(device.alias)) {
      throw entryError("INVALID_PROVIDER_CONFIG", `Provider device ${index + 1} has an invalid alias`);
    }
    if (typeof device.serial !== "string" || device.serial !== device.serial.trim() || !SAFE_SERIAL.test(device.serial)) {
      throw entryError("INVALID_PROVIDER_CONFIG", `Provider device ${index + 1} has an invalid identifier`);
    }
    if (aliases.has(device.alias)) {
      throw entryError("INVALID_PROVIDER_CONFIG", "Provider device aliases must be unique");
    }
    if (serials.has(device.serial)) {
      throw entryError("INVALID_PROVIDER_CONFIG", "Provider device identifiers must be unique");
    }
    if (!Array.isArray(device.groups) || device.groups.length === 0 ||
        device.groups.some((group) => !validGroupName(group)) ||
        new Set(device.groups).size !== device.groups.length) {
      throw entryError("INVALID_PROVIDER_CONFIG", `Provider device ${index + 1} requires unique explicit groups`);
    }
    aliases.add(device.alias);
    serials.add(device.serial);
    if (device.groups.includes(task.deviceGroup)) taskGroupMembers += 1;
  }
  if (taskGroupMembers === 0) {
    throw entryError("EMPTY_TASK_DEVICE_GROUP", "The task device group has no mapped devices");
  }

  const inventory = options.listOnlineDevices ?? listOnlineAdbDevices;
  let onlineDevices;
  try {
    onlineDevices = await inventory(providerConfig.adbPath);
  } catch (error) {
    if (error?.code === "ADB_INVENTORY_FAILED") throw error;
    throw entryError("ADB_INVENTORY_FAILED", "Unable to inventory online ADB devices");
  }
  if (!Array.isArray(onlineDevices) || onlineDevices.some((serial) => typeof serial !== "string" || !SAFE_SERIAL.test(serial))) {
    throw entryError("ADB_INVENTORY_FAILED", "ADB returned an invalid device inventory");
  }
  if (onlineDevices.length === 0) {
    throw entryError("NO_ONLINE_DEVICES", "No online ADB devices were found");
  }
  if (onlineDevices.some((serial) => !serials.has(serial))) {
    throw entryError("UNMAPPED_ONLINE_DEVICES", "Formal research is blocked because one or more online devices are not mapped");
  }
}

function parseArguments(argv) {
  const result = { devices: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--task") result.taskPath = argv[++index];
    else if (value === "--output-root") result.outputRoot = argv[++index];
    else if (value === "--provider-config") result.providerConfigPath = argv[++index];
    else if (value === "--devices") result.devices = String(argv[++index] ?? "").split(",").filter(Boolean);
    else if (value === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.taskPath) throw new Error("--task is required");
  if (!result.dryRun && !result.providerConfigPath) throw new Error("--provider-config is required for live ADB research");
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

async function loadLocalEnvironment() {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  let contents;
  try {
    contents = await readFile(path.join(projectRoot, ".env"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

export async function runFromArguments(argv, runtime = {}) {
  await loadLocalEnvironment();
  const args = parseArguments(argv);
  const task = validateResearchTask(await readJson(args.taskPath));
  const common = {
    outputRoot: args.outputRoot,
    ai: {
      apiUrl: process.env.AI_API_URL || process.env.VISION_API_URL,
      apiKey: process.env.AI_API_KEY || process.env.VISION_API_KEY,
      model: process.env.AI_MODEL || process.env.VISION_MODEL,
      promptVersion: process.env.XHS_AI_PROMPT_VERSION || "1",
    },
  };
  if (args.dryRun) {
    return runResearchSession(task, {
      ...common,
      provider: createDryRunProvider({ devices: args.devices.length ? args.devices : undefined }),
    });
  }

  const providerConfig = await readJson(args.providerConfigPath);
  await validateLiveProviderConfig(task, providerConfig, {
    listOnlineDevices: runtime.listOnlineDevices,
  });
  const localOcr = createWindowsLocalOcr();
  return runResearchSession(task, {
    ...common,
    providerFactory({ pageRecovery, resourceUsage, onResourceUsage, taskDirectory }) {
      return createAdbResearchProvider({
        ...providerConfig,
        localOcr,
        pageRecovery,
        onResourceUsage,
        failureArtifactsRoot: path.join(taskDirectory, "diagnostics"),
        initialCommentPanelsByTask: { [task.taskId]: resourceUsage.commentPanelsUsed },
      });
    },
  });
}

async function main() {
  const summary = await runFromArguments(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.code ?? error.name, message: error.message })}\n`);
    process.exitCode = 1;
  });
}
