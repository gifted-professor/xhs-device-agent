import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { open, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listXiaoweiActions } from "./xiaowei-action-catalog.mjs";
import { POWERSHELL_EXECUTABLE } from "./powershell-runtime.mjs";
import { createXiaoweiClient } from "./xiaowei-client.mjs";
import { sendXiaoweiRequest } from "./xiaowei-transport.mjs";

const HELP = `Xiaowei API internal capability tool

  node scripts/xiaowei-api.mjs catalog
  node scripts/xiaowei-api.mjs dev-invoke --development-mode --request-file <file>

The unified public entry is .\\xhs.cmd. Device actions are routed through its
policy and verification layer. The dev-invoke command is an explicit local
development escape hatch and is not part of the ordinary operator surface.
`;

const INTERNAL_OPERATOR_ACTIONS = new Set(["screen", "pushEvent", "apkList", "startApk", "stopApk"]);
const SAFE_PUBLIC_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_GATEWAY_PARENTS = Object.freeze({
  list: Object.freeze([
    path.join(SCRIPT_DIRECTORY, "Invoke-MatrixAction.ps1"),
    path.join(SCRIPT_DIRECTORY, "Matrix-Preflight.ps1"),
  ]),
  invoke: Object.freeze([path.join(SCRIPT_DIRECTORY, "Invoke-MatrixAction.ps1")]),
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function commandLineRunsExactScript(commandLine, scriptPath) {
  if (typeof commandLine !== "string" || !commandLine) return false;
  const normalizedCommandLine = commandLine.replaceAll("/", "\\");
  const normalizedScriptPath = path.resolve(scriptPath).replaceAll("/", "\\");
  const escapedPath = escapeRegExp(normalizedScriptPath);
  return new RegExp(`(?:^|\\s)-File\\s+(?:"${escapedPath}"|'${escapedPath}'|${escapedPath})(?=\\s|$)`, "iu")
    .test(normalizedCommandLine);
}

function inspectWindowsParentProcess(parentPid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(parentPid) || parentPid <= 0) return null;
  const query = [
    "$ErrorActionPreference='Stop'",
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8`,
    `$p=Get-CimInstance -ClassName Win32_Process -Filter \"ProcessId = ${parentPid}\"`,
    "if(!$p){exit 3}",
    "[Console]::Out.Write([string]$p.Name)",
    "[Console]::Out.Write([char]0)",
    "[Console]::Out.Write([string]$p.CommandLine)",
  ].join(";");
  const result = spawnSync(POWERSHELL_EXECUTABLE, ["-NoProfile", "-NonInteractive", "-Command", query], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  const separator = result.stdout.indexOf("\0");
  if (separator < 1) return null;
  return Object.freeze({
    name: result.stdout.slice(0, separator).trim(),
    commandLine: result.stdout.slice(separator + 1),
  });
}

async function requireTrustedGatewayParent(command, runtime) {
  const trustedScripts = TRUSTED_GATEWAY_PARENTS[command] ?? [];
  const inspectParentProcess = runtime.inspectParentProcess ?? inspectWindowsParentProcess;
  const parent = await inspectParentProcess(process.ppid);
  const trusted = new Set(["powershell.exe", "pwsh.exe"]).has(parent?.name?.toLowerCase())
    && trustedScripts.some((scriptPath) => commandLineRunsExactScript(parent.commandLine, scriptPath));
  if (!trusted) {
    throw new Error("Xiaowei internal gateway requires the canonical unified PowerShell wrapper");
  }
}

function parseInternalOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--internal-gateway") {
      options.internalGateway = true;
      continue;
    }
    if (!new Set(["--request-file", "--grant-file", "--result-file"]).has(token)) {
      throw new Error(`Unknown Xiaowei internal option: ${token}`);
    }
    index += 1;
    if (index >= argv.length) throw new Error(`${token} requires a path`);
    const key = token === "--request-file" ? "requestFile" : token === "--grant-file" ? "grantFile" : "resultFile";
    if (options[key]) throw new Error(`${token} may be provided only once`);
    options[key] = String(argv[index]);
  }
  return options;
}

function parseDevelopmentOptions(argv) {
  const options = {};
  const allowed = new Set(["--development-mode", "--request-file", "--endpoint"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!allowed.has(token)) throw new Error(`Unknown Xiaowei development option: ${token}`);
    if (token === "--development-mode") {
      if (options.developmentMode) throw new Error("--development-mode may be provided only once");
      options.developmentMode = true;
      continue;
    }
    index += 1;
    if (index >= argv.length || String(argv[index]).startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    const key = token === "--request-file" ? "requestFile" : "endpoint";
    if (options[key]) throw new Error(`${token} may be provided only once`);
    options[key] = String(argv[index]);
  }
  return options;
}

async function readDevelopmentRequest(filePath) {
  if (!filePath) throw new Error("Xiaowei development request file is required");
  const source = await readFile(filePath);
  if (source.byteLength > 1024 * 1024) throw new Error("Xiaowei development request is too large");
  let request;
  try { request = JSON.parse(source.toString("utf8")); } catch { throw new Error("Xiaowei development request is not valid JSON"); }
  if (!isPlainObject(request)) throw new Error("Xiaowei development request must be a JSON object");
  return request;
}

async function resolveTemporaryOutputPath(filePath) {
  if (!filePath) throw new Error("Internal Xiaowei result file is required");
  const [resolvedParent, resolvedTemp] = await Promise.all([realpath(path.dirname(filePath)), realpath(os.tmpdir())]);
  const relative = path.relative(resolvedTemp, resolvedParent);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.basename(filePath) !== filePath.slice(filePath.lastIndexOf(path.sep) + 1)) {
    throw new Error("Internal Xiaowei result files must be under the operating-system temporary directory");
  }
  return path.join(resolvedParent, path.basename(filePath));
}

async function reserveTemporaryJson(filePath) {
  const resolvedFile = await resolveTemporaryOutputPath(filePath);
  const handle = await open(resolvedFile, "wx", 0o600);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return {
    async write(value) {
      const source = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(source, "utf8") > 4 * 1024 * 1024) {
        await close();
        throw new Error("Internal Xiaowei result is too large");
      }
      try {
        await handle.writeFile(source, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await close();
      }
    },
    async discard() {
      try { await close(); } finally { await rm(resolvedFile, { force: true }); }
    },
  };
}

function markResultWriteUnknown(error, action) {
  const result = error && typeof error === "object" ? error : new Error(String(error));
  result.outcome = "unknown";
  result.sent = true;
  result.action = action;
  return result;
}

async function readTemporaryJsonDocument(filePath, maxBytes) {
  if (!filePath) throw new Error("Internal Xiaowei gateway file is required");
  const [resolvedFile, resolvedTemp] = await Promise.all([realpath(filePath), realpath(os.tmpdir())]);
  const relative = path.relative(resolvedTemp, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Internal Xiaowei gateway files must be under the operating-system temporary directory");
  }
  const source = await readFile(resolvedFile);
  if (source.byteLength > maxBytes) throw new Error("Internal Xiaowei gateway file is too large");
  let value;
  try { value = JSON.parse(source.toString("utf8")); } catch { throw new Error("Internal Xiaowei gateway file is not valid JSON"); }
  return Object.freeze({ value, source });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string" && expected.includes(key));
}

function invalidCapabilityGrant() {
  throw new Error("Internal Xiaowei capability grant is invalid");
}

function decodeCanonicalBase64(value, maximumLength) {
  if (typeof value !== "string" || !value || value.length > maximumLength
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    invalidCapabilityGrant();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) invalidCapabilityGrant();
  return decoded;
}

function validateCapabilityGrant(envelope, requestDocument, gatewayKeySource, now = Date.now()) {
  if (!hasExactKeys(envelope, ["schemaVersion", "payload", "mac"])
      || envelope.schemaVersion !== 1 || typeof envelope.mac !== "string"
      || !SHA256_HEX.test(envelope.mac)) {
    invalidCapabilityGrant();
  }
  const gatewayKey = decodeCanonicalBase64(gatewayKeySource, 64);
  if (gatewayKey.byteLength !== 32) {
    gatewayKey.fill(0);
    invalidCapabilityGrant();
  }
  let expectedMac;
  try {
    expectedMac = createHmac("sha256", gatewayKey).update(envelope.payload, "utf8").digest();
  } finally {
    gatewayKey.fill(0);
  }
  const suppliedMac = Buffer.from(envelope.mac, "hex");
  if (suppliedMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(suppliedMac, expectedMac)) {
    invalidCapabilityGrant();
  }
  const payloadBytes = decodeCanonicalBase64(envelope.payload, 64 * 1024);
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { invalidCapabilityGrant(); }
  if (!hasExactKeys(payload, [
    "action", "deviceAlias", "deviceSerial", "xiaoweiVersion", "endpoint",
    "requestSha256", "issuedAt", "expiresAt", "authorization",
  ])) {
    invalidCapabilityGrant();
  }
  if (typeof payload.action !== "string"
      || !SAFE_PUBLIC_ALIAS.test(payload.deviceAlias)
      || typeof payload.deviceSerial !== "string" || !payload.deviceSerial
      || payload.deviceSerial === payload.deviceAlias
      || typeof payload.xiaoweiVersion !== "string" || !payload.xiaoweiVersion.trim()
      || payload.xiaoweiVersion.length > 200 || /[\u0000-\u001f\u007f]/u.test(payload.xiaoweiVersion)
      || typeof payload.endpoint !== "string" || !payload.endpoint
      || !SHA256_HEX.test(payload.requestSha256)
      || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > 30_000
      || now < payload.issuedAt || now > payload.expiresAt
      || !isPlainObject(payload.authorization)) {
    invalidCapabilityGrant();
  }
  const requestHash = createHash("sha256").update(requestDocument.source).digest("hex");
  if (requestHash !== payload.requestSha256
      || requestDocument.value?.action !== payload.action
      || requestDocument.value?.devices !== payload.deviceSerial) {
    invalidCapabilityGrant();
  }
  return Object.freeze(payload);
}

function publicCatalog() {
  const routes = {
    list: { status: "routable", command: ".\\xhs.cmd doctor" },
    screen: { status: "routable", command: ".\\xhs.cmd device screen" },
    pushEvent: { status: "partial", command: ".\\xhs.cmd device home|back", note: "task-manager type 1 is not public" },
    apkList: { status: "routable", command: ".\\xhs.cmd app list" },
    startApk: { status: "routable", command: ".\\xhs.cmd app open" },
    stopApk: { status: "routable", command: ".\\xhs.cmd app stop" },
    imeList: { status: "profile_only", command: ".\\xhs.cmd research run", note: "only inside an accepted per-device text profile" },
    selectIme: { status: "profile_only", command: ".\\xhs.cmd research run", note: "only inside an accepted per-device text profile" },
    inputText: { status: "profile_only", command: ".\\xhs.cmd research run", note: "only inside a verified safe edit field" },
  };
  return listXiaoweiActions().map(({ action, summary, risk, devices, data, blockedByDefault }) => ({
    action,
    summary,
    risk,
    devices,
    data,
    blockedByDefault,
    operator: routes[action] ?? {
      status: (blockedByDefault || risk === "privileged") ? "blocked" : "catalog_only",
      note: (blockedByDefault || risk === "privileged")
        ? "visible for audit but unavailable to the ordinary Agent"
        : "strictly validated but not yet exposed as a public command",
    },
  }));
}

export async function runXiaoweiCli(argv = process.argv.slice(2), runtime = {}) {
  const output = runtime.output ?? process.stdout;
  const command = argv[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    output.write(HELP);
    return;
  }
  if (command === "catalog") {
    output.write(`${JSON.stringify({ schemaVersion: 1, actions: publicCatalog() }, null, 2)}\n`);
    return;
  }
  if (command === "dev-invoke") {
    const options = parseDevelopmentOptions(argv.slice(1));
    if (options.developmentMode !== true || !options.requestFile) {
      throw new Error("Xiaowei dev-invoke requires --development-mode and --request-file");
    }
    const request = await readDevelopmentRequest(options.requestFile);
    const payload = {};
    if (Object.hasOwn(request, "devices")) payload.devices = request.devices;
    if (Object.hasOwn(request, "data")) payload.data = request.data;
    const client = createXiaoweiClient({
      endpoint: options.endpoint || process.env.XIAOWEI_API_URL || "ws://127.0.0.1:22222/",
      acceptedActions: [request.action],
      developmentMode: true,
    }, { sendRequest: runtime.sendRequest });
    const result = await client.invoke(request.action, payload, {
      authorization: { mode: "development" },
    });
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const options = parseInternalOptions(argv.slice(1));
    if (options.internalGateway !== true || !options.resultFile || options.requestFile || options.grantFile) {
      throw new Error("Xiaowei list is internal to the verified device gateway");
    }
    await requireTrustedGatewayParent(command, runtime);
    const outputFile = await reserveTemporaryJson(options.resultFile);
    const sendRequest = runtime.sendRequest ?? sendXiaoweiRequest;
    let requestCompleted = false;
    try {
      const result = await sendRequest({ action: "list" }, {
        endpoint: process.env.XIAOWEI_API_URL || "ws://127.0.0.1:22222/",
      });
      requestCompleted = true;
      await outputFile.write(result);
    } catch (error) {
      await outputFile.discard();
      throw requestCompleted ? markResultWriteUnknown(error, "list") : error;
    }
    return;
  }
  if (command === "invoke") {
    const options = parseInternalOptions(argv.slice(1));
    if (options.internalGateway !== true || !options.requestFile || !options.grantFile || !options.resultFile) {
      throw new Error("Xiaowei invoke is internal to the verified device gateway");
    }
    await requireTrustedGatewayParent(command, runtime);
    const [requestDocument, grantDocument] = await Promise.all([
      readTemporaryJsonDocument(options.requestFile, 1024 * 1024),
      readTemporaryJsonDocument(options.grantFile, 64 * 1024),
    ]);
    const request = requestDocument.value;
    if (!request || typeof request !== "object" || Array.isArray(request)
        || !INTERNAL_OPERATOR_ACTIONS.has(request.action)) {
      throw new Error("Internal Xiaowei gateway accepts only verified operator actions");
    }
    const grant = validateCapabilityGrant(
      grantDocument.value,
      requestDocument,
      runtime.gatewayKey ?? process.env.XHS_XIAOWEI_GATEWAY_KEY,
      runtime.now?.() ?? Date.now(),
    );
    if (request.action === "pushEvent" && !["2", "3"].includes(request.data?.type)) {
      throw new Error("Internal Xiaowei gateway exposes only HOME and BACK push events");
    }
    if (["startApk", "stopApk"].includes(request.action)
        && grant.authorization?.approvedPackage !== request.data?.apk) {
      throw new Error("Internal Xiaowei app action requires the exact approved package");
    }
    const outputFile = await reserveTemporaryJson(options.resultFile);
    const client = createXiaoweiClient({
      endpoint: grant.endpoint,
      acceptedActions: [grant.action],
    }, { sendRequest: runtime.sendRequest });
    let requestCompleted = false;
    try {
      const result = await client.invoke(request.action, {
        ...(Object.hasOwn(request, "devices") ? { devices: request.devices } : {}),
        ...(Object.hasOwn(request, "data") ? { data: request.data } : {}),
      }, { authorization: grant.authorization });
      requestCompleted = true;
      await outputFile.write(result);
    } catch (error) {
      await outputFile.discard();
      throw requestCompleted ? markResultWriteUnknown(error, request.action) : error;
    }
    return;
  }
  throw new Error(`Unknown Xiaowei API command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runXiaoweiCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      error: {
        name: error.name ?? "Error",
        code: error.code ?? "XIAOWEI_CLI_FAILED",
        message: error.message,
        outcome: error.outcome ?? "failed",
        sent: error.sent === true,
        action: error.action,
        vendorCode: error.vendorCode,
      },
    })}\n`);
    process.exitCode = 1;
  });
}
