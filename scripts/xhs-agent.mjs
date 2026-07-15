import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BOOLEAN_OPTIONS = new Set([
  "confirm",
  "confirm-external-sync",
  "confirm-single-device-and-sync-off",
  "dry-run",
  "generate-only",
  "sync-lark",
]);
const REPEATABLE_OPTIONS = new Set(["machine", "device"]);
const FEED_TEMPLATES = Object.freeze({
  "trusted-10": Object.freeze({
    count: "10",
    "like-at": "5",
    "favorite-at": "7",
    "video-policy": "skip_and_count",
    "video-dwell-ms": "0",
  }),
});

const HELP = `XHS Device Agent 统一入口

Shell 调用：
  PowerShell / cmd.exe:  .\\xhs.cmd <command>
  Git Bash / MSYS:       bash ./xhs.cmd <command>

常用命令：
  .\\xhs.cmd doctor
  .\\xhs.cmd host status
  .\\xhs.cmd host start
  .\\xhs.cmd host capture
  .\\xhs.cmd api catalog
  .\\xhs.cmd device list
  .\\xhs.cmd device screen --machine 04
  .\\xhs.cmd device screen --machine-name VISIBLE_NAME
  .\\xhs.cmd device ui --group content
  .\\xhs.cmd device open-xhs --machine 04
  .\\xhs.cmd device open-profile --machine 04
  .\\xhs.cmd device home --machine 04
  .\\xhs.cmd device back --machine 04
  .\\xhs.cmd device screen-off --machine 04 --confirm --reason "..." --rollback "重新亮屏"
  .\\xhs.cmd device screen-on --machine 04 --confirm --reason "..." --rollback "恢复原熄屏状态"
  .\\xhs.cmd device settings --machine 04 --confirm --reason "..." --rollback "返回原应用"
  .\\xhs.cmd app list --machine 04
  .\\xhs.cmd app open --machine 04 --package com.xingin.xhs
  .\\xhs.cmd app stop --machine 04 --package com.example.app --confirm --reason "..." --rollback "重新打开应用"
  .\\xhs.cmd like --machine 04
  .\\xhs.cmd favorite --machine 04
  .\\xhs.cmd follow --machine 04
  .\\xhs.cmd comment --machine 04 --text "评论内容"
  .\\xhs.cmd publish --machine 04 --text "发布内容"
  .\\xhs.cmd delete --machine 04
  .\\xhs.cmd feed run --template trusted-10 --machine 04 --task-id feed-001
    优先可信模板：10 条、第 5 条点赞、第 7 条收藏、视频进入后立即计数
  .\\xhs.cmd feed run --machine 04 --task-id feed-002 --count 10 --like-at 5 --favorite-at 7
    默认停留：图文 3-6 秒，视频 10-20 秒；视频也可用 --video-policy 和 --video-dwell-ms 配置
  .\\xhs.cmd feed batch --spec data/feed-batch.example.json --dry-run
    V1.1 只读批次：显式指定 1-2 台机器；两台必须同时通过锁定和预检才开始
  .\\xhs.cmd research run --task data/task.json [--dry-run]
  .\\xhs.cmd research sync-review --review data/research/TASK/human-review.jsonl --confirm-external-sync
  .\\xhs.cmd ramp run --profile data/accounts/example/profile.json [--dry-run]
  .\\xhs.cmd handoff review --task data/task.json --candidate ID --machine 04 --confirm-single-device-and-sync-off
  .\\xhs.cmd handoff ramp --profile data/accounts/example/profile.json --candidate ID --confirm-single-device-and-sync-off
  .\\xhs.cmd inventory collect [--sync-lark]

通用选项：
  --config PATH     使用指定的本地配置；默认 config/local.psd1
  --machine NUMBER  按两位机器编号选择，可重复；例如 04
  --machine-name N  按机器显示名称选择；名称重复时必须改用编号
  --group NAME      选择已配置分组；不能和机器选择同时使用

普通设备动作必须明确指定 --machine、--machine-name 或 --group。内部设备绑定仅供程序兼容，不用于咨询和报告。除上述显式语义命令外，通用互动、登录验证、支付和账号变更不在此入口中。
`;

export function parseCliArgs(argv) {
  const positional = [];
  const options = Object.create(null);
  let optionParsingStarted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) {
      if (optionParsingStarted) {
        throw new Error(
          "Unexpected positional argument after an option; keep each option value as one shell argument. " +
          "Set the command working directory to the project root and prefer project-relative paths",
        );
      }
      positional.push(token);
      continue;
    }
    optionParsingStarted = true;
    const separator = token.indexOf("=");
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (!name) throw new Error("Option name cannot be empty");
    let value;
    if (separator >= 0) {
      if (BOOLEAN_OPTIONS.has(name)) {
        throw new Error(`--${name} is a bare confirmation flag and cannot use =${token.slice(separator + 1)}`);
      }
      value = token.slice(separator + 1);
    } else if (BOOLEAN_OPTIONS.has(name)) {
      value = true;
    } else {
      index += 1;
      if (index >= argv.length || String(argv[index]).startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      value = String(argv[index]);
    }
    if (REPEATABLE_OPTIONS.has(name)) {
      options[name] = [...(options[name] ?? []), value];
    } else {
      if (Object.hasOwn(options, name)) throw new Error(`--${name} may be provided only once`);
      options[name] = value;
    }
  }
  return { positional, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (value === undefined || value === "") throw new Error(`--${name} is required`);
  return value;
}

function requireConfirmationDetail(options, name) {
  const value = String(requireOption(options, name)).trim();
  if (value.length < 3) throw new Error(`--${name} must contain at least 3 characters after trimming`);
  return value;
}

function assertAllowedOptions(options, allowed, commandLabel) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(options).filter((name) => !allowedSet.has(name));
  if (!unknown.length) return;
  const formatted = unknown.map((name) => `--${name}`).join(", ");
  throw new Error(`${commandLabel} does not support option${unknown.length === 1 ? "" : "s"}: ${formatted}`);
}

function psScript(name, args = []) {
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPT_DIR, name), ...args],
  };
}

function nodeScript(name, args = []) {
  return { executable: process.execPath, args: [path.join(SCRIPT_DIR, name), ...args] };
}

function appendOption(args, options, option, parameter) {
  if (options[option] !== undefined) args.push(parameter, String(options[option]));
}

function applyFeedTemplate(options) {
  if (options.template === undefined) return options;
  const name = String(options.template);
  const template = FEED_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown feed template: ${name}; supported templates: ${Object.keys(FEED_TEMPLATES).join(", ")}`);
  }
  const effective = { ...options };
  for (const [option, expected] of Object.entries(template)) {
    if (options[option] !== undefined && String(options[option]) !== expected) {
      throw new Error(`Feed template ${name} fixes --${option}=${expected}; remove the conflicting override`);
    }
    effective[option] = expected;
  }
  return effective;
}

function appendTargets(args, options, { required = true } = {}) {
  const machines = options.machine ?? [];
  const machineName = options["machine-name"];
  const devices = options.device ?? [];
  const modes = [machines.length > 0, machineName !== undefined, devices.length > 0, options.group !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Error("Use one of --machine, --machine-name, or --group");
  if (required && modes === 0) {
    throw new Error("This command requires an explicit --machine, --machine-name, or --group target");
  }
  if (machines.length === 1) args.push("-MachineNumber", String(machines[0]));
  if (machines.length > 1) args.push("-MachineNumbersCsv", machines.map(String).join(","));
  if (machineName !== undefined) args.push("-MachineName", String(machineName));
  if (devices.length === 1) args.push("-DeviceAlias", String(devices[0]));
  if (devices.length > 1) args.push("-DeviceAliasesCsv", devices.map(String).join(","));
  if (options.group) args.push("-Group", String(options.group));
}

function appendConfirmation(args, options) {
  if (!options.confirm) return;
  args.push("-ConfirmAction");
  args.push("-ConfirmationReason", requireConfirmationDetail(options, "reason"));
  args.push("-RollbackInfo", requireConfirmationDetail(options, "rollback"));
}

function matrixDispatch(action, options, { targetRequired = true, packageRequired = false, confirmation = false } = {}) {
  const args = ["-Action", action];
  appendOption(args, options, "config", "-ConfigPath");
  appendTargets(args, options, { required: targetRequired });
  if (packageRequired) args.push("-PackageName", String(requireOption(options, "package")));
  if (confirmation) {
    if (!options.confirm) throw new Error("This device-local change requires --confirm, --reason, and --rollback");
    appendConfirmation(args, options);
  }
  return psScript("Invoke-MatrixAction.ps1", args);
}

function interactionDispatch(action, options, { textRequired = false } = {}) {
  const args = ["-Action", action];
  appendOption(args, options, "config", "-ConfigPath");
  appendTargets(args, options);
  if (textRequired) args.push("-Text", String(requireOption(options, "text")));
  return psScript("Invoke-MatrixAction.ps1", args);
}

export function buildDispatch(parsed) {
  const { positional, options } = parsed;
  const [area = "help", command = ""] = positional;
  if (positional.length > 2) throw new Error("Too many positional arguments; use named --options after the command");

  if (area === "help" || area === "--help" || area === "-h") {
    assertAllowedOptions(options, [], "help");
    return { type: "help" };
  }
  if (area === "doctor") {
    assertAllowedOptions(options, ["config"], "doctor");
    const args = ["-ProbeApi"];
    appendOption(args, options, "config", "-ConfigPath");
    return psScript("Matrix-Preflight.ps1", args);
  }
  if (area === "host" && (command === "status" || command === "start")) {
    assertAllowedOptions(options, ["config"], `host ${command}`);
    const args = ["-Action", command === "start" ? "Start" : "Status"];
    appendOption(args, options, "config", "-ConfigPath");
    return psScript("Manage-XiaoweiHost.ps1", args);
  }
  if (area === "host" && command === "capture") {
    assertAllowedOptions(options, ["config", "window-handle", "output"], "host capture");
    const args = ["-Action", "Capture"];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "window-handle", "-WindowHandle");
    appendOption(args, options, "output", "-OutputPath");
    return psScript("Manage-XiaoweiHost.ps1", args);
  }
  if (area === "api" && command === "catalog") {
    assertAllowedOptions(options, [], "api catalog");
    return nodeScript("xiaowei-api.mjs", ["catalog"]);
  }
  if (area === "api" && (command === "probe" || command === "status")) {
    assertAllowedOptions(options, ["config"], `api ${command}`);
    const args = ["-ProbeApi"];
    appendOption(args, options, "config", "-ConfigPath");
    return psScript("Matrix-Preflight.ps1", args);
  }
  if (area === "device") {
    const actions = new Map([
      ["list", ["Inventory", { targetRequired: false }]],
      ["ui", ["DumpUi", {}]],
      ["screen", ["Screenshot", {}]],
      ["open-xhs", ["OpenXhs", {}]],
      ["open-profile", ["OpenProfile", {}]],
      ["home", ["Home", {}]],
      ["back", ["Back", {}]],
      ["screen-off", ["ScreenOff", { confirmation: true }]],
      ["screen-on", ["ScreenOn", { confirmation: true }]],
      ["settings", ["OpenSettings", { confirmation: true }]],
    ]);
    const entry = actions.get(command);
    if (!entry) throw new Error(`Unknown device command: ${command || "(missing)"}`);
    const allowed = ["config", "machine", "machine-name", "device", "group"];
    if (entry[1].confirmation) allowed.push("confirm", "reason", "rollback");
    assertAllowedOptions(options, allowed, `device ${command}`);
    return matrixDispatch(entry[0], options, entry[1]);
  }
  if (area === "app") {
    if (command === "list") {
      assertAllowedOptions(options, ["config", "machine", "machine-name", "device", "group"], "app list");
      return matrixDispatch("ListApps", options);
    }
    if (command === "open") {
      assertAllowedOptions(options, ["config", "machine", "machine-name", "device", "group", "package"], "app open");
      return matrixDispatch("StartApp", options, { packageRequired: true });
    }
    if (command === "stop") {
      assertAllowedOptions(
        options,
        ["config", "machine", "machine-name", "device", "group", "package", "confirm", "reason", "rollback"],
        "app stop",
      );
      return matrixDispatch("StopApp", options, { packageRequired: true, confirmation: true });
    }
    throw new Error(`Unknown app command: ${command || "(missing)"}`);
  }
  if (["like", "favorite", "collect", "follow", "comment", "publish", "delete"].includes(area)) {
    if (command) throw new Error(`${area} does not accept a positional subcommand`);
    const canonicalArea = area === "collect" ? "favorite" : area;
    const textRequired = canonicalArea === "comment" || canonicalArea === "publish";
    const allowed = ["config", "machine", "machine-name", "device", "group", ...(textRequired ? ["text"] : [])];
    assertAllowedOptions(options, allowed, area);
    const action = `${canonicalArea[0].toUpperCase()}${canonicalArea.slice(1)}`;
    return interactionDispatch(action, options, { textRequired });
  }
  if (area === "feed" && command === "run") {
    assertAllowedOptions(
      options,
      [
        "template", "task-id", "count", "like-at", "favorite-at",
        "image-min-seconds", "image-max-seconds", "video-min-seconds", "video-max-seconds",
        "video-policy", "video-dwell-ms",
        "config", "output", "machine", "machine-name", "device", "group",
      ],
      "feed run",
    );
    const feedOptions = applyFeedTemplate(options);
    const machines = feedOptions.machine ?? [];
    const devices = feedOptions.device ?? [];
    const selectionModes = [machines.length > 0, feedOptions["machine-name"] !== undefined, devices.length > 0].filter(Boolean).length;
    if (selectionModes !== 1 || machines.length > 1 || devices.length > 1 || feedOptions.group) {
      throw new Error("Feed run requires exactly one machine number or machine name");
    }
    const args = [
      "-TaskId", String(requireOption(feedOptions, "task-id")),
      "-Count", String(requireOption(feedOptions, "count")),
    ];
    if (machines.length === 1) args.push("-MachineNumber", String(machines[0]));
    if (feedOptions["machine-name"] !== undefined) args.push("-MachineName", String(feedOptions["machine-name"]));
    if (devices.length === 1) args.push("-DeviceAlias", String(devices[0]));
    appendOption(args, feedOptions, "like-at", "-LikeAt");
    appendOption(args, feedOptions, "favorite-at", "-FavoriteAt");
    appendOption(args, feedOptions, "image-min-seconds", "-ImageMinSeconds");
    appendOption(args, feedOptions, "image-max-seconds", "-ImageMaxSeconds");
    appendOption(args, feedOptions, "video-min-seconds", "-VideoMinSeconds");
    appendOption(args, feedOptions, "video-max-seconds", "-VideoMaxSeconds");
    appendOption(args, feedOptions, "video-policy", "-VideoPolicy");
    appendOption(args, feedOptions, "video-dwell-ms", "-VideoDwellMs");
    appendOption(args, feedOptions, "config", "-ConfigPath");
    appendOption(args, feedOptions, "output", "-OutputRoot");
    return psScript("Run-FeedWorkflow.ps1", args);
  }
  if (area === "feed" && command === "batch") {
    assertAllowedOptions(options, ["spec", "config", "output", "dry-run"], "feed batch");
    const args = ["-SpecPath", String(requireOption(options, "spec"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    if (options["dry-run"]) args.push("-DryRun");
    return psScript("Run-FeedBatch.ps1", args);
  }
  if (area === "research" && command === "run") {
    assertAllowedOptions(options, ["task", "config", "output", "group", "device", "dry-run"], "research run");
    const args = ["-TaskPath", String(requireOption(options, "task"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    if (options.group) throw new Error("Research selects its live group from task.deviceGroup, not --group");
    const devices = options.device ?? [];
    if (devices.length && !options["dry-run"]) {
      throw new Error("Live research selects devices from task.deviceGroup; --device is only for dry-run aliases");
    }
    if (options["dry-run"]) {
      args.push("-DryRun");
      if (devices.length === 1) args.push("-DeviceAlias", String(devices[0]));
      if (devices.length > 1) args.push("-DeviceAliasesCsv", devices.map(String).join(","));
    }
    return psScript("Run-TopicResearch.ps1", args);
  }
  if (area === "research" && command === "sync-review") {
    assertAllowedOptions(options, ["review", "config", "confirm-external-sync"], "research sync-review");
    if (!options["confirm-external-sync"]) {
      throw new Error("Research review sync requires --confirm-external-sync after approving the public field set and destination");
    }
    const args = ["-ReviewPath", String(requireOption(options, "review")), "-ConfirmExternalSync"];
    appendOption(args, options, "config", "-ConfigPath");
    return psScript("Sync-ResearchReview.ps1", args);
  }
  if (area === "ramp" && command === "run") {
    assertAllowedOptions(
      options,
      ["profile", "config", "output", "date", "sequence", "dry-run", "generate-only"],
      "ramp run",
    );
    const args = ["-ProfilePath", String(requireOption(options, "profile"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    appendOption(args, options, "date", "-TaskDate");
    appendOption(args, options, "sequence", "-Sequence");
    if (options["dry-run"]) args.push("-DryRun");
    if (options["generate-only"]) args.push("-GenerateOnly");
    return psScript("Run-AccountRamp.ps1", args);
  }
  if (area === "handoff" && command === "review") {
    assertAllowedOptions(
      options,
      ["task", "candidate", "machine", "machine-name", "device", "group", "confirm-single-device-and-sync-off", "config", "output"],
      "handoff review",
    );
    if (!options["confirm-single-device-and-sync-off"]) {
      throw new Error("Handoff requires --confirm-single-device-and-sync-off after showing one phone and disabling synchronization");
    }
    const machines = options.machine ?? [];
    const devices = options.device ?? [];
    const selectionModes = [machines.length > 0, options["machine-name"] !== undefined, devices.length > 0].filter(Boolean).length;
    if (selectionModes !== 1 || machines.length > 1 || devices.length > 1 || options.group) {
      throw new Error("Review handoff requires exactly one machine number or machine name");
    }
    const args = [
      "-TaskPath", String(requireOption(options, "task")),
      "-CandidateId", String(requireOption(options, "candidate")),
      "-ConfirmSingleDeviceAndSyncOff",
    ];
    if (machines.length === 1) args.push("-MachineNumber", String(machines[0]));
    if (options["machine-name"] !== undefined) args.push("-MachineName", String(options["machine-name"]));
    if (devices.length === 1) args.push("-DeviceAlias", String(devices[0]));
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    return psScript("Open-ReviewCandidate.ps1", args);
  }
  if (area === "handoff" && command === "ramp") {
    assertAllowedOptions(
      options,
      ["profile", "candidate", "confirm-single-device-and-sync-off", "config", "output"],
      "handoff ramp",
    );
    if (!options["confirm-single-device-and-sync-off"]) {
      throw new Error("Handoff requires --confirm-single-device-and-sync-off after showing one phone and disabling synchronization");
    }
    const args = [
      "-ProfilePath", String(requireOption(options, "profile")),
      "-CandidateId", String(requireOption(options, "candidate")),
      "-ConfirmSingleDeviceAndSyncOff",
    ];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    return psScript("Open-AccountRampCandidate.ps1", args);
  }
  if (area === "inventory" && command === "collect") {
    assertAllowedOptions(options, ["config", "sync-lark"], "inventory collect");
    const args = [];
    appendOption(args, options, "config", "-ConfigPath");
    if (options["sync-lark"]) args.push("-SyncLark");
    return psScript("Run-Pipeline.ps1", args);
  }
  throw new Error(`Unknown command: ${[area, command].filter(Boolean).join(" ")}`);
}

export function runCli(argv = process.argv.slice(2), runtime = {}) {
  const output = runtime.output ?? process.stdout;
  const errorOutput = runtime.errorOutput ?? process.stderr;
  const spawn = runtime.spawn ?? spawnSync;
  try {
    const dispatch = buildDispatch(parseCliArgs(argv));
    if (dispatch.type === "help") {
      output.write(HELP);
      return 0;
    }
    const result = spawn(dispatch.executable, dispatch.args, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return Number.isInteger(result.status) ? result.status : 1;
  } catch (error) {
    errorOutput.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
