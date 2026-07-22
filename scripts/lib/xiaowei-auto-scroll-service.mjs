import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { XiaoweiError } from "./xiaowei-errors.mjs";

const DEFAULT_STATE_DIR = join(tmpdir(), "xiaowei-auto-scroll");
const DEFAULT_WORKER_PATH = fileURLToPath(new URL("../xiaowei-auto-scroll-worker.mjs", import.meta.url));
const ACTIVE_STATES = new Set(["starting", "running", "stopping"]);

function invalid(message, details = {}) {
  throw new XiaoweiError("XIAOWEI_INVALID_PARAMETERS", message, details);
}

function validateAlias(deviceAlias) {
  if (typeof deviceAlias !== "string" || !/^\d{2}$/.test(deviceAlias)) {
    invalid("deviceAlias must be a two-digit public alias", { deviceAlias: deviceAlias ?? null });
  }
  return deviceAlias;
}

function statePathFor(stateDir, deviceAlias) {
  return join(stateDir, `${validateAlias(deviceAlias)}.json`);
}

function stopPathFor(stateDir, deviceAlias) {
  return join(stateDir, `${validateAlias(deviceAlias)}.stop.json`);
}

export function readAutoScrollJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new XiaoweiError("XIAOWEI_AUTO_SCROLL_STATE_INVALID", `Unable to read ${basename(path)}`, {}, { cause: error });
  }
}

export function writeAutoScrollJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function removeIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function publicState(state) {
  if (!state) return { status: "idle", state: "idle", deviceAlias: null };
  const {
    pid: _pid,
    errorMessage: _errorMessage,
    ...safe
  } = state;
  return safe;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XiaoweiAutoScrollService {
  constructor({
    stateDir = process.env.XIAOWEI_AUTO_SCROLL_STATE_DIR || DEFAULT_STATE_DIR,
    workerPath = DEFAULT_WORKER_PATH,
    canaryAlias = "01",
    spawnImpl = spawn,
    isProcessAlive = processAlive,
    now = Date.now,
    createRunId = randomUUID,
    sleepImpl = sleep,
  } = {}) {
    this.stateDir = stateDir;
    this.workerPath = workerPath;
    this.canaryAlias = canaryAlias;
    this.spawnImpl = spawnImpl;
    this.isProcessAlive = isProcessAlive;
    this.now = now;
    this.createRunId = createRunId;
    this.sleepImpl = sleepImpl;
  }

  validateDeviceAlias(deviceAlias) {
    validateAlias(deviceAlias);
    if (deviceAlias !== this.canaryAlias) {
      throw new XiaoweiError(
        "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE",
        `only device alias ${this.canaryAlias} is enabled for managed auto-scroll`,
        { deviceAlias },
      );
    }
    return deviceAlias;
  }

  status({ deviceAlias }) {
    this.validateDeviceAlias(deviceAlias);
    const path = statePathFor(this.stateDir, deviceAlias);
    const state = readAutoScrollJson(path);
    if (!state) return { status: "idle", state: "idle", deviceAlias };
    if (ACTIVE_STATES.has(state.state) && !this.isProcessAlive(state.pid)) {
      const failed = {
        ...state,
        state: state.state === "stopping" ? "stopped" : "failed",
        status: state.state === "stopping" ? "stopped" : "failed",
        errorClass: state.state === "stopping" ? null : "XIAOWEI_AUTO_SCROLL_WORKER_EXITED",
        finishedAt: this.now(),
        updatedAt: this.now(),
      };
      writeAutoScrollJson(path, failed);
      return publicState(failed);
    }
    return publicState(state);
  }

  start({ deviceAlias, direction = "up", intervalMs = 2000, maxSwipes }) {
    this.validateDeviceAlias(deviceAlias);
    if (!(["up", "down"].includes(direction))) invalid("direction must be up or down");
    if (!Number.isInteger(intervalMs) || intervalMs < 500 || intervalMs > 60000) {
      invalid("intervalMs must be an integer between 500 and 60000");
    }
    if (!Number.isInteger(maxSwipes) || maxSwipes < 1 || maxSwipes > 10000) {
      invalid("maxSwipes must be an integer between 1 and 10000");
    }

    const current = this.status({ deviceAlias });
    if (ACTIVE_STATES.has(current.state)) {
      if (current.direction === direction && current.intervalMs === intervalMs && current.maxSwipes === maxSwipes) {
        return { ...current, idempotent: true };
      }
      throw new XiaoweiError("XIAOWEI_DEVICE_BUSY", `device ${deviceAlias} already has an auto-scroll task`, {
        deviceAlias,
        runId: current.runId,
      });
    }

    mkdirSync(this.stateDir, { recursive: true });
    const runId = this.createRunId();
    const statePath = statePathFor(this.stateDir, deviceAlias);
    const stopPath = stopPathFor(this.stateDir, deviceAlias);
    removeIfPresent(stopPath);
    const startedAt = this.now();
    const starting = {
      status: "starting",
      state: "starting",
      runId,
      deviceAlias,
      direction,
      intervalMs,
      maxSwipes,
      completedSwipes: 0,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      errorClass: null,
      pid: null,
    };
    writeAutoScrollJson(statePath, starting);

    let child;
    try {
      child = this.spawnImpl(process.execPath, [
        this.workerPath,
        "--state", statePath,
        "--stop", stopPath,
        "--run-id", runId,
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once?.("error", (error) => {
        const latest = readAutoScrollJson(statePath);
        if (latest?.runId !== runId || !ACTIVE_STATES.has(latest.state)) return;
        writeAutoScrollJson(statePath, {
          ...latest,
          status: "failed",
          state: "failed",
          errorClass: "XIAOWEI_AUTO_SCROLL_START_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
          finishedAt: this.now(),
          updatedAt: this.now(),
        });
      });
      child.unref?.();
    } catch (error) {
      const failed = {
        ...starting,
        status: "failed",
        state: "failed",
        finishedAt: this.now(),
        updatedAt: this.now(),
        errorClass: "XIAOWEI_AUTO_SCROLL_START_FAILED",
      };
      writeAutoScrollJson(statePath, failed);
      throw new XiaoweiError("XIAOWEI_AUTO_SCROLL_START_FAILED", "Unable to start auto-scroll worker", {}, { cause: error });
    }

    const latest = readAutoScrollJson(statePath);
    if (latest?.runId === runId && latest.state === "starting") {
      const withPid = { ...latest, pid: child.pid };
      writeAutoScrollJson(statePath, withPid);
      return publicState(withPid);
    }
    return publicState(latest || starting);
  }

  async stop({ deviceAlias, waitMs = 5000 }) {
    this.validateDeviceAlias(deviceAlias);
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) {
      invalid("waitMs must be an integer between 0 and 30000");
    }
    const statePath = statePathFor(this.stateDir, deviceAlias);
    const stopPath = stopPathFor(this.stateDir, deviceAlias);
    const current = readAutoScrollJson(statePath);
    if (!current || !ACTIVE_STATES.has(current.state)) {
      return { ...(current ? publicState(current) : { deviceAlias, state: "idle" }), status: "not_running", idempotent: true };
    }

    const requestedAt = this.now();
    writeAutoScrollJson(stopPath, { runId: current.runId, requestedAt });
    writeAutoScrollJson(statePath, {
      ...current,
      status: "stopping",
      state: "stopping",
      stopRequestedAt: requestedAt,
      updatedAt: requestedAt,
    });

    const deadline = this.now() + waitMs;
    while (this.now() < deadline) {
      const state = this.status({ deviceAlias });
      if (!ACTIVE_STATES.has(state.state)) return state;
      await this.sleepImpl(Math.min(100, Math.max(1, deadline - this.now())));
    }
    return this.status({ deviceAlias });
  }

  control({ deviceAlias, operation, direction, intervalMs, maxSwipes, waitMs }) {
    if (operation === "start") return this.start({ deviceAlias, direction, intervalMs, maxSwipes });
    if (operation === "status") return this.status({ deviceAlias });
    if (operation === "stop") return this.stop({ deviceAlias, waitMs });
    invalid("operation must be start, status, or stop");
  }
}
