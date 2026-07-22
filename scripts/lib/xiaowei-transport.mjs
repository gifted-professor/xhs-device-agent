import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { XiaoweiError } from "./xiaowei-errors.mjs";

const DEFAULT_URL = "ws://127.0.0.1:22222/";
const DEFAULT_LOCK_PATH = join(tmpdir(), "xw-ws-22222.lock");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeRequest({ action, devices, data }) {
  if (typeof action !== "string" || action.trim() === "") {
    throw new XiaoweiError("XIAOWEI_INVALID_ACTION", "Xiaowei action must be a non-empty string");
  }

  const request = { action };
  if (devices !== undefined && devices !== "") request.devices = devices;
  if (data !== undefined) request.data = data;
  return request;
}

function readToken(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

async function acquireLock({ path, timeoutMs, staleMs, retryMs }) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();

  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
      } finally {
        closeSync(descriptor);
      }

      const heartbeatMs = Math.max(25, Math.min(5000, Math.floor(staleMs / 3)));
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          if (readToken(path) === token) utimesSync(path, now, now);
        } catch {
          // If the lock disappeared, release() will avoid deleting a replacement lock.
        }
      }, heartbeatMs);
      heartbeat.unref?.();

      return () => {
        clearInterval(heartbeat);
        try {
          if (readToken(path) === token) unlinkSync(path);
        } catch {
          // The operation is already complete; a missing lock needs no further recovery.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new XiaoweiError(
          "XIAOWEI_LOCK_ERROR",
          "Unable to create Xiaowei transport lock",
          { path },
          { cause: error },
        );
      }

      try {
        const ageMs = Date.now() - statSync(path).mtimeMs;
        if (ageMs > staleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
      }

      if (Date.now() >= deadline) {
        throw new XiaoweiError(
          "XIAOWEI_LOCK_TIMEOUT",
          `Timed out waiting for Xiaowei transport lock after ${timeoutMs}ms`,
          { timeoutMs },
        );
      }
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export class XiaoweiTransport {
  constructor({
    url = DEFAULT_URL,
    WebSocketImpl = globalThis.WebSocket,
    lockPath = DEFAULT_LOCK_PATH,
    requestTimeoutMs = 12000,
    lockTimeoutMs = 45000,
    staleLockMs = 180000,
    lockRetryMs = 100,
    logger = () => {},
  } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.lockPath = lockPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.lockRetryMs = lockRetryMs;
    this.logger = logger;
  }

  async invoke(input, { timeoutMs = this.requestTimeoutMs } = {}) {
    const request = makeRequest(input);
    if (typeof this.WebSocketImpl !== "function") {
      throw new XiaoweiError(
        "XIAOWEI_WEBSOCKET_UNAVAILABLE",
        "This Node.js runtime does not provide WebSocket; inject WebSocketImpl",
      );
    }

    const release = await acquireLock({
      path: this.lockPath,
      timeoutMs: this.lockTimeoutMs,
      staleMs: this.staleLockMs,
      retryMs: this.lockRetryMs,
    });

    try {
      this.logger({ event: "xiaowei.request", action: request.action, timeoutMs });
      const response = await this.#invokeUnlocked(request, timeoutMs);
      this.logger({ event: "xiaowei.response", action: request.action, code: response?.code ?? null });
      return response;
    } finally {
      release();
    }
  }

  #invokeUnlocked(request, timeoutMs) {
    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket?.close();
        } catch {
          // The result/error is already known.
        }
        callback(value);
      };

      const timer = setTimeout(() => {
        finish(
          reject,
          new XiaoweiError(
            "XIAOWEI_TIMEOUT",
            `Xiaowei action timed out after ${timeoutMs}ms`,
            { action: request.action, timeoutMs },
          ),
        );
      }, timeoutMs);

      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        finish(
          reject,
          new XiaoweiError(
            "XIAOWEI_CONNECTION_ERROR",
            "Unable to create Xiaowei WebSocket",
            { action: request.action },
            { cause: error },
          ),
        );
        return;
      }

      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify(request));
        } catch (error) {
          finish(
            reject,
            new XiaoweiError(
              "XIAOWEI_SEND_ERROR",
              "Unable to send Xiaowei request",
              { action: request.action },
              { cause: error },
            ),
          );
        }
      });

      socket.addEventListener("message", (event) => {
        let response;
        try {
          response = JSON.parse(String(event.data));
        } catch (error) {
          finish(
            reject,
            new XiaoweiError(
              "XIAOWEI_MALFORMED_RESPONSE",
              "Xiaowei returned malformed JSON",
              { action: request.action },
              { cause: error },
            ),
          );
          return;
        }

        if (typeof response?.code === "number" && response.code !== 10000) {
          finish(
            reject,
            new XiaoweiError(
              "XIAOWEI_VENDOR_ERROR",
              `Xiaowei rejected action ${request.action}`,
              { action: request.action, response },
            ),
          );
          return;
        }
        finish(resolve, response);
      });

      socket.addEventListener("error", () => {
        finish(
          reject,
          new XiaoweiError(
            "XIAOWEI_CONNECTION_ERROR",
            "Xiaowei WebSocket connection failed",
            { action: request.action },
          ),
        );
      });

      socket.addEventListener("close", () => {
        if (!settled) {
          finish(
            reject,
            new XiaoweiError(
              "XIAOWEI_CLOSED",
              "Xiaowei WebSocket closed before a response arrived",
              { action: request.action },
            ),
          );
        }
      });
    });
  }
}
