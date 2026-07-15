import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildBatchSummary,
  classifyFeedBatchFailure,
  createBatchAttemptId,
  createBatchManifest,
  normalizeFeedBatchSpec,
} from "./feed-batch-core.mjs";
import {
  batchControlPaths,
  initializeBatchControl,
  readBatchFuse,
  releaseBatchBarrier,
  tripBatchFuse,
  writeBatchLease,
  writeJsonAtomicSync,
  writeManifestOnce,
} from "./feed-batch-control.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;

function parseCli(argv) {
  const values = Object.create(null);
  const flags = new Set(["dry-run"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) throw new Error("Batch runner accepts named options only");
    const name = token.slice(2);
    if (Object.hasOwn(values, name)) throw new Error("--" + name + " may be provided only once");
    if (flags.has(name)) {
      values[name] = true;
      continue;
    }
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith("--")) {
      throw new Error("--" + name + " requires a value");
    }
    values[name] = String(argv[++index]);
  }
  const allowed = new Set(["spec", "config", "output-root", "project-root", "powershell", "dry-run"]);
  const unknown = Object.keys(values).filter((name) => !allowed.has(name));
  if (unknown.length) throw new Error("Unsupported batch option: --" + unknown.join(", --"));
  if (!values.spec) throw new Error("--spec is required");
  return values;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExitPromise(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 2, error }));
    child.once("exit", (code, signal) => resolve({ code: Number.isInteger(code) ? code : 2, signal }));
  });
}

function defaultSpawnWorker({ projectRoot, powershell, configPath, outputRoot, batchRoot, attemptId, run }) {
  const args = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "scripts", "Run-FeedWorkflow.ps1"),
    "-TaskId", run.taskId,
    "-Count", String(run.count),
    "-MachineNumber", run.machine,
    "-VideoPolicy", "skip_and_count",
    "-VideoDwellMs", "0",
    "-OutputRoot", outputRoot,
    "-BatchRoot", batchRoot,
    "-BatchAttemptId", attemptId,
  ];
  if (configPath) args.push("-ConfigPath", configPath);
  return spawn(powershell, args, {
    cwd: projectRoot,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function appendEvent(paths, event, sequence) {
  appendFileSync(paths.events, JSON.stringify({
    schemaVersion: 1,
    seq: sequence,
    at: new Date().toISOString(),
    ...event,
  }) + "\n", "utf8");
}

async function waitForReady(paths, stage, runs, workers, {
  timeoutMs,
  pollMs,
  heartbeat,
}) {
  const directory = stage === "lock" ? paths.lockReadyDir : paths.preflightReadyDir;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    heartbeat();
    const ready = runs.every((run) => existsSync(path.join(directory, run.taskId + ".json")));
    if (ready) return;
    const exited = workers.find((worker) => worker.exitResult);
    if (exited) {
      throw Object.assign(new Error("A batch worker exited before the " + stage + " barrier"), {
        code: "BATCH_WORKER_EARLY_EXIT",
        taskId: exited.run.taskId,
      });
    }
    await sleep(pollMs);
  }
  throw Object.assign(new Error("Timed out waiting for batch " + stage + " readiness"), {
    code: stage === "lock" ? "BATCH_LOCK_TIMEOUT" : "BATCH_START_TIMEOUT",
  });
}

function publicWorkerResult(run, outputRoot, exitResult) {
  const summaryPath = path.join(outputRoot, run.taskId, "summary.json");
  if (existsSync(summaryPath)) {
    const summary = readJson(summaryPath);
    return {
      machine: run.machine,
      taskId: run.taskId,
      status: summary.status,
      viewedCount: summary.viewedCount,
      skippedCount: summary.skippedCount,
      failureSignature: summary.failureSignature ?? null,
      summaryPath: path.relative(outputRoot, summaryPath).replaceAll("\\", "/"),
    };
  }
  return {
    machine: run.machine,
    taskId: run.taskId,
    status: "failed",
    viewedCount: 0,
    skippedCount: 0,
    failureSignature: exitResult?.error?.code ?? "batch:worker_exit_" + String(exitResult?.code ?? 2),
    summaryPath: null,
  };
}

export async function runFeedBatch(specInput, options = {}, runtime = {}) {
  const spec = normalizeFeedBatchSpec(specInput);
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(projectRoot, "data", "feed-batches"));
  const feedOutputRoot = path.resolve(options.feedOutputRoot ?? path.join(projectRoot, "data", "feed"));
  const batchRoot = path.join(outputRoot, spec.batchId);
  if (path.dirname(batchRoot) !== outputRoot) throw new Error("batchId escaped the batch output root");
  const attemptId = options.attemptId ?? createBatchAttemptId();
  if (!SAFE_ID.test(attemptId)) throw new Error("attemptId is invalid");
  const paths = initializeBatchControl(batchRoot, attemptId);
  const manifest = createBatchManifest(spec);
  const manifestState = writeManifestOnce(paths, manifest);

  if (!manifestState.created && existsSync(paths.summary)) {
    const previous = readJson(paths.summary);
    if (["completed", "duplicate"].includes(previous.status)) {
      const duplicate = buildBatchSummary({ manifest, attemptId, results: previous.results ?? [], duplicate: true });
      writeJsonAtomicSync(paths.attemptSummary, duplicate);
      return duplicate;
    }
  }

  if (options.dryRun) {
    const summary = {
      schemaVersion: 1,
      batchId: spec.batchId,
      specHash: manifest.specHash,
      attemptId,
      status: "dry_run",
      duplicate: false,
      maxParallel: spec.maxParallel,
      fuse: null,
      results: spec.runs.map((run) => ({ ...run, status: "planned" })),
    };
    writeJsonAtomicSync(paths.attemptSummary, summary);
    writeJsonAtomicSync(paths.summary, summary);
    return summary;
  }

  let sequence = 0;
  let shuttingDown = false;
  const heartbeat = () => writeBatchLease(paths, { attemptId });
  const spawnWorker = runtime.spawnWorker ?? defaultSpawnWorker;
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, Number(options.heartbeatMs ?? 2000));
  heartbeatTimer.unref?.();
  appendEvent(paths, { type: "batch_started", attemptId }, ++sequence);

  const workers = spec.runs.map((run) => {
    const child = spawnWorker({
      projectRoot,
      powershell: options.powershell ?? "powershell.exe",
      configPath: options.configPath,
      outputRoot: feedOutputRoot,
      batchRoot,
      attemptId,
      run,
    });
    const worker = { run, child, exitResult: null, exitPromise: null };
    worker.exitPromise = childExitPromise(child).then((result) => {
      worker.exitResult = result;
      return result;
    });
    child.stdout?.on("data", (chunk) => runtime.stdout?.write?.(chunk));
    child.stderr?.on("data", (chunk) => runtime.stderr?.write?.(chunk));
    return worker;
  });

  const terminateWorkers = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const worker of workers) {
      if (!worker.exitResult) worker.child.kill?.("SIGTERM");
    }
  };
  const handleSignal = () => {
    tripBatchFuse(paths, { attemptId, category: "batch_integrity", code: "BATCH_PARENT_LOST" });
    terminateWorkers();
  };
  if (!runtime.disableSignalHandlers) {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }

  let fuse = null;
  try {
    const waitOptions = {
      timeoutMs: Number(options.barrierTimeoutMs ?? 30000),
      pollMs: Number(options.pollMs ?? 100),
      heartbeat,
    };
    await waitForReady(paths, "lock", spec.runs, workers, waitOptions);
    releaseBatchBarrier(paths, "preflight");
    appendEvent(paths, { type: "preflight_released" }, ++sequence);
    await waitForReady(paths, "preflight", spec.runs, workers, waitOptions);
    releaseBatchBarrier(paths, "start");
    appendEvent(paths, { type: "start_released" }, ++sequence);

    await Promise.all(workers.map((worker) => worker.exitPromise));
    fuse = readBatchFuse(paths);
    if (!fuse) {
      const failures = workers
        .map((worker) => publicWorkerResult(worker.run, feedOutputRoot, worker.exitResult))
        .filter((result) => result.status !== "completed" && result.failureSignature);
      if (failures.length === spec.runs.length && new Set(failures.map((entry) => entry.failureSignature)).size === 1) {
        fuse = tripBatchFuse(paths, {
          attemptId,
          category: "batch_integrity",
          code: "BATCH_SYSTEMIC_FAILURE",
        }).fuse;
      }
    }
    if (!fuse) {
      const failed = workers.find((worker) => worker.exitResult.code !== 0);
      if (failed) {
        const workerSummary = publicWorkerResult(failed.run, feedOutputRoot, failed.exitResult);
        const code = String(workerSummary.failureSignature ?? "BATCH_WORKER_FAILED").split(":").at(-1).toUpperCase();
        const category = classifyFeedBatchFailure(code);
        fuse = tripBatchFuse(paths, { attemptId, category, code, taskId: failed.run.taskId }).fuse;
      }
    }
  } catch (error) {
    const code = String(error?.code ?? "BATCH_ORCHESTRATION_FAILED");
    fuse = tripBatchFuse(paths, {
      attemptId,
      category: classifyFeedBatchFailure(code),
      code,
      taskId: error?.taskId ?? null,
    }).fuse;
    terminateWorkers();
    await Promise.race([
      Promise.all(workers.map((worker) => worker.exitPromise)),
      sleep(Number(options.shutdownTimeoutMs ?? 5000)),
    ]);
  } finally {
    clearInterval(heartbeatTimer);
    if (!runtime.disableSignalHandlers) {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
    }
  }

  fuse ??= readBatchFuse(paths);
  const results = workers.map((worker) => publicWorkerResult(worker.run, feedOutputRoot, worker.exitResult));
  const summary = buildBatchSummary({ manifest, attemptId, results, fuse });
  writeJsonAtomicSync(paths.attemptSummary, summary);
  writeJsonAtomicSync(paths.summary, summary);
  appendEvent(paths, { type: "batch_finished", status: summary.status }, ++sequence);
  return summary;
}

async function runCli(argv) {
  const options = parseCli(argv);
  const specPath = path.resolve(options.spec);
  const summary = await runFeedBatch(readJson(specPath), {
    projectRoot: options["project-root"],
    outputRoot: options["output-root"],
    configPath: options.config,
    powershell: options.powershell,
    dryRun: Boolean(options["dry-run"]),
  });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  return ["completed", "duplicate", "dry_run"].includes(summary.status) ? 0 : 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(JSON.stringify({ status: "failed", message: String(error?.message ?? error) }) + "\n");
    process.exitCode = 2;
  });
}
