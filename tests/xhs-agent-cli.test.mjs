import assert from "node:assert/strict";
import test from "node:test";

import { buildDispatch, parseCliArgs, runCli } from "../scripts/xhs-agent.mjs";

test("long help flag remains a positional help command", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { positional: ["--help"], options: Object.create(null) });
  assert.equal(buildDispatch(parseCliArgs(["--help"])).type, "help");
});

test("repo status routes through the unified entry and supports JSON", () => {
  const plain = buildDispatch(parseCliArgs(["repo", "status"]));
  assert.ok(plain.args.some((value) => value.endsWith("repo-status.mjs")));
  const json = buildDispatch(parseCliArgs(["repo", "status", "--json"]));
  assert.equal(json.args.at(-1), "--json");
});

test("repo audit routes through the unified entry and supports JSON", () => {
  const plain = buildDispatch(parseCliArgs(["repo", "audit"]));
  assert.ok(plain.args.some((value) => value.endsWith("repo-audit.mjs")));
  const json = buildDispatch(parseCliArgs(["repo", "audit", "--json"]));
  assert.equal(json.args.at(-1), "--json");
});

test("repo policy routes through the unified entry and supports JSON", () => {
  const plain = buildDispatch(parseCliArgs(["repo", "policy"]));
  assert.ok(plain.args.some((value) => value.endsWith("repo-policy-scan.mjs")));
  const json = buildDispatch(parseCliArgs(["repo", "policy", "--json"]));
  assert.equal(json.args.at(-1), "--json");
});

test("capability activation stays behind exact hashes and an explicit human flag", () => {
  assert.throws(() => buildDispatch(parseCliArgs([
    "capability", "accept", "--profile", "profile.json", "--evidence", "evidence.json",
    "--confirm-profile-hash", "a".repeat(64), "--confirm-evidence-hash", "b".repeat(64),
  ])), /confirm-human/u);
  const dispatch = buildDispatch(parseCliArgs([
    "capability", "accept", "--profile", "profile.json", "--evidence", "evidence.json",
    "--confirm-profile-hash", "a".repeat(64), "--confirm-evidence-hash", "b".repeat(64), "--confirm-human",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("capability-cli.mjs")));
  assert.equal(dispatch.args.at(-1), "--confirm-human");
});

test("task run enters through the unified dry-run planner and supervised live wrapper", () => {
  const dispatch = buildDispatch(parseCliArgs(["task", "run", "--spec", "data/task.json", "--dry-run", "--json"]));
  assert.ok(dispatch.args.some((value) => value.endsWith("task-runner.mjs")));
  assert.deepEqual(dispatch.args.slice(-4), ["--spec", "data/task.json", "--dry-run", "--json"]);
  const live = buildDispatch(parseCliArgs([
    "task", "run", "--spec", "data/task.json", "--confirm-plan-hash", "a".repeat(64),
  ]));
  assert.equal(live.executable, "powershell.exe");
  assert.ok(live.args.some((value) => value.endsWith("Run-TaskWorkflow.ps1")));
  assert.deepEqual(live.args.slice(-4), ["-SpecPath", "data/task.json", "-ConfirmPlanHash", "a".repeat(64)]);
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "task", "run", "--spec", "data/task.json", "--dry-run", "--confirm-plan-hash", "a".repeat(64),
    ])),
    /does not accept live configuration/u,
  );
});

test("unified CLI routes a targeted XHS open through the matrix action wrapper", () => {
  const dispatch = buildDispatch(parseCliArgs(["device", "open-xhs", "--machine", "04"]));
  assert.equal(dispatch.executable, "powershell.exe");
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
  assert.deepEqual(dispatch.args.slice(-4), ["-Action", "OpenXhs", "-MachineNumber", "04"]);
});

test("host status and start remain available through the unified entry", () => {
  for (const command of ["status", "start"]) {
    const dispatch = buildDispatch(parseCliArgs(["host", command]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XiaoweiHost.ps1")));
    assert.equal(dispatch.args.at(-1), command === "start" ? "Start" : "Status");
  }
});

test("config paths containing spaces stay one argument and split shell values fail closed", () => {
  const configPath = "C:\\Users\\windows 10\\Desktop\\coding\\xhs-device-agent\\data\\candidate config.psd1";
  const dispatch = buildDispatch(parseCliArgs(["doctor", "--config", configPath]));
  assert.equal(dispatch.args.at(-2), "-ConfigPath");
  assert.equal(dispatch.args.at(-1), configPath);

  assert.throws(
    () => parseCliArgs([
      "doctor", "--config", "C:\\Users\\windows", "10\\Desktop\\coding\\candidate-config.psd1",
    ]),
    /keep each option value as one shell argument/u,
  );
});

test("visible Xiaowei window capture stays behind the unified host entry", () => {
  const dispatch = buildDispatch(parseCliArgs(["host", "capture"]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XiaoweiHost.ps1")));
  assert.deepEqual(dispatch.args.slice(-2), ["-Action", "Capture"]);
  const explicit = buildDispatch(parseCliArgs(["host", "capture", "--window-handle", "123"]));
  assert.deepEqual(explicit.args.slice(-4), ["-Action", "Capture", "-WindowHandle", "123"]);
});

test("ordinary device commands reject implicit all-device targeting", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs(["device", "screen"])),
    /explicit --machine, --machine-name, or --group/u,
  );
});

test("internal device bindings remain compatible but cannot be combined with a group", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "device", "ui", "--device", "device-01", "--device", "device-02",
  ]));
  assert.deepEqual(dispatch.args.slice(-4), ["-Action", "DumpUi", "-DeviceAliasesCsv", "device-01,device-02"]);
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "device", "ui", "--device", "device-01", "--device", "device-02", "--group", "content",
    ])),
    /Use one of/u,
  );
});

test("machine numbers are repeatable and visible names stay a single unambiguous selector", () => {
  const multiple = buildDispatch(parseCliArgs([
    "device", "ui", "--machine", "01", "--machine", "03",
  ]));
  assert.deepEqual(multiple.args.slice(-4), ["-Action", "DumpUi", "-MachineNumbersCsv", "01,03"]);

  const named = buildDispatch(parseCliArgs([
    "device", "screen", "--machine-name", "VISIBLE_NAME",
  ]));
  assert.deepEqual(named.args.slice(-4), ["-Action", "Screenshot", "-MachineName", "VISIBLE_NAME"]);

  assert.throws(
    () => buildDispatch(parseCliArgs([
      "device", "screen", "--machine", "04", "--machine-name", "VISIBLE_NAME",
    ])),
    /Use one of/u,
  );
});

test("confirmation and external-sync flags reject misleading equals values", () => {
  for (const flag of ["confirm", "confirm-external-sync", "confirm-single-device-and-sync-off", "sync-lark"]) {
    assert.throws(
      () => parseCliArgs([`--${flag}=false`]),
      /bare confirmation flag/u,
    );
  }
});

test("stopping an app requires explicit confirmation reason and rollback", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs(["app", "stop", "--device", "device-01", "--package", "com.example.app"])),
    /requires --confirm/u,
  );
  const dispatch = buildDispatch(parseCliArgs([
    "app", "stop", "--device", "device-01", "--package", "com.example.app",
    "--confirm", "--reason", "approved maintenance", "--rollback", "reopen the app",
  ]));
  assert.ok(dispatch.args.includes("-ConfirmAction"));
  assert.ok(dispatch.args.includes("-ConfirmationReason"));
  assert.ok(dispatch.args.includes("-RollbackInfo"));
});

test("screen power and settings commands stay behind the local-change confirmation gate", () => {
  for (const command of ["screen-off", "screen-on", "settings"]) {
    assert.throws(
      () => buildDispatch(parseCliArgs(["device", command, "--device", "device-01"])),
      /requires --confirm/u,
    );
    const dispatch = buildDispatch(parseCliArgs([
      "device", command, "--device", "device-01",
      "--confirm", "--reason", "approved maintenance", "--rollback", "restore prior state",
    ]));
    assert.ok(dispatch.args.includes("-ConfirmAction"));
  }
});

test("confirmation reason and rollback require at least three trimmed characters", () => {
  for (const [option, value] of [["reason", " ok "], ["rollback", "  x "]]) {
    const argv = [
      "device", "screen-off", "--device", "device-01",
      "--confirm", "--reason", "approved maintenance", "--rollback", "restore prior state",
    ];
    argv[argv.indexOf(`--${option}`) + 1] = value;
    assert.throws(
      () => buildDispatch(parseCliArgs(argv)),
      new RegExp(`--${option} must contain at least 3 characters`, "u"),
    );
  }

  const dispatch = buildDispatch(parseCliArgs([
    "device", "screen-off", "--device", "device-01",
    "--confirm", "--reason", "  approved maintenance  ", "--rollback", "  restore prior state  ",
  ]));
  assert.equal(dispatch.args[dispatch.args.indexOf("-ConfirmationReason") + 1], "approved maintenance");
  assert.equal(dispatch.args[dispatch.args.indexOf("-RollbackInfo") + 1], "restore prior state");
});

test("each command rejects options that belong to a different command", () => {
  const cases = [
    [["api", "catalog", "--config", "config/local.psd1"], /api catalog does not support option: --config/u],
    [["device", "screen", "--device", "device-01", "--package", "com.example.app"], /device screen does not support option: --package/u],
    [["app", "list", "--device", "device-01", "--confirm"], /app list does not support option: --confirm/u],
    [["ramp", "run", "--profile", "profile.json", "--device", "device-01"], /ramp run does not support option: --device/u],
    [["inventory", "collect", "--output", "out"], /inventory collect does not support option: --output/u],
  ];
  for (const [argv, expected] of cases) {
    assert.throws(() => buildDispatch(parseCliArgs(argv)), expected);
  }
});

test("handoff requires exactly one machine and synchronization confirmation", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "handoff", "review", "--task", "task.json", "--candidate", "candidate-1", "--device", "device-01",
    ])),
    /confirm-single-device-and-sync-off/u,
  );
});

test("research takes live targets from task.deviceGroup and accepts aliases only for dry-run", () => {
  assert.throws(() => buildDispatch(parseCliArgs([
    "research", "run", "--task", "task.json", "--device", "device-01",
  ])), /only for dry-run/u);
  const dispatch = buildDispatch(parseCliArgs([
    "research", "run", "--task", "task.json", "--dry-run", "--device", "acceptance-device",
  ]));
  assert.deepEqual(dispatch.args.slice(-3), ["-DryRun", "-DeviceAliasesCsv", "acceptance-device"]);
});

test("research review sync uses the unified entry and explicit external confirmation", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs(["research", "sync-review", "--review", "queue.jsonl"])),
    /confirm-external-sync/u,
  );
  const dispatch = buildDispatch(parseCliArgs([
    "research", "sync-review", "--review", "queue.jsonl", "--confirm-external-sync",
    "--config", "config/local.psd1",
  ]));
  assert.equal(dispatch.executable, "powershell.exe");
  assert.ok(dispatch.args.some((value) => value.endsWith("Sync-ResearchReview.ps1")));
  assert.deepEqual(dispatch.args.slice(-5), [
    "-ReviewPath", "queue.jsonl", "-ConfirmExternalSync", "-ConfigPath", "config/local.psd1",
  ]);
  assert.equal(dispatch.args.some((value) => /token/iu.test(value)), false);
});

test("named XHS interaction commands are retired from the legacy matrix entry", () => {
  for (const command of ["like", "favorite", "collect", "follow", "comment", "publish", "delete"]) {
    assert.throws(
      () => buildDispatch(parseCliArgs([command, "--device", "device-01"])),
      /retired as a direct command/u,
    );
  }
});

test("feed run converts positions and any explicit machine list through the unified task wrapper", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs(["feed", "run", "--task-id", "feed-001", "--count", "10"])),
    /exactly one machine selector mode/u,
  );
  const dispatch = buildDispatch(parseCliArgs([
    "feed", "run",
    "--machine", "02",
    "--machine", "04",
    "--task-id", "feed-001",
    "--count", "10",
    "--like-at", "5",
    "--favorite-at", "10",
    "--max-parallel", "2",
    "--dry-run",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Run-TaskCompatibility.ps1")));
  assert.deepEqual(dispatch.args.slice(-15), [
    "-Kind", "Feed", "-TaskId", "feed-001",
    "-Count", "10",
    "-MachineNumbersCsv", "02,04",
    "-LikeAt", "5",
    "-FavoriteAt", "10",
    "-MaxParallel", "2",
    "-DryRun",
  ]);

  const confirmed = buildDispatch(parseCliArgs([
    "feed", "run",
    "--machine-name", "UNIQUE_VISIBLE_NAME",
    "--task-id", "feed-002",
    "--count", "10",
    "--confirm-plan-hash", "a".repeat(64),
  ]));
  assert.equal(confirmed.args[confirmed.args.indexOf("-ConfirmPlanHash") + 1], "a".repeat(64));
  assert.throws(() => buildDispatch(parseCliArgs([
    "feed", "run", "--machine", "02", "--task-id", "feed-003", "--count", "10", "--video-policy", "normal",
  ])), /does not support option/u);
});

test("feed batch accepts only a strict spec and optional dry-run controls", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "feed", "batch", "--spec", "data/feed-batch-001.json", "--dry-run",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Run-TaskCompatibility.ps1")));
  assert.deepEqual(dispatch.args.slice(-5), ["-Kind", "Batch", "-LegacySpecPath", "data/feed-batch-001.json", "-DryRun"]);
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "feed", "batch", "--spec", "batch.json", "--machine", "04",
    ])),
    /feed batch does not support option: --machine/u,
  );
  assert.throws(
    () => buildDispatch(parseCliArgs(["feed", "batch", "--dry-run"])),
    /--spec is required/u,
  );
});

test("research run is a unified compatibility conversion with the same one-confirmation controls", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "research", "run", "--task", "data/research.json", "--device", "private-a", "--device", "private-b",
    "--max-parallel", "2", "--dry-run", "--json",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Run-TaskCompatibility.ps1")));
  assert.deepEqual(dispatch.args.slice(-10), [
    "-Kind", "Research", "-LegacySpecPath", "data/research.json", "-DryRun",
    "-DeviceAliasesCsv", "private-a,private-b", "-MaxParallel", "2", "-Json",
  ]);
  const live = buildDispatch(parseCliArgs([
    "research", "run", "--task", "data/research.json", "--confirm-plan-hash", "a".repeat(64),
  ]));
  assert.equal(live.args[live.args.indexOf("-ConfirmPlanHash") + 1], "a".repeat(64));
  assert.throws(() => buildDispatch(parseCliArgs([
    "research", "run", "--task", "data/research.json", "--device", "private-a",
  ])), /only for dry-run aliases/u);
});

test("inventory collection is local-only unless sync is explicitly selected", () => {
  const local = buildDispatch(parseCliArgs(["inventory", "collect"]));
  assert.equal(local.args.includes("-SyncLark"), false);
  const external = buildDispatch(parseCliArgs(["inventory", "collect", "--sync-lark"]));
  assert.equal(external.args.at(-1), "-SyncLark");
});

test("help completes without spawning a child process", () => {
  let spawned = false;
  let text = "";
  const status = runCli(["help"], {
    spawn: () => { spawned = true; return { status: 0 }; },
    output: { write(value) { text += value; } },
    errorOutput: { write() {} },
  });
  assert.equal(status, 0);
  assert.equal(spawned, false);
  assert.match(text, /统一入口/u);
  assert.match(text, /--machine 02/u);
  assert.match(text, /--machine-name/u);
  assert.doesNotMatch(text, /--device\s+device-/u);
  for (const command of ["like", "favorite", "follow", "comment", "publish", "delete"]) {
    assert.doesNotMatch(text, new RegExp(`xhs\\.cmd ${command}`, "u"));
  }
  assert.match(text, /设备动作只允许从 xhs\.cmd 进入/u);
});
