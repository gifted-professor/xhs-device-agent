import assert from "node:assert/strict";
import test from "node:test";

import { buildDispatch, parseCliArgs, runCli } from "../scripts/xhs-agent.mjs";

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
  assert.deepEqual(dispatch.args.slice(-3), ["-DryRun", "-DeviceAlias", "acceptance-device"]);
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

test("named XHS interaction commands route through the matrix executor", () => {
  const simple = new Map([
    ["like", "Like"],
    ["favorite", "Favorite"],
    ["collect", "Favorite"],
    ["follow", "Follow"],
    ["delete", "Delete"],
  ]);
  for (const [command, action] of simple) {
    const dispatch = buildDispatch(parseCliArgs([command, "--device", "device-01"]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
    assert.deepEqual(dispatch.args.slice(-4), ["-Action", action, "-DeviceAlias", "device-01"]);
  }

  for (const [command, action] of [["comment", "Comment"], ["publish", "Publish"]]) {
    assert.throws(
      () => buildDispatch(parseCliArgs([command, "--device", "device-01"])),
      /--text is required/u,
    );
    const dispatch = buildDispatch(parseCliArgs([
      command, "--device", "device-01", "--text", "测试内容",
    ]));
    assert.deepEqual(dispatch.args.slice(-6), [
      "-Action", action, "-DeviceAlias", "device-01", "-Text", "测试内容",
    ]);
  }
});

test("feed run requires one machine and routes deterministic positions", () => {
  assert.throws(
    () => buildDispatch(parseCliArgs(["feed", "run", "--task-id", "feed-001", "--count", "10"])),
    /exactly one machine number or machine name/u,
  );
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "feed", "run", "--device", "device-01", "--device", "device-02",
      "--task-id", "feed-001", "--count", "10",
    ])),
    /exactly one machine number or machine name/u,
  );
  const dispatch = buildDispatch(parseCliArgs([
    "feed", "run",
    "--machine", "04",
    "--task-id", "feed-001",
    "--count", "10",
    "--like-at", "5",
    "--favorite-at", "10",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Run-FeedWorkflow.ps1")));
  assert.deepEqual(dispatch.args.slice(-10), [
    "-TaskId", "feed-001",
    "-Count", "10",
    "-MachineNumber", "04",
    "-LikeAt", "5",
    "-FavoriteAt", "10",
  ]);

  const customized = buildDispatch(parseCliArgs([
    "feed", "run",
    "--machine-name", "UNIQUE_VISIBLE_NAME",
    "--task-id", "feed-002",
    "--count", "10",
    "--image-min-seconds", "2",
    "--image-max-seconds", "4",
    "--video-min-seconds", "8",
    "--video-max-seconds", "15",
  ]));
  assert.deepEqual(customized.args.slice(-8), [
    "-ImageMinSeconds", "2",
    "-ImageMaxSeconds", "4",
    "-VideoMinSeconds", "8",
    "-VideoMaxSeconds", "15",
  ]);
});

test("trusted-10 feed template pins the verified count, interactions, and video dwell", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "feed", "run",
    "--template", "trusted-10",
    "--machine", "04",
    "--task-id", "feed-trusted-001",
  ]));
  assert.deepEqual(dispatch.args.slice(-14), [
    "-TaskId", "feed-trusted-001",
    "-Count", "10",
    "-MachineNumber", "04",
    "-LikeAt", "5",
    "-FavoriteAt", "7",
    "-VideoMinSeconds", "5",
    "-VideoMaxSeconds", "5",
  ]);
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "feed", "run",
      "--template", "trusted-10",
      "--machine", "04",
      "--task-id", "feed-trusted-002",
      "--favorite-at", "8",
    ])),
    /fixes --favorite-at=7/u,
  );
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "feed", "run",
      "--template", "missing",
      "--machine", "04",
      "--task-id", "feed-trusted-003",
    ])),
    /Unknown feed template/u,
  );
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
  assert.match(text, /--machine 04/u);
  assert.match(text, /--machine-name/u);
  assert.doesNotMatch(text, /--device\s+device-/u);
  for (const command of ["like", "favorite", "follow", "comment", "publish", "delete"]) {
    assert.match(text, new RegExp(`xhs\\.cmd ${command}`, "u"));
  }
});
