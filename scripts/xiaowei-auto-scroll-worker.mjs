import { pathToFileURL } from "node:url";

import { readAutoScrollJson, writeAutoScrollJson } from "./lib/xiaowei-auto-scroll-service.mjs";
import { XiaoweiClient } from "./lib/xiaowei-client.mjs";
import { XiaoweiRawService } from "./lib/xiaowei-raw-service.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("worker arguments must be --key value pairs");
    options[key.slice(2)] = value;
  }
  if (!options.state || !options.stop || !options["run-id"]) throw new Error("--state, --stop, and --run-id are required");
  return options;
}

function stopRequested(path, runId) {
  return readAutoScrollJson(path)?.runId === runId;
}

async function interruptibleSleep(ms, shouldStop) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
  return shouldStop();
}

export async function runWorker({ statePath, stopPath, runId, client }) {
  let state = readAutoScrollJson(statePath);
  if (!state || state.runId !== runId) throw new Error("auto-scroll state does not match worker run ID");
  const update = (patch) => {
    state = { ...state, ...patch, updatedAt: Date.now(), pid: process.pid };
    writeAutoScrollJson(statePath, state);
  };

  update({ status: "running", state: "running" });
  try {
    while (state.completedSwipes < state.maxSwipes) {
      if (stopRequested(stopPath, runId)) {
        update({ status: "stopped", state: "stopped", finishedAt: Date.now(), errorClass: null });
        return state;
      }
      await client.swipe({ deviceAlias: state.deviceAlias, direction: state.direction });
      update({ completedSwipes: state.completedSwipes + 1 });
      if (state.completedSwipes >= state.maxSwipes) break;
      if (await interruptibleSleep(state.intervalMs, () => stopRequested(stopPath, runId))) {
        update({ status: "stopped", state: "stopped", finishedAt: Date.now(), errorClass: null });
        return state;
      }
    }
    update({ status: "completed", state: "completed", finishedAt: Date.now(), errorClass: null });
    return state;
  } catch (error) {
    update({
      status: "failed",
      state: "failed",
      finishedAt: Date.now(),
      errorClass: error?.code || error?.name || "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const transport = new XiaoweiTransport();
  const rawService = new XiaoweiRawService({ transport });
  const client = new XiaoweiClient({ transport, resolveDevice: rawService.resolveDevice.bind(rawService) });
  await runWorker({
    statePath: options.state,
    stopPath: options.stop,
    runId: options["run-id"],
    client,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 1; });
}
