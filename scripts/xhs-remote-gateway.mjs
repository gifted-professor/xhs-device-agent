import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateDeviceNodeSelector } from "./device-node-engine.mjs";

const GATEWAY_SOURCE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(GATEWAY_SOURCE_PATH);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17_891;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const VISION_NODE_TIMEOUT_MS = 270_000;
const COMMENT_INPUT_TRANSACTION_TIMEOUT_MS = 300_000;
const AUDIT_PATH = path.join(PROJECT_ROOT, "data", "remote-gateway-audit.log");
const GATEWAY_RESIDENT_SOURCE_PATHS = Object.freeze([
  GATEWAY_SOURCE_PATH,
  path.join(SCRIPT_DIR, "device-node-engine.mjs"),
]);

export function computeGatewayBuildId(sourcePaths = GATEWAY_RESIDENT_SOURCE_PATHS) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length < 1) throw new Error("Gateway build sources are invalid");
  const hash = createHash("sha256");
  for (const sourcePath of [...sourcePaths].sort()) {
    hash.update(path.basename(sourcePath), "utf8");
    hash.update("\0", "utf8");
    hash.update(readFileSync(sourcePath));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

const GATEWAY_BUILD_ID = computeGatewayBuildId();
const GATEWAY_BOOT_ID = randomUUID();

const SIMPLE_COMMANDS = Object.freeze({
  "doctor": ["doctor"],
  "host.status": ["host", "status"],
  "host.refresh": ["host", "refresh"],
  "host.restart-adb": ["host", "restart-adb"],
  "host.private-api-status": ["host", "private-api-status"],
  "device.list": ["device", "list"],
  "api.probe": ["api", "probe"],
  "api.catalog": ["api", "catalog"],
  "private.catalog": ["api", "private-catalog"],
});

const TARGETED_COMMANDS = Object.freeze({
  "device.size": ["device", "size"],
  "device.ui": ["device", "ui"],
  "device.screen": ["device", "screen"],
  "wechat.wallet-balance": ["wechat", "wallet-balance"],
  "xhs.observe": ["xhs", "observe"],
  "device.open-xhs": ["device", "open-xhs"],
  "device.open-profile": ["device", "open-profile"],
  "device.home": ["device", "home"],
  "device.recent": ["device", "recent"],
  "device.back": ["device", "back"],
  "app.list": ["app", "list"],
});

const CONFIRMED_COMMANDS = Object.freeze({
  "device.screen-off": ["device", "screen-off"],
  "device.screen-on": ["device", "screen-on"],
  "device.settings": ["device", "settings"],
});

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown remote command field: ${unknown[0]}`);
}

function boundedString(value, name, maximum = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function machineArg(value) {
  const machine = boundedString(value, "machine", 16);
  if (!/^\d{2}$/u.test(machine)) throw new Error("machine must be a two-digit machine number");
  return ["--machine", machine];
}

function percentageArg(value, name) {
  const textValue = typeof value === "number" ? String(value) : boundedString(value, name, 24);
  if (!/^(?:100(?:\.0{1,6})?|(?:\d|[1-9]\d)(?:\.\d{1,6})?)$/u.test(textValue)) {
    throw new Error(`${name} must be a percentage from 0 through 100`);
  }
  const numeric = Number(textValue);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new Error(`${name} must be a percentage from 0 through 100`);
  }
  return String(numeric);
}

function confirmationArgs(input) {
  return [
    "--confirm",
    "--reason", boundedString(input.reason, "reason", 256),
    "--rollback", boundedString(input.rollback, "rollback", 256),
  ];
}

export function buildRemoteArgv(input) {
  if (!plainObject(input)) throw new Error("Remote command body must be an object");
  const command = boundedString(input.command, "command", 64);
  if (SIMPLE_COMMANDS[command]) {
    exactKeys(input, new Set(["command"]));
    return [...SIMPLE_COMMANDS[command]];
  }
  if (TARGETED_COMMANDS[command]) {
    exactKeys(input, new Set(["command", "machine"]));
    return [...TARGETED_COMMANDS[command], ...machineArg(input.machine)];
  }
  if (command === "device.guide") {
    exactKeys(input, new Set(["command", "failureCode"]));
    const failureCode = boundedString(input.failureCode, "failureCode", 64);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(failureCode)) throw new Error("failureCode is invalid");
    return ["device", "guide", "--failure-code", failureCode];
  }
  if (command === "xhs.open-visible") {
    exactKeys(input, new Set(["command", "machine", "ordinal"]));
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 20) {
      throw new Error("ordinal must be an integer from 1 through 20");
    }
    return ["xhs", "open-visible", ...machineArg(input.machine), "--ordinal", String(input.ordinal)];
  }
  if (command === "xhs.find-video") {
    exactKeys(input, new Set(["command", "machine", "maxScrolls", "maxDurationMs"]));
    const maxScrolls = input.maxScrolls ?? 3;
    const maxDurationMs = input.maxDurationMs ?? 28_000;
    if (!Number.isSafeInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > 10) {
      throw new Error("maxScrolls must be an integer from 0 through 10");
    }
    if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 5_000 || maxDurationMs > 60_000) {
      throw new Error("maxDurationMs must be an integer from 5000 through 60000");
    }
    return [
      "xhs", "find-video", ...machineArg(input.machine),
      "--max-scrolls", String(maxScrolls), "--max-duration-ms", String(maxDurationMs),
    ];
  }
  if (command === "xhs.comment-emoji") {
    exactKeys(input, new Set(["command", "machine", "emoji"]));
    return [
      "xhs", "comment-emoji", ...machineArg(input.machine),
      "--emoji", boundedString(input.emoji, "emoji", 64),
    ];
  }
  if (command === "xhs.comment.open") {
    exactKeys(input, new Set(["command", "machine"]));
    return ["xhs", "comment-open", ...machineArg(input.machine)];
  }
  if (command === "xhs.comment.input") {
    exactKeys(input, new Set(["command", "machine", "text", "expectedEditorStateHash"]));
    const expectedEditorStateHash = boundedString(input.expectedEditorStateHash, "expectedEditorStateHash", 64);
    if (!/^[a-f0-9]{64}$/u.test(expectedEditorStateHash)) throw new Error("expectedEditorStateHash is invalid");
    return [
      "xhs", "comment-input", ...machineArg(input.machine),
      "--text", boundedString(input.text, "text", 256),
      "--expected-editor-state-hash", expectedEditorStateHash,
    ];
  }
  if (command === "xhs.comment.reply-input") {
    exactKeys(input, new Set(["command", "machine", "text", "ordinal"]));
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 50) {
      throw new Error("xhs.comment.reply-input ordinal is invalid");
    }
    return [
      "xhs", "comment-reply-input", ...machineArg(input.machine),
      "--text", boundedString(input.text, "text", 256),
      "--ordinal", String(input.ordinal),
    ];
  }
  if (command === "xhs.comment.send") {
    exactKeys(input, new Set([
      "command", "machine", "expectedDraft", "expectedBeforeCount", "expectedTarget", "expectedEmptyEditorStateHash",
    ]));
    if (!Number.isSafeInteger(input.expectedBeforeCount) || input.expectedBeforeCount < 0
        || input.expectedBeforeCount > 999_999_999) {
      throw new Error("expectedBeforeCount must be a non-negative integer");
    }
    if (!plainObject(input.expectedTarget)) throw new Error("expectedTarget is invalid");
    exactKeys(input.expectedTarget, new Set(["title", "author", "mediaType"]));
    const expectedTarget = {
      title: boundedString(input.expectedTarget.title, "expectedTarget.title", 512),
      author: boundedString(input.expectedTarget.author, "expectedTarget.author", 256),
      mediaType: boundedString(input.expectedTarget.mediaType, "expectedTarget.mediaType", 16),
    };
    if (!["image", "video"].includes(expectedTarget.mediaType)) throw new Error("expectedTarget.mediaType is invalid");
    const expectedEmptyEditorStateHash = boundedString(input.expectedEmptyEditorStateHash, "expectedEmptyEditorStateHash", 64);
    if (!/^[a-f0-9]{64}$/u.test(expectedEmptyEditorStateHash)) throw new Error("expectedEmptyEditorStateHash is invalid");
    return [
      "xhs", "comment-send", ...machineArg(input.machine),
      "--expected-draft", boundedString(input.expectedDraft, "expectedDraft", 256),
      "--expected-before-count", String(input.expectedBeforeCount),
      "--expected-target-base64", Buffer.from(JSON.stringify(expectedTarget), "utf8").toString("base64"),
      "--expected-empty-editor-state-hash", expectedEmptyEditorStateHash,
    ];
  }
  if (command === "xhs.dm.send") {
    exactKeys(input, new Set(["command", "machine", "expectedDraft"]));
    return [
      "xhs", "dm-send", ...machineArg(input.machine),
      "--expected-draft", boundedString(input.expectedDraft, "expectedDraft", 256),
    ];
  }
  if (command === "device.scroll") {
    exactKeys(input, new Set(["command", "machine", "direction", "steps", "package"]));
    if (!["down", "up", "left", "right"].includes(input.direction)) throw new Error("direction must be down, up, left, or right");
    const steps = input.steps === undefined ? 1 : input.steps;
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 5) throw new Error("steps must be an integer from 1 through 5");
    const args = ["device", "scroll", ...machineArg(input.machine), "--direction", input.direction, "--steps", String(steps)];
    if (input.package !== undefined) args.push("--package", boundedString(input.package, "package", 256));
    return args;
  }
  if (CONFIRMED_COMMANDS[command]) {
    exactKeys(input, new Set(["command", "machine", "reason", "rollback"]));
    return [...CONFIRMED_COMMANDS[command], ...machineArg(input.machine), ...confirmationArgs(input)];
  }
  if (command === "app.open" || command === "device.start-apk") {
    exactKeys(input, new Set(["command", "machine", "package"]));
    return ["app", "open", ...machineArg(input.machine), "--package", boundedString(input.package, "package", 256)];
  }
  if (command === "app.stop") {
    exactKeys(input, new Set(["command", "machine", "package", "reason", "rollback"]));
    return [
      "app", "stop", ...machineArg(input.machine), "--package", boundedString(input.package, "package", 256),
      ...confirmationArgs(input),
    ];
  }
  if (command === "device.tap-text") {
    exactKeys(input, new Set([
      "command", "machine", "package", "text", "match", "ordinal", "expectText", "expectPackage", "expectResourceId", "reason", "rollback",
    ]));
    const postconditions = [input.expectText, input.expectPackage, input.expectResourceId].filter((value) => value !== undefined);
    if (postconditions.length !== 1) throw new Error("device.tap-text requires exactly one postcondition");
    const args = [
      "device", "tap-text", ...machineArg(input.machine),
      "--text", boundedString(input.text, "text", 1024),
      "--package", boundedString(input.package, "package", 256),
    ];
    if (input.match !== undefined) {
      if (!["exact", "suffix"].includes(input.match)) throw new Error("device.tap-text match is invalid");
      args.push("--match", input.match);
    }
    if (input.ordinal !== undefined) {
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 50) {
        throw new Error("device.tap-text ordinal is invalid");
      }
      args.push("--ordinal", String(input.ordinal));
    }
    if (input.match === "suffix" && input.ordinal === undefined) {
      throw new Error("device.tap-text suffix matching requires ordinal");
    }
    if (input.expectText !== undefined) args.push("--expect-text", boundedString(input.expectText, "expectText", 1024));
    if (input.expectPackage !== undefined) args.push("--expect-package", boundedString(input.expectPackage, "expectPackage", 256));
    if (input.expectResourceId !== undefined) args.push("--expect-resource-id", boundedString(input.expectResourceId, "expectResourceId", 512));
    return [...args, ...confirmationArgs(input)];
  }
  if (command === "device.tap-coords") {
    exactKeys(input, new Set([
      "command", "machine", "package", "x", "y", "expectText", "expectPackage", "expectResourceId",
    ]));
    const postconditions = [input.expectText, input.expectPackage, input.expectResourceId].filter((value) => value !== undefined);
    if (postconditions.length !== 1) throw new Error("device.tap-coords requires exactly one postcondition");
    const args = [
      "device", "tap-coords", ...machineArg(input.machine),
      "--package", boundedString(input.package, "package", 256),
      "--x", percentageArg(input.x, "x"), "--y", percentageArg(input.y, "y"),
    ];
    if (input.expectText !== undefined) args.push("--expect-text", boundedString(input.expectText, "expectText", 1024));
    if (input.expectPackage !== undefined) args.push("--expect-package", boundedString(input.expectPackage, "expectPackage", 256));
    if (input.expectResourceId !== undefined) args.push("--expect-resource-id", boundedString(input.expectResourceId, "expectResourceId", 512));
    return args;
  }
  if (command === "device.tap-ocr") {
    exactKeys(input, new Set([
      "command", "machine", "package", "text", "expectText", "reason", "rollback",
    ]));
    return [
      "device", "tap-ocr", ...machineArg(input.machine),
      "--package", boundedString(input.package, "package", 256),
      "--text", boundedString(input.text, "text", 256),
      "--expect-text", boundedString(input.expectText, "expectText", 256),
      ...confirmationArgs(input),
    ];
  }
  if (command === "device.input") {
    exactKeys(input, new Set(["command", "machine", "package", "text"]));
    return [
      "device", "input", ...machineArg(input.machine),
      "--package", boundedString(input.package, "package", 256),
      "--text", boundedString(input.text, "text", 256),
    ];
  }
  if (command === "device.node.resolve" || command === "device.node.activate") {
    const activate = command === "device.node.activate";
    exactKeys(input, new Set(activate
      ? ["command", "machine", "package", "selector", "expectText", "reason", "rollback"]
      : ["command", "machine", "package", "selector"]));
    const selector = validateDeviceNodeSelector(input.selector);
    const args = [
      "device", activate ? "node-activate" : "node-resolve", ...machineArg(input.machine),
      "--package", boundedString(input.package, "package", 256),
      "--selector-base64", Buffer.from(JSON.stringify(selector), "utf8").toString("base64"),
    ];
    if (activate) {
      args.push("--expect-text", boundedString(input.expectText, "expectText", 256));
      args.push(...confirmationArgs(input));
    }
    return args;
  }
  if (command === "dev.invoke") {
    exactKeys(input, new Set(["command", "action", "machine", "all", "data"]));
    const action = boundedString(input.action, "action", 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(action)) throw new Error("action is invalid");
    if (input.machine !== undefined && input.all === true) throw new Error("Use machine or all, not both");
    const args = ["dev", "invoke", "--action", action];
    if (input.machine !== undefined) args.push(...machineArg(input.machine));
    if (input.all === true) args.push("--all");
    if (input.data !== undefined) {
      if (!plainObject(input.data)) throw new Error("data must be an object");
      const dataJson = JSON.stringify(input.data);
      if (Buffer.byteLength(dataJson, "utf8") > 32 * 1024) throw new Error("data is too large");
      args.push("--data-json", dataJson);
    }
    return args;
  }
  if (command === "private.invoke") {
    exactKeys(input, new Set(["command", "privateCommand", "args"]));
    const privateCommand = boundedString(input.privateCommand, "privateCommand", 64);
    if (!/^[a-z][a-z0-9_]*$/u.test(privateCommand)) throw new Error("privateCommand is invalid");
    const privateArgs = input.args ?? {};
    if (!plainObject(privateArgs)) throw new Error("args must be an object");
    const argsJson = JSON.stringify(privateArgs);
    if (Buffer.byteLength(argsJson, "utf8") > 32 * 1024) throw new Error("args is too large");
    return [
      "dev", "private-invoke", "--command", privateCommand,
      "--args-base64", Buffer.from(argsJson, "utf8").toString("base64"),
    ];
  }
  throw new Error(`Remote command is not implemented: ${command}`);
}

export function commandTimeoutMs(input) {
  if (input?.command === "xhs.find-video") {
    return Math.min(COMMAND_TIMEOUT_MS, (input.maxDurationMs ?? 28_000) + 15_000);
  }
  // Comment draft transactions include IME switches plus slow-device editor
  // rebuild storms; machine 01 alone needs >78s before its reply editor even
  // becomes focus-stable, so the generic 120s cap cuts these commands off.
  if (input?.command === "xhs.comment.input" || input?.command === "xhs.comment.reply-input"
      || input?.command === "xhs.dm.send") {
    return COMMENT_INPUT_TRANSACTION_TIMEOUT_MS;
  }
  if ((input?.command === "device.node.resolve" || input?.command === "device.node.activate")
      && Array.isArray(input?.selector?.sources) && input.selector.sources.includes("vision")) {
    return VISION_NODE_TIMEOUT_MS;
  }
  return COMMAND_TIMEOUT_MS;
}

const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|serial|onlySerial|deviceId|profilePic|alias|path|key)$/iu;
const ARTIFACT_PATH_KEY = /^(screenshot|hierarchy)Path$/u;

function publicArtifactReference(kind, artifactPath) {
  return {
    id: createHash("sha256").update(String(artifactPath), "utf8").digest("hex").slice(0, 24),
    kind,
  };
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!plainObject(value)) return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const artifactMatch = ARTIFACT_PATH_KEY.exec(key);
    if (artifactMatch && typeof entry === "string") {
      result[key] = "[redacted]";
      result[`${artifactMatch[1]}Artifact`] = publicArtifactReference(artifactMatch[1], entry);
    } else {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(entry);
    }
  }
  return result;
}

export function sanitizeCommandOutput(value) {
  const bounded = String(value ?? "").slice(0, MAX_OUTPUT_BYTES);
  try { return JSON.stringify(sanitizeValue(JSON.parse(bounded))); } catch {}
  return bounded
    .replace(/((?:serial|onlySerial|deviceId|token|password|authorization)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(^|\n)([A-Za-z0-9_-]{7,})\s+(device|offline|unauthorized)\b/gu, "$1[redacted] $3");
}

export function extractPublicArtifactReferences(value) {
  const found = new Map();
  function visit(entry) {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!plainObject(entry)) return;
    if (/^[a-f0-9]{24}$/u.test(entry.id) && ["screenshot", "hierarchy"].includes(entry.kind)) {
      found.set(`${entry.kind}:${entry.id}`, { id: entry.id, kind: entry.kind });
    }
    for (const item of Object.values(entry)) visit(item);
  }
  try { visit(typeof value === "string" ? JSON.parse(value) : value); } catch {}
  return [...found.values()];
}

const STRUCTURED_COMMANDS = new Set([
  "device.list", "device.size", "app.list", "device.guide", "device.recent", "device.back", "device.tap-coords", "device.input", "device.node.resolve", "device.node.activate", "device.scroll",
  "wechat.wallet-balance", "xhs.observe", "xhs.find-video", "xhs.open-visible", "xhs.comment.open", "xhs.comment.input", "xhs.comment.reply-input", "xhs.comment.send", "xhs.dm.send",
  "xhs.comment-emoji",
]);
const PAGE_PRESERVING_COMMANDS = new Set([
  "device.list", "device.size", "device.ui", "device.screen", "device.guide", "app.list", "xhs.observe",
]);

function assertExactPublicKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid public shape`);
  }
}

function validatePublicDeviceRecord(value) {
  const keys = ["machine", "name", "online", "transport", "localAdbRequired"];
  assertExactPublicKeys(value, keys, "device.list record");
  if (!/^\d{2}$/u.test(value.machine)
      || typeof value.name !== "string" || !value.name.trim() || value.name.length > 80
      || /[\u0000-\u001f\u007f]/u.test(value.name)
      || typeof value.online !== "boolean"
      || value.transport !== "xiaowei-private-api"
      || value.localAdbRequired !== false) {
    throw new Error("device.list record contains an invalid public value");
  }
  return value;
}

export function parseStructuredReadOutput(command, stdout) {
  if (!STRUCTURED_COMMANDS.has(command)) throw new Error("Command has no structured direct output");
  let value;
  try { value = JSON.parse(String(stdout ?? "")); } catch { throw new Error(`${command} did not return valid JSON`); }
  if (command === "device.list") {
    if (!Array.isArray(value) || value.length > 99) throw new Error("device.list did not return a bounded array");
    const records = value.map(validatePublicDeviceRecord);
    if (new Set(records.map((record) => record.machine)).size !== records.length) {
      throw new Error("device.list returned duplicate machines");
    }
    return records;
  }
  if (command === "device.guide") {
    const keys = ["schemaVersion", "code", "stage", "automatic", "terminal", "next", "stopConditions", "protocol"];
    assertExactPublicKeys(value, keys, "device.guide result");
    if (value.schemaVersion !== 1 || !/^[A-Z][A-Z0-9_]*$/u.test(value.code)
        || !["preflight", "observe", "resolve", "recheck", "execute", "verify", "transport"].includes(value.stage)
        || typeof value.automatic !== "boolean" || typeof value.terminal !== "boolean"
        || !Array.isArray(value.next) || value.next.length > 8
        || !Array.isArray(value.stopConditions) || value.stopConditions.length > 8
        || value.protocol !== "observe_resolve_recheck_execute_verify") {
      throw new Error("device.guide contains an invalid public value");
    }
    for (const entry of value.next) {
      assertExactPublicKeys(entry, ["strategy", "status", "readCommand", "writeCommand"], "device.guide strategy");
      if (!/^[A-Z][A-Z0-9_]*$/u.test(entry.strategy)
          || !["implemented", "not_implemented"].includes(entry.status)
          || !(entry.readCommand === null || /^device\.[a-z.-]+$/u.test(entry.readCommand))
          || !(entry.writeCommand === null || /^device\.[a-z.-]+$/u.test(entry.writeCommand))) {
        throw new Error("device.guide strategy contains an invalid public value");
      }
    }
    if (value.stopConditions.some((entry) => typeof entry !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(entry))) {
      throw new Error("device.guide stop condition is invalid");
    }
    return value;
  }
  if (command === "device.node.resolve" || command === "device.node.activate") {
    const nodeKeys = ["label", "role", "group", "ordinal", "source", "unique"];
    assertExactPublicKeys(value.node, nodeKeys, "device.node result node");
    if (typeof value.node.label !== "string" || !value.node.label.trim() || value.node.label.length > 256
        || !["control", "tab", "button", "item"].includes(value.node.role)
        || !(value.node.group === null || value.node.group === "bottom_navigation")
        || !(value.node.ordinal === null || (Number.isSafeInteger(value.node.ordinal) && value.node.ordinal >= 1 && value.node.ordinal <= 12))
        || !["accessibility", "ocr", "relation", "vision"].includes(value.node.source) || value.node.unique !== true
        || !/^\d{2}$/u.test(value.machine) || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.node result contains an invalid public value");
    }
    if (command === "device.node.resolve") {
      assertExactPublicKeys(value, ["machine", "status", "node", "evidence", "transport", "localAdbRequired"], "device.node.resolve result");
      assertExactPublicKeys(value.evidence, ["foregroundPackageVerified", "freshObservations", "coordinateExposed"], "device.node.resolve evidence");
      if (value.status !== "resolved" || value.evidence.foregroundPackageVerified !== true
          || value.evidence.freshObservations !== 2 || value.evidence.coordinateExposed !== false) {
        throw new Error("device.node.resolve evidence is invalid");
      }
    } else {
      assertExactPublicKeys(value, ["machine", "status", "node", "verification", "transport", "localAdbRequired"], "device.node.activate result");
      if (value.status !== "verified"
          || value.verification !== "node_rechecked_then_single_pointer_event_then_fresh_postcondition") {
        throw new Error("device.node.activate verification is invalid");
      }
    }
    return value;
  }
  if (command === "device.input") {
    assertExactPublicKeys(value, ["machine", "status", "verification", "transport", "localAdbRequired"], "device.input result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !["exact_focused_editor_ui_echo_after_ime_restore", "exact_local_ocr_echo_after_ime_restore"].includes(value.verification)
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.input contains an invalid public value");
    }
    return value;
  }
  if (command === "device.back") {
    assertExactPublicKeys(value, ["machine", "status", "verification", "transport", "localAdbRequired"], "device.back result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !["single_back_event_then_fresh_screen_change", "single_back_event_then_focused_window_change"].includes(value.verification)
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.back contains an invalid public value");
    }
    return value;
  }
  if (command === "device.recent") {
    assertExactPublicKeys(value, ["machine", "status", "verification", "transport", "localAdbRequired"], "device.recent result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || value.verification !== "single_recent_event_then_fresh_ui_change"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.recent contains an invalid public value");
    }
    return value;
  }
  if (command === "device.tap-coords") {
    assertExactPublicKeys(value, ["machine", "status", "verification", "transport", "localAdbRequired"], "device.tap-coords result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || value.verification !== "source_package_fast_rechecked_then_single_pointer_event_then_fresh_postcondition"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.tap-coords contains an invalid public value");
    }
    return value;
  }
  if (command === "device.scroll") {
    assertExactPublicKeys(value, ["machine", "status", "direction", "steps", "verification", "transport", "localAdbRequired"], "device.scroll result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !["down", "up", "left", "right"].includes(value.direction)
        || !Number.isSafeInteger(value.steps) || value.steps < 1 || value.steps > 5
        || !["scrollable_container_rechecked_then_directional_events_then_fresh_ui_change", "foreground_rechecked_then_horizontal_events_then_fresh_screen_change"].includes(value.verification)
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("device.scroll contains an invalid public value");
    }
    return value;
  }
  if (command === "app.list") {
    assertExactPublicKeys(value, ["machine", "packages", "transport", "localAdbRequired"], "app.list result");
    if (!/^\d{2}$/u.test(value.machine) || !Array.isArray(value.packages) || value.packages.length < 1
        || value.packages.length > 20_000 || new Set(value.packages).size !== value.packages.length
        || value.packages.some((entry) => typeof entry !== "string" || entry.length > 255
          || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(entry))
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("app.list contains an invalid public value");
    }
    return value;
  }
  if (command === "wechat.wallet-balance") {
    const keys = ["machine", "currency", "balance", "transport", "localAdbRequired"];
    assertExactPublicKeys(value, keys, "wechat.wallet-balance result");
    if (!/^\d{2}$/u.test(value.machine) || value.currency !== "CNY"
        || !/^(?:0|[1-9]\d{0,11})\.\d{2}$/u.test(value.balance)
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("wechat.wallet-balance contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.observe") {
    validateXhsObservation(value);
    return value;
  }
  if (command === "xhs.find-video") {
    assertExactPublicKeys(value, [
      "machine", "status", "page", "note", "ordinal", "scrolls", "elapsedMs", "verification", "transport", "localAdbRequired",
    ], "xhs.find-video result");
    if (!/^\d{2}$/u.test(value.machine) || !["found", "not_found"].includes(value.status)
        || !Number.isSafeInteger(value.scrolls) || value.scrolls < 0 || value.scrolls > 10
        || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 120_000
        || value.verification !== "fresh_home_feed_ui_after_each_scroll"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.find-video contains an invalid public value");
    }
    assertExactPublicKeys(value.page, ["state", "score", "margin"], "xhs.find-video page");
    if (value.page.state !== "HOME_FEED" || !Number.isFinite(value.page.score) || !Number.isFinite(value.page.margin)
        || value.page.score < 0 || value.page.margin < 0) {
      throw new Error("xhs.find-video page is invalid");
    }
    if (value.status === "found") {
      validateXhsNote(value.note, "xhs.find-video note");
      if (value.note.mediaType !== "video" || value.ordinal !== value.note.ordinal) {
        throw new Error("xhs.find-video found result is inconsistent");
      }
    } else if (value.note !== null || value.ordinal !== null) {
      throw new Error("xhs.find-video not-found result is inconsistent");
    }
    return value;
  }
  if (command === "xhs.open-visible") {
    validateXhsObservation(value, true);
    return value;
  }
  if (command === "xhs.comment-emoji") {
    assertExactPublicKeys(value, [
      "machine", "status", "beforeCount", "afterCount", "verification", "transport", "localAdbRequired",
    ], "xhs.comment-emoji result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !Number.isSafeInteger(value.beforeCount) || value.beforeCount < 0
        || !Number.isSafeInteger(value.afterCount) || value.afterCount <= value.beforeCount
        || value.verification !== "emoji_selected_then_package_bound_send_then_comment_count_increment_and_draft_clear"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.comment-emoji contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.comment.open") {
    assertExactPublicKeys(value, [
      "machine", "status", "commentCount", "target", "editorStateHash", "verification", "transport", "localAdbRequired",
    ], "xhs.comment.open result");
    assertExactPublicKeys(value.target, ["title", "author", "mediaType"], "xhs.comment.open target");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !Number.isSafeInteger(value.commentCount) || value.commentCount < 0
        || typeof value.target.title !== "string" || !value.target.title.trim() || value.target.title.length > 512
        || typeof value.target.author !== "string" || !value.target.author.trim() || value.target.author.length > 256
        || !["image", "video"].includes(value.target.mediaType)
        || typeof value.editorStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.editorStateHash)
        || value.verification !== "comment_box_rechecked_then_single_activation_then_editor_verified"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.comment.open contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.comment.input") {
    assertExactPublicKeys(value, [
      "machine", "status", "inputMethod", "draftLength", "verification", "transport", "localAdbRequired",
    ], "xhs.comment.input result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !["shortcut", "ime"].includes(value.inputMethod)
        || !Number.isSafeInteger(value.draftLength) || value.draftLength < 1 || value.draftLength > 256
        || value.verification !== "xhs_comment_draft_exact_ui_echo"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.comment.input contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.comment.reply-input") {
    assertExactPublicKeys(value, [
      "machine", "status", "inputMethod", "draftLength", "commentCount", "editorStateHash", "replyOrdinal",
      "verification", "transport", "localAdbRequired",
    ], "xhs.comment.reply-input result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !["shortcut", "ime"].includes(value.inputMethod)
        || !Number.isSafeInteger(value.draftLength) || value.draftLength < 1 || value.draftLength > 256
        || !Number.isSafeInteger(value.commentCount) || value.commentCount < 0
        || typeof value.editorStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.editorStateHash)
        || !Number.isSafeInteger(value.replyOrdinal) || value.replyOrdinal < 1 || value.replyOrdinal > 50
        || value.verification !== "reply_target_rechecked_then_editor_recovered_after_ime_then_bound_draft_echo"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.comment.reply-input contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.comment.send") {
    assertExactPublicKeys(value, [
      "machine", "status", "beforeCount", "afterCount", "verification", "transport", "localAdbRequired",
    ], "xhs.comment.send result");
    if (!/^\d{2}$/u.test(value.machine) || value.status !== "verified"
        || !Number.isSafeInteger(value.beforeCount) || value.beforeCount < 0
        || !Number.isSafeInteger(value.afterCount) || value.afterCount <= value.beforeCount
        || value.verification !== "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear"
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.comment.send contains an invalid public value");
    }
    return value;
  }
  if (command === "xhs.dm.send") {
    assertExactPublicKeys(value, [
      "machine", "status", "draftLength", "verification", "transport", "localAdbRequired",
    ], "xhs.dm.send result");
    const dmSendOutcomes = {
      verified: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_and_message_echo",
      mitigated: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_without_message_echo",
    };
    if (!/^\d{2}$/u.test(value.machine)
        || !Number.isSafeInteger(value.draftLength) || value.draftLength < 1 || value.draftLength > 256
        || dmSendOutcomes[value.status] !== value.verification
        || value.transport !== "xiaowei-api" || value.localAdbRequired !== false) {
      throw new Error("xhs.dm.send contains an invalid public value");
    }
    return value;
  }
  const keys = ["machine", "width", "height", "transport", "localAdbRequired"];
  assertExactPublicKeys(value, keys, "device.size result");
  if (!/^\d{2}$/u.test(value.machine)
      || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 16_384 || value.height > 16_384
      || value.transport !== "xiaowei-private-api" || value.localAdbRequired !== false) {
    throw new Error("device.size contains an invalid public value");
  }
  return value;
}

function optionalPublicText(value, maximum) {
  return value === null || (typeof value === "string" && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value));
}

function validateMetricSet(value) {
  if (!plainObject(value) || Object.keys(value).length > 8) throw new Error("xhs.observe metric set is invalid");
  for (const entry of Object.values(value)) {
    if (!optionalPublicText(entry, 80)) throw new Error("xhs.observe metric value is invalid");
  }
}

function validateXhsNote(note, label = "xhs.observe note") {
  const noteKeys = Object.hasOwn(note, "noteId")
    ? ["noteId", "title", "author", "mediaType", "metrics", "ordinal"]
    : ["title", "author", "mediaType", "metrics", "ordinal"];
  assertExactPublicKeys(note, noteKeys, label);
  if (!optionalPublicText(note.title, 300) || !note.title || !optionalPublicText(note.author, 120) || !note.author
      || !["image", "video"].includes(note.mediaType)
      || !Number.isSafeInteger(note.ordinal) || note.ordinal < 1 || note.ordinal > 20
      || (Object.hasOwn(note, "noteId") && !/^[0-9a-f]{16,32}$/iu.test(note.noteId))) {
    throw new Error(`${label} is invalid`);
  }
  validateMetricSet(note.metrics);
}

function validateXhsObservation(value, opened = false) {
  const keys = [
    "machine", ...(opened ? ["selected"] : []), "page", "notes", "detail", "profile", "visibleLabels", "stability",
    ...(opened ? ["verification"] : []), "transport", "localAdbRequired",
  ];
  assertExactPublicKeys(value, keys, "xhs.observe result");
  if (!/^\d{2}$/u.test(value.machine) || value.transport !== "xiaowei-api"
      || value.localAdbRequired !== false
      || (opened ? value.stability !== "single_fresh_matching_detail_ui"
        : !["two_fresh_ui_intersection", "single_fresh_video_detail_ui"].includes(value.stability))) {
    throw new Error("xhs.observe contains an invalid public value");
  }
  if (opened) {
    assertExactPublicKeys(value.selected, ["ordinal", "title", "author", "mediaType"], "xhs.open-visible selected note");
    if (!Number.isSafeInteger(value.selected.ordinal) || value.selected.ordinal < 1 || value.selected.ordinal > 20
        || !optionalPublicText(value.selected.title, 300) || !value.selected.title
        || !optionalPublicText(value.selected.author, 120) || !value.selected.author
        || !["image", "video"].includes(value.selected.mediaType)
        || value.verification !== "single_pointer_event_then_fresh_matching_detail_ui") {
      throw new Error("xhs.open-visible contains an invalid public value");
    }
  }
  assertExactPublicKeys(value.page, ["state", "score", "margin"], "xhs.observe page");
  if (!["HOME_FEED", "SEARCH_ENTRY", "SEARCH_SUGGESTIONS", "SEARCH_RESULTS", "TRENDING", "RECOMMENDED",
    "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL", "PROFILE"].includes(value.page.state)
      || !Number.isFinite(value.page.score) || !Number.isFinite(value.page.margin)
      || value.page.score < 0 || value.page.margin < 0) {
    throw new Error("xhs.observe page is invalid");
  }
  if (value.stability === "single_fresh_video_detail_ui" && value.page.state !== "VIDEO_NOTE") {
    throw new Error("xhs.observe single-read stability is limited to video detail pages");
  }
  if (!Array.isArray(value.notes) || value.notes.length > 20) throw new Error("xhs.observe notes are invalid");
  for (const note of value.notes) validateXhsNote(note);
  if (!Array.isArray(value.visibleLabels) || value.visibleLabels.length > 40
      || value.visibleLabels.some((label) => !optionalPublicText(label, 300) || !label)) {
    throw new Error("xhs.observe labels are invalid");
  }
  if (value.detail !== null) {
    assertExactPublicKeys(value.detail, ["title", "author", "body", "publishedAtOrRegion", "media", "metrics"], "xhs.observe detail");
    if (!optionalPublicText(value.detail.title, 300) || !optionalPublicText(value.detail.author, 120)
        || !optionalPublicText(value.detail.body, 1_000)
        || !optionalPublicText(value.detail.publishedAtOrRegion, 80)) throw new Error("xhs.observe detail is invalid");
    if (value.detail.media !== null) {
      assertExactPublicKeys(value.detail.media, ["type", "count"], "xhs.observe detail media");
      if (!["image", "video"].includes(value.detail.media.type)
          || !Number.isSafeInteger(value.detail.media.count) || value.detail.media.count < 1 || value.detail.media.count > 100) {
        throw new Error("xhs.observe detail media is invalid");
      }
    }
    validateMetricSet(value.detail.metrics);
  }
  if (value.profile !== null) {
    assertExactPublicKeys(value.profile, ["name", "bio", "metrics"], "xhs.observe profile");
    if (!optionalPublicText(value.profile.name, 120) || !optionalPublicText(value.profile.bio, 500)) {
      throw new Error("xhs.observe profile is invalid");
    }
    validateMetricSet(value.profile.metrics);
  }
}

function sourceIdentity(request) {
  const login = request.headers["tailscale-user-login"];
  const capabilities = request.headers["tailscale-app-capabilities"];
  if (typeof login === "string" && login.length > 0 && login.length <= 512) return { kind: "tailscale_user", value: login };
  if (typeof capabilities === "string" && capabilities.length > 0 && capabilities.length <= 8_192) return { kind: "tailscale_capability", value: "granted" };
  return null;
}

function jsonResponse(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function readJsonBody(request) {
  const contentTypeParts = String(request.headers["content-type"] ?? "").split(";").map((part) => part.trim().toLowerCase());
  if (contentTypeParts[0] !== "application/json") throw new Error("Content-Type must be application/json");
  const charset = contentTypeParts.slice(1).find((part) => part.startsWith("charset="));
  if (charset && charset !== "charset=utf-8" && charset !== "charset=utf8") {
    throw new Error("JSON command bodies must use UTF-8");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new Error("JSON command bodies must contain valid UTF-8"); }
  try { return JSON.parse(decoded); } catch { throw new Error("Request body is not valid JSON"); }
}

function runXhs(argv, runtime = {}) {
  const spawnImpl = runtime.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const gatewayKey = randomBytes(32);
    const child = spawnImpl(process.execPath, [path.join(SCRIPT_DIR, "xhs-agent.mjs"), ...argv], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, XHS_XIAOWEI_GATEWAY_KEY: gatewayKey.toString("base64") },
    });
    gatewayKey.fill(0);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_OUTPUT_BYTES) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, runtime.timeoutMs ?? COMMAND_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : 1,
        timedOut,
        truncated: outputBytes > MAX_OUTPUT_BYTES,
        stdout: sanitizeCommandOutput(Buffer.concat(stdout).toString("utf8")),
        stderr: sanitizeCommandOutput(Buffer.concat(stderr).toString("utf8")),
      });
    });
  });
}

function audit(event) {
  mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  appendFileSync(AUDIT_PATH, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

function safeSecretEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function loopbackRequest(request) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress);
}

function lifecycleIdentity(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export function gatewayScheduleScope(input) {
  return typeof input?.machine === "string" && /^\d{2}$/u.test(input.machine)
    ? `machine:${input.machine}`
    : "global";
}

export function createGatewayScheduler(options = {}) {
  const maximumDepth = options.maximumDepth ?? 16;
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 256) {
    throw new Error("Gateway scheduler depth is invalid");
  }
  const pending = [];
  const activeMachines = new Map();
  const idleWaiters = new Set();
  let globalActive = false;
  let depth = 0;

  function settleIdle() {
    if (depth !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function start(job) {
    job.startedAt = new Date().toISOString();
    if (job.scope === "global") globalActive = job;
    else activeMachines.set(job.scope, job);
    Promise.resolve()
      .then(job.work)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (job.scope === "global") globalActive = false;
        else activeMachines.delete(job.scope);
        depth -= 1;
        settleIdle();
        pump();
      });
  }

  function pump() {
    if (globalActive || pending.length === 0) return;
    if (activeMachines.size === 0 && pending[0].scope === "global") {
      start(pending.shift());
      return;
    }
    for (let index = 0; index < pending.length;) {
      const job = pending[index];
      if (job.scope === "global") break;
      if (activeMachines.has(job.scope)) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      start(job);
    }
  }

  return Object.freeze({
    enqueue(scope, work, metadata = {}) {
      if (scope !== "global" && !/^machine:\d{2}$/u.test(scope)) throw new Error("Gateway scheduler scope is invalid");
      if (typeof work !== "function") throw new Error("Gateway scheduler work is invalid");
      if (!plainObject(metadata)) throw new Error("Gateway scheduler metadata is invalid");
      if (depth >= maximumDepth) throw new Error("Remote command queue is full");
      depth += 1;
      const result = new Promise((resolve, reject) => pending.push({
        scope, work, resolve, reject,
        metadata: sanitizeValue(metadata),
        queuedAt: new Date().toISOString(),
        startedAt: null,
      }));
      pump();
      return result;
    },
    whenIdle() {
      if (depth === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    get depth() { return depth; },
    snapshot() {
      const describe = (job) => ({
        scope: job.scope,
        ...job.metadata,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
      });
      return {
        active: [
          ...(globalActive ? [describe(globalActive)] : []),
          ...[...activeMachines.values()].map(describe),
        ],
        waiting: pending.map(describe),
      };
    },
    get activeRequests() { return activeMachines.size + (globalActive ? 1 : 0); },
    get waitingDepth() { return pending.length; },
  });
}

export function createRemoteGateway(options = {}) {
  const execute = options.execute ?? runXhs;
  const auditImpl = options.audit ?? audit;
  const requireIdentity = options.requireIdentity ?? process.env.XHS_REMOTE_REQUIRE_IDENTITY === "true";
  const buildId = lifecycleIdentity(options.buildId ?? GATEWAY_BUILD_ID, "buildId", /^[a-f0-9]{64}$/u);
  const bootId = lifecycleIdentity(options.bootId ?? GATEWAY_BOOT_ID, "bootId", /^[a-f0-9-]{36}$/u);
  const controlToken = options.controlToken ?? process.env.XHS_REMOTE_GATEWAY_CONTROL_TOKEN ?? null;
  if (controlToken !== null) lifecycleIdentity(controlToken, "controlToken", /^[A-Za-z0-9+/_=-]{32,256}$/u);
  const scheduler = options.scheduler ?? createGatewayScheduler();
  const deviceStates = new Map();
  let accepting = true;
  let shutdownScheduled = false;

  function deviceState(machine) {
    if (!deviceStates.has(machine)) {
      deviceStates.set(machine, {
        machine,
        name: null,
        online: null,
        lastKnownPage: null,
        lastCompleted: null,
        latestArtifacts: [],
      });
    }
    return deviceStates.get(machine);
  }

  function publicRuntimeStatus() {
    const schedule = scheduler.snapshot();
    const activeByMachine = new Map();
    const waitingByMachine = new Map();
    for (const job of schedule.active) {
      if (job.machine) {
        deviceState(job.machine);
        activeByMachine.set(job.machine, job);
      }
    }
    for (const job of schedule.waiting) {
      if (!job.machine) continue;
      deviceState(job.machine);
      if (!waitingByMachine.has(job.machine)) waitingByMachine.set(job.machine, []);
      waitingByMachine.get(job.machine).push(job);
    }
    return {
      ok: true,
      service: "xhs-remote-gateway",
      observedAt: new Date().toISOString(),
      accepting,
      queueDepth: scheduler.depth,
      activeRequests: scheduler.activeRequests,
      active: schedule.active,
      waiting: schedule.waiting,
      devices: [...deviceStates.values()]
        .sort((left, right) => left.machine.localeCompare(right.machine))
        .map((state) => ({
          ...state,
          active: activeByMachine.get(state.machine) ?? null,
          waiting: waitingByMachine.get(state.machine) ?? [],
        })),
    };
  }

  function updateDeviceState(body, requestId, startedAt, completedAt, result, parsed) {
    const artifacts = extractPublicArtifactReferences(result?.stdout);
    if (body.command === "device.list" && Array.isArray(parsed)) {
      for (const record of parsed) {
        const state = deviceState(record.machine);
        state.name = record.name;
        state.online = record.online;
      }
      return artifacts;
    }
    if (typeof body.machine !== "string") return artifacts;
    const state = deviceState(body.machine);
    state.lastCompleted = {
      requestId,
      command: body.command,
      startedAt,
      completedAt,
      outcome: result.code === 0 ? "success" : "failed",
    };
    if (artifacts.length) state.latestArtifacts = artifacts;
    if (!PAGE_PRESERVING_COMMANDS.has(body.command) && state.lastKnownPage) {
      state.lastKnownPage = { ...state.lastKnownPage, stale: true };
    }
    if (result.code === 0 && parsed?.page?.state) {
      state.lastKnownPage = {
        state: parsed.page.state,
        observedAt: completedAt,
        requestId,
        source: body.command,
        stale: false,
      };
    }
    return artifacts;
  }

  let server;
  function drainAndClose() {
    if (shutdownScheduled) return;
    shutdownScheduled = true;
    accepting = false;
    const close = () => server.close(() => options.onShutdown?.());
    scheduler.whenIdle().then(close, close);
  }

  server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    if (request.method === "GET" && request.url === "/health") {
      jsonResponse(response, 200, {
        ok: true,
        service: "xhs-remote-gateway",
        queueDepth: scheduler.depth,
        activeRequests: scheduler.activeRequests,
        accepting,
        buildId,
        bootId,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/status") {
      jsonResponse(response, 200, publicRuntimeStatus());
      return;
    }
    if (request.method === "POST" && request.url === "/admin/drain-and-shutdown") {
      const authorization = request.headers.authorization;
      const authorized = controlToken !== null && loopbackRequest(request)
        && typeof authorization === "string"
        && safeSecretEqual(authorization, `Bearer ${controlToken}`);
      if (!authorized) {
        jsonResponse(response, 404, { ok: false, requestId, error: "not_found" });
        return;
      }
      accepting = false;
      response.setHeader("connection", "close");
      jsonResponse(response, 202, { ok: true, draining: true, bootId });
      setImmediate(drainAndClose);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/command") {
      jsonResponse(response, 404, { ok: false, requestId, error: "not_found" });
      return;
    }
    if (!accepting) {
      jsonResponse(response, 503, { ok: false, requestId, error: "gateway_draining" });
      return;
    }
    let identity = sourceIdentity(request);
    if (!identity && requireIdentity) {
      jsonResponse(response, 401, { ok: false, requestId, error: "tailscale_identity_required" });
      return;
    }
    if (!identity) identity = { kind: "tailnet_or_local_unidentified", value: "development_unrestricted" };
    let body;
    let argv;
    try {
      body = await readJsonBody(request);
      argv = buildRemoteArgv(body);
    } catch (error) {
      jsonResponse(response, 400, { ok: false, requestId, error: error.message });
      return;
    }
    if (!accepting) {
      jsonResponse(response, 503, { ok: false, requestId, error: "gateway_draining" });
      return;
    }
    const startedAt = new Date().toISOString();
    try {
      const result = await scheduler.enqueue(
        gatewayScheduleScope(body),
        () => execute(argv, { timeoutMs: commandTimeoutMs(body) }),
        { requestId, command: body.command, machine: body.machine ?? null },
      );
      const completedAt = new Date().toISOString();
      let parsed = null;
      if (result.code === 0 && STRUCTURED_COMMANDS.has(body.command)) {
        try {
          parsed = parseStructuredReadOutput(body.command, result.stdout);
          const artifactRefs = updateDeviceState(body, requestId, startedAt, completedAt, result, parsed);
          auditImpl({
            requestId, startedAt, completedAt, source: identity, command: body.command,
            machine: body.machine ?? null, exitCode: result.code, artifactRefs,
          });
          jsonResponse(response, 200, parsed);
        } catch {
          auditImpl({
            requestId, startedAt, completedAt, source: identity, command: body.command,
            machine: body.machine ?? null, exitCode: result.code, parseError: "invalid_structured_read_output",
          });
          jsonResponse(response, 502, { ok: false, requestId, error: "invalid_structured_read_output" });
        }
        return;
      }
      const artifactRefs = updateDeviceState(body, requestId, startedAt, completedAt, result, parsed);
      auditImpl({
        requestId, startedAt, completedAt, source: identity, command: body.command,
        machine: body.machine ?? null, exitCode: result.code, artifactRefs,
      });
      jsonResponse(response, result.code === 0 ? 200 : 502, { ok: result.code === 0, requestId, ...result });
    } catch (error) {
      const completedAt = new Date().toISOString();
      if (typeof body.machine === "string") {
        const state = deviceState(body.machine);
        state.lastCompleted = {
          requestId, command: body.command, startedAt, completedAt, outcome: "failed",
        };
      }
      auditImpl({
        requestId, startedAt, completedAt, source: identity, command: body.command,
        machine: body.machine ?? null, error: error.message,
      });
      jsonResponse(response, 503, { ok: false, requestId, error: error.message });
    }
  });
  return server;
}

export function startRemoteGateway(options = {}) {
  const host = options.host ?? process.env.XHS_REMOTE_GATEWAY_HOST ?? DEFAULT_HOST;
  const port = Number(options.port ?? process.env.XHS_REMOTE_GATEWAY_PORT ?? DEFAULT_PORT);
  if (host !== "127.0.0.1") throw new Error("Remote gateway must listen on 127.0.0.1");
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Remote gateway port is invalid");
  const server = createRemoteGateway({
    ...options,
    onShutdown: options.onShutdown ?? (() => process.exit(0)),
  });
  server.listen(port, host, () => process.stdout.write(`xhs remote gateway listening on http://${host}:${port}\n`));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--print-build-id") {
    process.stdout.write(`${GATEWAY_BUILD_ID}\n`);
  } else if (process.argv.length === 2) {
    startRemoteGateway();
  } else {
    throw new Error("Unknown gateway startup argument");
  }
}
