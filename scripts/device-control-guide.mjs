import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_PATH = path.join(SCRIPT_DIR, "..", "config", "device-control-playbook.json");
const SAFE_ID = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SAFE_COMMAND = /^[a-z][a-z0-9.-]{1,63}$/u;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value.trim();
}

export function validateDeviceControlCatalog(catalog) {
  exactKeys(catalog, ["schemaVersion", "protocol", "description", "decisionOrder", "strategies", "failureCodes"], "device control catalog");
  if (catalog.schemaVersion !== 1 || catalog.protocol !== "observe_resolve_recheck_execute_verify"
      || !Array.isArray(catalog.decisionOrder) || !Array.isArray(catalog.strategies)
      || !Array.isArray(catalog.failureCodes) || catalog.strategies.length > 32 || catalog.failureCodes.length > 64) {
    throw new Error("device control catalog metadata is invalid");
  }
  boundedText(catalog.description, 512, "catalog description");
  const strategyIds = new Set();
  for (const strategy of catalog.strategies) {
    exactKeys(strategy, ["id", "status", "readCommand", "writeCommand", "description"], "device control strategy");
    if (!SAFE_ID.test(strategy.id) || strategyIds.has(strategy.id)
        || !["implemented", "not_implemented"].includes(strategy.status)) {
      throw new Error("device control strategy identity is invalid");
    }
    strategyIds.add(strategy.id);
    for (const command of [strategy.readCommand, strategy.writeCommand]) {
      if (command !== null && (typeof command !== "string" || !SAFE_COMMAND.test(command))) {
        throw new Error("device control strategy command is invalid");
      }
    }
    boundedText(strategy.description, 512, "strategy description");
  }
  if (new Set(catalog.decisionOrder).size !== catalog.decisionOrder.length
      || catalog.decisionOrder.some((id) => !strategyIds.has(id))) {
    throw new Error("device control decision order is invalid");
  }
  const failureCodes = new Set();
  for (const failure of catalog.failureCodes) {
    exactKeys(failure, ["code", "stage", "automatic", "terminal", "nextStrategies", "stopConditions"], "device control failure");
    if (!SAFE_ID.test(failure.code) || failureCodes.has(failure.code)
        || typeof failure.automatic !== "boolean" || typeof failure.terminal !== "boolean"
        || !Array.isArray(failure.nextStrategies) || !Array.isArray(failure.stopConditions)
        || failure.nextStrategies.length > 12 || failure.stopConditions.length > 12
        || failure.nextStrategies.some((id) => !strategyIds.has(id))
        || failure.stopConditions.some((code) => !SAFE_ID.test(code))) {
      throw new Error("device control failure contract is invalid");
    }
    boundedText(failure.stage, 32, "failure stage");
    failureCodes.add(failure.code);
  }
  return catalog;
}

export async function loadDeviceControlCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const value = JSON.parse(await readFile(catalogPath, "utf8"));
  return validateDeviceControlCatalog(value);
}

export async function getDeviceControlGuide(code, options = {}) {
  if (typeof code !== "string" || !SAFE_ID.test(code)) throw new Error("failure code is invalid");
  const catalog = await loadDeviceControlCatalog(options.catalogPath);
  const failure = catalog.failureCodes.find((entry) => entry.code === code);
  if (!failure) throw new Error("failure code is not documented");
  const strategies = new Map(catalog.strategies.map((entry) => [entry.id, entry]));
  return {
    schemaVersion: catalog.schemaVersion,
    code: failure.code,
    stage: failure.stage,
    automatic: failure.automatic,
    terminal: failure.terminal,
    next: failure.nextStrategies.map((id) => {
      const strategy = strategies.get(id);
      return {
        strategy: strategy.id,
        status: strategy.status,
        readCommand: strategy.readCommand,
        writeCommand: strategy.writeCommand,
      };
    }),
    stopConditions: [...failure.stopConditions],
    protocol: catalog.protocol,
  };
}

async function runCli(argv) {
  const codeIndex = argv.indexOf("--code");
  if (codeIndex < 0 || codeIndex + 1 >= argv.length || argv.length !== 2) {
    throw new Error("Usage: node scripts/device-control-guide.mjs --code <FAILURE_CODE>");
  }
  process.stdout.write(`${JSON.stringify(await getDeviceControlGuide(argv[codeIndex + 1]))}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
