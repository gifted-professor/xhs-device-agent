import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const DEFAULT_DEBUGGER_ENDPOINT = "http://127.0.0.1:9223";
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_DISCOVERY_BYTES = 256 * 1024;

export class XiaoweiPrivateApiError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "XiaoweiPrivateApiError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new XiaoweiPrivateApiError(code, message, details);
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function validateDebuggerEndpoint(value = DEFAULT_DEBUGGER_ENDPOINT) {
  let endpoint;
  try { endpoint = new URL(value); } catch { fail("INVALID_ENDPOINT", "Xiaowei private API debugger endpoint is invalid"); }
  if (endpoint.protocol !== "http:" || !isLoopback(endpoint.hostname) || endpoint.username || endpoint.password) {
    fail("INVALID_ENDPOINT", "Xiaowei private API debugger endpoint must be an unauthenticated local HTTP URL");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    fail("INVALID_ENDPOINT", "Xiaowei private API debugger endpoint must not include a path, query, or fragment");
  }
  return endpoint.toString().replace(/\/$/u, "");
}

function validateDebuggerWebSocket(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { fail("INVALID_TARGET", "Xiaowei debugger target returned an invalid WebSocket URL"); }
  if (endpoint.protocol !== "ws:" || !isLoopback(endpoint.hostname) || endpoint.username || endpoint.password) {
    fail("INVALID_TARGET", "Xiaowei debugger target must use a local unauthenticated WebSocket URL");
  }
  return endpoint.toString();
}

async function readDiscovery(endpoint, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("FETCH_UNAVAILABLE", "This Node.js runtime does not provide fetch");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${endpoint}/json/list`, { signal: controller.signal });
  } catch (error) {
    fail("DEBUGGER_UNAVAILABLE", "Xiaowei private API is not ready; enable it and restart Xiaowei once", { cause: error });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) fail("DISCOVERY_FAILED", `Xiaowei debugger discovery returned HTTP ${response?.status ?? "unknown"}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_DISCOVERY_BYTES) fail("DISCOVERY_TOO_LARGE", "Xiaowei debugger discovery response is too large");
  let targets;
  try { targets = JSON.parse(body.toString("utf8")); } catch { fail("DISCOVERY_INVALID", "Xiaowei debugger discovery returned invalid JSON"); }
  if (!Array.isArray(targets)) fail("DISCOVERY_INVALID", "Xiaowei debugger discovery did not return a target list");
  return targets;
}

export async function discoverXiaoweiTarget(options = {}) {
  const endpoint = validateDebuggerEndpoint(options.endpoint);
  const targets = await readDiscovery(endpoint, options);
  const matching = targets.filter((target) => {
    if (!target || target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
    const identity = `${target.title ?? ""} ${target.url ?? ""}`;
    return /效卫|xiaowei|tauri:\/\/localhost|tauri\.localhost/iu.test(identity);
  });
  if (matching.length !== 1) {
    fail("TARGET_NOT_UNIQUE", `Expected exactly one Xiaowei WebView target, found ${matching.length}`);
  }
  return { ...matching[0], webSocketDebuggerUrl: validateDebuggerWebSocket(matching[0].webSocketDebuggerUrl) };
}

function evaluateCdp(target, expression, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      handler(value);
    };
    const timer = setTimeout(() => finish(reject, new XiaoweiPrivateApiError(
      "CDP_TIMEOUT",
      "Xiaowei private API timed out; command outcome may be unknown",
      { outcome: "unknown" },
    )), timeoutMs);
    try { socket = new WebSocketImpl(target.webSocketDebuggerUrl, { maxPayload: 1024 * 1024 }); } catch (error) {
      finish(reject, new XiaoweiPrivateApiError("CDP_CONNECT_FAILED", "Unable to connect to Xiaowei WebView", { cause: error }));
      return;
    }
    socket.on("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) {
        finish(reject, new XiaoweiPrivateApiError("CDP_FAILED", message.error.message ?? "Xiaowei WebView evaluation failed"));
        return;
      }
      if (message.result?.exceptionDetails) {
        finish(reject, new XiaoweiPrivateApiError("EVALUATION_FAILED", "Xiaowei WebView rejected the private API evaluation"));
        return;
      }
      finish(resolve, message.result?.result?.value);
    });
    socket.on("error", (error) => finish(reject, new XiaoweiPrivateApiError(
      "CDP_CONNECT_FAILED",
      "Xiaowei WebView debugger connection failed",
      { cause: error },
    )));
    socket.on("close", () => {
      if (!settled) finish(reject, new XiaoweiPrivateApiError("CDP_CLOSED", "Xiaowei WebView closed before responding"));
    });
  });
}

async function evaluateXiaowei(expression, options = {}) {
  const target = options.target ?? await discoverXiaoweiTarget(options);
  return evaluateCdp(target, expression, options);
}

export async function probeXiaoweiPrivateApi(options = {}) {
  const result = await evaluateXiaowei(`(() => ({
    available: typeof globalThis.__TAURI_INTERNALS__?.invoke === "function",
    app: "xiaowei",
  }))()`, options);
  if (!result?.available) fail("TAURI_IPC_UNAVAILABLE", "The Xiaowei WebView target does not expose Tauri IPC");
  return { available: true, transport: "webview_cdp", app: "xiaowei" };
}

const PRIVATE_COMMANDS = Object.freeze({
  get_device_list: Object.freeze({ risk: "read_only" }),
  get_size: Object.freeze({ risk: "read_only" }),
  restart_adb: Object.freeze({ risk: "host_service_change" }),
});

export const XIAOWEI_DISCOVERED_PRIVATE_COMMANDS = Object.freeze([
  "input_text", "input_enter", "paste_pwd", "get_clipboard", "put_clipboard", "pull_clipboard",
  "install_apk", "reboot", "get_size", "get_density", "get_device_info", "get_device_mode", "switch_all_device_mode",
  "usb_to_tcp", "otg_scanning", "get_apk_list", "get_apk_info", "launch_app", "uninstall_apk",
  "push_file", "adb_command", "exec_command", "install_input", "get_ime_list", "get_ime_info", "switch_ime",
  "read_config", "write_config", "read_sys_config", "get_ip_serial", "get_serial_ip", "get_device_list",
  "restart_adb", "wallpapers_device", "reconnect_device", "close_device", "paste_text", "get_arp_out",
  "push_scan_ips", "otg_all_scanning", "get_ws_port", "device_disconnect", "switch_accessible_mode",
  "switch_adb_mode", "device_is_accessible", "get_accessible_devices", "is_hid_model", "install_hid_app",
  "check_hid_app_installed", "check_adb_device", "restart", "remove_hid_driver", "switch_hid_model",
  "get_usb_devices", "has_hid_devices", "action_play", "action_act", "exec_autojs", "stop_autojs",
  "exec_autojs_check", "merge_adb_auth_key", "get_external_ip", "get_file_md5", "get_root",
  "install_magisk", "install_xwdb", "reboot_ext", "disconnect", "start_updater", "check_service",
]);
const DISCOVERED_PRIVATE_COMMAND_SET = new Set(XIAOWEI_DISCOVERED_PRIVATE_COMMANDS);

export async function invokeXiaoweiPrivateCommand(command, args = {}, options = {}) {
  const ordinaryDefinition = PRIVATE_COMMANDS[command];
  if (!ordinaryDefinition && !(options.developmentMode === true && DISCOVERED_PRIVATE_COMMAND_SET.has(command))) {
    fail("COMMAND_BLOCKED", `Xiaowei private command is not accepted: ${String(command)}`);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("INVALID_ARGS", "Xiaowei private command arguments must be an object");
  const expression = `(async () => {
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return { ok: false, code: "TAURI_IPC_UNAVAILABLE" };
    try {
      const value = await invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      return { ok: false, code: "VENDOR_FAILED", message: String(error?.message ?? error) };
    }
  })()`;
  const result = await evaluateXiaowei(expression, options);
  if (!result?.ok) fail(result?.code ?? "INVALID_RESPONSE", result?.message ?? `Xiaowei private command ${command} failed`, {
    command,
    outcome: command === "restart_adb" ? "unknown" : "not_applied",
  });
  return { command, risk: ordinaryDefinition?.risk ?? "development_unrestricted", value: result.value };
}

export function summarizePrivateDeviceList(value) {
  let normalized = value;
  let resultType = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024 * 1024) {
    try {
      normalized = JSON.parse(value);
      resultType = "json_string";
    } catch {}
  }
  const records = Array.isArray(normalized) ? normalized : Array.isArray(normalized?.data) ? normalized.data : null;
  return {
    deviceCount: records?.length ?? null,
    resultType,
    identifiersRedacted: true,
  };
}

function parseCli(argv) {
  const [command = "status", ...rest] = argv;
  let endpoint = DEFAULT_DEBUGGER_ENDPOINT;
  let privateCommand;
  let args = {};
  let argsSource;
  let developmentMode = false;
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--development-mode") {
      if (developmentMode) fail("INVALID_OPTION", "--development-mode may be provided only once");
      developmentMode = true;
      continue;
    }
    if (!["--endpoint", "--command", "--args-json", "--args-file"].includes(option) || index + 1 >= rest.length) {
      fail("INVALID_OPTION", `Unknown private API option: ${option}`);
    }
    const value = rest[++index];
    if (option === "--endpoint") endpoint = value;
    if (option === "--command") privateCommand = value;
    if (option === "--args-json" || option === "--args-file") {
      if (argsSource) fail("INVALID_ARGS", "Use --args-json or --args-file, not both");
      argsSource = option;
      let source = value;
      if (option === "--args-file") {
        try {
          const contents = readFileSync(value);
          if (contents.length > 32 * 1024) fail("INVALID_ARGS", "--args-file is too large");
          source = contents.toString("utf8");
        } catch (error) {
          if (error instanceof XiaoweiPrivateApiError) throw error;
          fail("INVALID_ARGS", "--args-file could not be read");
        }
      }
      try { args = JSON.parse(source); } catch { fail("INVALID_ARGS", `${option} must contain valid JSON`); }
    }
  }
  return { command, endpoint, privateCommand, args, developmentMode };
}

export async function runXiaoweiPrivateCli(argv = process.argv.slice(2), runtime = {}) {
  const output = runtime.output ?? process.stdout;
  const parsed = parseCli(argv);
  const options = { endpoint: parsed.endpoint, developmentMode: parsed.developmentMode, ...runtime };
  const { command } = parsed;
  let result;
  if (command === "status") {
    result = await probeXiaoweiPrivateApi(options);
  } else if (command === "catalog") {
    result = {
      versionBound: "9.10.113",
      developmentOnly: true,
      commands: XIAOWEI_DISCOVERED_PRIVATE_COMMANDS,
    };
  } else if (command === "device-summary") {
    const response = await invokeXiaoweiPrivateCommand("get_device_list", {}, options);
    result = { available: true, command: response.command, ...summarizePrivateDeviceList(response.value) };
  } else if (command === "restart-adb") {
    const response = await invokeXiaoweiPrivateCommand("restart_adb", {}, options);
    result = { available: true, command: response.command, backend: "xiaowei_private_api", outcome: "completed" };
  } else if (command === "invoke") {
    if (!parsed.developmentMode || !parsed.privateCommand) {
      fail("DEVELOPMENT_MODE_REQUIRED", "Private invoke requires --development-mode and --command");
    }
    const response = await invokeXiaoweiPrivateCommand(parsed.privateCommand, parsed.args, options);
    result = { available: true, command: response.command, risk: response.risk, value: response.value };
  } else {
    fail("UNKNOWN_COMMAND", `Unknown Xiaowei private API command: ${command}`);
  }
  output.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runXiaoweiPrivateCli().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
