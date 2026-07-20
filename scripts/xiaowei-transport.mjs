import NodeWebSocket from "ws";

const DEFAULT_WS_URL = process.env.XIAOWEI_API_URL || "ws://127.0.0.1:22222/";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class XiaoweiTransportError extends Error {
  constructor(code, message, { sent = false, outcome = sent ? "unknown" : "failed" } = {}) {
    super(message);
    this.name = "XiaoweiTransportError";
    this.code = code;
    this.sent = sent;
    this.outcome = outcome;
  }
}

function transportError(code, message, sent) {
  return new XiaoweiTransportError(code, message, { sent });
}

export function validateXiaoweiEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(String(value ?? ""));
  } catch {
    throw new Error("Xiaowei API endpoint must be a valid local WebSocket URL");
  }
  if (endpoint.protocol !== "ws:" || !new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname)) {
    throw new Error("Xiaowei API endpoint must use ws:// on the local loopback interface");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Xiaowei API endpoint must not contain credentials");
  }
  return endpoint.toString();
}

export function normalizeXiaoweiResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Xiaowei API returned an invalid response object");
  }
  const code = Number(value.code);
  if (!Number.isInteger(code)) throw new Error("Xiaowei API response is missing an integer code");
  const message = typeof value.message === "string" ? value.message : "";
  return Object.freeze({
    ok: code === 10_000,
    code,
    message,
    data: value.data ?? null,
  });
}

export function sendXiaoweiRequest(request, options = {}) {
  const endpoint = validateXiaoweiEndpoint(options.endpoint ?? DEFAULT_WS_URL);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = Number.isInteger(options.maxResponseBytes) && options.maxResponseBytes > 0
    ? options.maxResponseBytes
    : DEFAULT_MAX_RESPONSE_BYTES;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket ?? NodeWebSocket;
  if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.action !== "string" || !request.action.trim()) {
    throw new Error("Xiaowei API request requires an action");
  }
  if (typeof WebSocketImpl !== "function") {
    throw new Error("This Xiaowei API client requires a WebSocket implementation");
  }

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint);
    let settled = false;
    let sent = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      callback(value);
    };
    const timer = setTimeout(() => {
      finish(reject, transportError("TIMEOUT", sent
        ? "Xiaowei API timed out after the request was sent; device outcome is unknown"
        : "Xiaowei API connection timed out before the request was sent", sent));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      if (settled || sent) return;
      try {
        socket.send(JSON.stringify(request));
        sent = true;
      } catch (error) {
        finish(reject, transportError("SEND_FAILED", `Unable to send the Xiaowei API request: ${error.message}`, sent));
      }
    });
    socket.addEventListener("message", (event) => {
      if (settled) return;
      const payload = String(event.data ?? "");
      if (Buffer.byteLength(payload, "utf8") > maxResponseBytes) {
        finish(reject, transportError("RESPONSE_TOO_LARGE", "Xiaowei API response exceeded the configured size limit; device outcome is unknown", sent));
        return;
      }
      try {
        finish(resolve, JSON.parse(payload));
      } catch {
        finish(reject, transportError("MALFORMED_RESPONSE", "Xiaowei API returned malformed JSON; device outcome is unknown", sent));
      }
    });
    socket.addEventListener("error", () => {
      finish(reject, transportError("CONNECTION_FAILED", sent
        ? "Xiaowei API connection failed after the request was sent; device outcome is unknown"
        : "Unable to connect to the Xiaowei API on the local loopback interface", sent));
    });
    socket.addEventListener("close", () => {
      if (!settled) {
        finish(reject, transportError("CLOSED", sent
          ? "Xiaowei API closed before responding; device outcome is unknown"
          : "Xiaowei API closed before the request was sent", sent));
      }
    });
  });
}
