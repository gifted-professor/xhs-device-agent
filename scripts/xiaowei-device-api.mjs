import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createDeviceApiRouter } from "./device-api-router.mjs";
import { toErrorResult, XiaoweiError } from "./lib/xiaowei-errors.mjs";
import { XiaoweiRawService } from "./lib/xiaowei-raw-service.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";
import { XiaoweiClient } from "./lib/xiaowei-client.mjs";
import { XiaoweiOperationService } from "./lib/xiaowei-operation-service.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17910;
const MAX_BODY_BYTES = 1024 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new XiaoweiError("XIAOWEI_REQUEST_TOO_LARGE", "Request body exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new XiaoweiError("XIAOWEI_INVALID_JSON", "Request body is not valid JSON");
  }
}

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  response.end(payload);
}

export function createDeviceApiServer({ router }) {
  return createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    try {
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      const result = await router.handle({ method: request.method, path, body });
      sendJson(response, result.status, result.body);
    } catch (error) {
      const status = error?.code === "XIAOWEI_REQUEST_TOO_LARGE" ? 413 : 400;
      sendJson(response, status, toErrorResult(error));
    }
  });
}

function parseServeArgs(argv) {
  const options = {
    command: argv[0] || "help",
    host: process.env.XIAOWEI_DEVICE_API_HOST || DEFAULT_HOST,
    port: Number(process.env.XIAOWEI_DEVICE_API_PORT || DEFAULT_PORT),
  };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--host") options.host = argv[++index];
    else if (argv[index] === "--port") options.port = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseServeArgs(argv);
  if (options.command !== "serve") {
    console.log("node scripts/xiaowei-device-api.mjs serve [--host 127.0.0.1] [--port 17910]");
    return;
  }

  const transport = new XiaoweiTransport();
  const rawService = new XiaoweiRawService({ transport });
  const client = new XiaoweiClient({ transport, resolveDevice: rawService.resolveDevice.bind(rawService) });
  const operationService = new XiaoweiOperationService({
    execute: (request) => request.action
      ? rawService.invokeRaw(request)
      : client.invoke(request.capability, { deviceAlias: request.deviceAlias, params: request.params || {} }),
  });
  const router = createDeviceApiRouter({ rawService, client, operationService });
  const server = createDeviceApiServer({ router });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  console.log(JSON.stringify({ ok: true, host: options.host, port: options.port, api: "/device/v1/manifest", raw: "/device/v1/raw" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
