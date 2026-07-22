import { pathToFileURL } from "node:url";

import { createPublicManifest, summarizeCapabilities } from "./lib/xiaowei-capabilities.mjs";
import { XiaoweiClient } from "./lib/xiaowei-client.mjs";
import { XiaoweiRawService } from "./lib/xiaowei-raw-service.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";
import { probeReadOnlyCandidates } from "./xiaowei-probe-readonly.mjs";

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--serial") throw new Error("--serial is not supported; use --device 01");
    if (key === "--json" || key === "--read-only") options[key.slice(2)] = true;
    else if (key.startsWith("--")) {
      if (i + 1 >= args.length) throw new Error(`${key} requires a value`);
      options[key.slice(2)] = args[++i];
    } else throw new Error(`unexpected argument: ${key}`);
  }
  return options;
}

function parseJson(value, name) {
  if (value === undefined) return {};
  try { return JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON`); }
}

function requireAlias(options) {
  if (options.device !== "01") throw new Error("only device alias 01 is enabled in this test phase");
  return options.device;
}

export function sanitizeDeviceList(response) {
  const items = Array.isArray(response?.data) ? response.data : [];
  return {
    ok: response?.code === undefined || response.code === 10000,
    devices: items.filter((item) => item?.hide !== true).map((item) => ({
      alias: String(item?.sort ?? "").padStart(2, "0"),
      model: item?.model ?? null,
      online: true,
    })),
  };
}

export function createRuntimeServices() {
  const transport = new XiaoweiTransport();
  const rawService = new XiaoweiRawService({ transport });
  const client = new XiaoweiClient({ transport, resolveDevice: rawService.resolveDevice.bind(rawService) });
  return {
    rawService,
    client,
    discover: ({ deviceAlias }) => probeReadOnlyCandidates({ service: rawService, deviceAlias }),
    hostStatus: async () => ({ ok: true, websocket: "ws://127.0.0.1:22222/" }),
  };
}

function help() {
  return `xhs device control\n\nxhs.cmd doctor\nxhs.cmd host status\nxhs.cmd device list\nxhs.cmd device capabilities [--json]\nxhs.cmd device discover --device 01 --read-only\nxhs.cmd device raw --device 01 --action <action> [--data <json>] [--timeout-ms <n>]\nxhs.cmd device invoke --device 01 --capability <id> [--params <json>]\nxhs.cmd device operation --id <id>`;
}

export async function runCli(argv, { services = createRuntimeServices(), io = console } = {}) {
  const [scope = "help", command, ...rest] = argv;
  let result;
  if (scope === "help" || scope === "--help") result = help();
  else if (scope === "doctor") result = { ok: true, node: process.version, capabilities: summarizeCapabilities() };
  else if (scope === "host" && command === "status") result = await services.hostStatus();
  else if (scope === "device") {
    const options = parseOptions(rest);
    if (command === "list") result = sanitizeDeviceList(await services.client.deviceList());
    else if (command === "capabilities") result = { ...createPublicManifest(), summary: summarizeCapabilities() };
    else if (command === "discover") {
      const deviceAlias = requireAlias(options);
      if (!options["read-only"]) throw new Error("device discover currently requires --read-only");
      await services.rawService.resolveDevice(deviceAlias);
      result = await services.discover({ deviceAlias });
    } else if (command === "raw") {
      const deviceAlias = requireAlias(options);
      if (!options.action) throw new Error("--action is required");
      await services.rawService.resolveDevice(deviceAlias);
      const request = { deviceAlias, action: options.action, data: parseJson(options.data, "--data") };
      if (options["timeout-ms"] !== undefined) request.timeoutMs = Number(options["timeout-ms"]);
      result = await services.rawService.invokeRaw(request);
    } else if (command === "invoke") {
      const deviceAlias = requireAlias(options);
      if (!options.capability) throw new Error("--capability is required");
      await services.rawService.resolveDevice(deviceAlias);
      result = await services.client.invoke(options.capability, { deviceAlias, params: parseJson(options.params, "--params") });
    } else if (command === "operation") {
      if (!options.id) throw new Error("--id is required");
      result = services.operationService?.get(options.id);
      if (!result) throw new Error(`operation not found: ${options.id}`);
    } else throw new Error(`unknown device command: ${command}`);
  } else throw new Error(`unknown command: ${scope}`);
  io.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  return result;
}

export async function main(argv = process.argv.slice(2)) { return runCli(argv); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
