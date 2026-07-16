import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { POWERSHELL_EXECUTABLE } from "./powershell-runtime.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BOOLEAN_OPTIONS = new Set([
  "confirm",
  "confirm-external-sync",
  "confirm-human",
  "confirm-single-device-and-sync-off",
  "dry-run",
  "json",
  "sync-lark",
  "all",
]);
const REPEATABLE_OPTIONS = new Set(["machine", "device"]);

const HELP = `XHS Device Agent 统一入口

调用：
  PowerShell / cmd.exe:  .\\xhs.cmd <command>
  Git Bash / MSYS:       bash ./xhs.cmd <command>

统一任务：
  .\\xhs.cmd task run --spec data/task.json --dry-run
  .\\xhs.cmd task run --spec data/task.json
  .\\xhs.cmd task run --spec data/task.json --confirm-plan-hash <64位哈希>
  .\\xhs.cmd capability status [--json]
  .\\xhs.cmd capability accept --profile <文件> --evidence <文件> --confirm-profile-hash <哈希> --confirm-evidence-hash <哈希> --confirm-human

兼容转换（最终都进入统一任务链）：
  .\\xhs.cmd feed run --machine 02 --task-id feed-001 --count 11 --like-at 2 --favorite-at 7 --dry-run
  .\\xhs.cmd feed batch --spec data/legacy-batch.json --dry-run
  .\\xhs.cmd research run --task data/research-task.json --dry-run

仓库：
  .\\xhs.cmd repo status [--json]
  .\\xhs.cmd repo audit [--json]
  .\\xhs.cmd repo policy [--json]

只读与设备本地操作：
  .\\xhs.cmd doctor
  .\\xhs.cmd host status
  .\\xhs.cmd host start
  .\\xhs.cmd host refresh
  .\\xhs.cmd host restart-adb
  .\\xhs.cmd host enable-private-api
  .\\xhs.cmd host private-api-status
  .\\xhs.cmd host disable-private-api
  .\\xhs.cmd remote start
  .\\xhs.cmd remote status
  .\\xhs.cmd remote stop
  .\\xhs.cmd remote install
  .\\xhs.cmd remote uninstall
  .\\xhs.cmd device list
  .\\xhs.cmd device size --machine 02
  .\\xhs.cmd device screen --machine 02
  .\\xhs.cmd device ui --machine 02
  .\\xhs.cmd device tap-text --machine 02 --text <text> --expect-package <package> --confirm --reason <reason> --rollback <rollback>
  .\\xhs.cmd device tap-ocr --machine 04 --package <package> --text <text> --expect-text <text> --confirm --reason <reason> --rollback <rollback>
  .\\xhs.cmd wechat wallet-balance --machine 04
  .\\xhs.cmd xhs observe --machine 04
  .\\xhs.cmd device open-xhs --machine 02
  .\\xhs.cmd app list --machine 02

开发验收通道（要求 config/local.psd1 中 Xiaowei.Api.DevelopmentMode = $true）：
  .\\xhs.cmd dev invoke --action <效卫action> --machine 04 --data-file data/xiaowei-request-data.json
  .\\xhs.cmd dev invoke --action adb --machine 04 --data-json '{"command":"devices"}'
  .\\xhs.cmd dev invoke --action adb_shell --machine 04 --data-json '{"command":"getprop"}'
  .\\xhs.cmd dev private-invoke --command <Tauri命令> --args-json '{}'

选择器：
  --machine NUMBER    两位机器号，可重复
  --machine-name NAME 唯一可见名称
  --group NAME        本地配置组
  --config PATH       本地配置路径

Agent 默认使用命名 HTTP API；xhs.cmd 用于人工调试、兼容流程和能力缺口。统一任务的 planHash 是技术完整性绑定；当前用户请求已授权其明确范围，不追加第二次对话确认。
当前请求明确包含的登录、权限、支付、互动和账号状态动作可以继续；只有目标不唯一、缺少会改变结果的选择或动作结果不确定时才暂停，且不得盲目重发。
`;

export function parseCliArgs(argv) {
  const positional = [];
  const options = Object.create(null);
  let optionParsingStarted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--help" && positional.length === 0 && !optionParsingStarted) {
      positional.push(token);
      continue;
    }
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
    executable: POWERSHELL_EXECUTABLE,
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPT_DIR, name), ...args],
  };
}

function nodeScript(name, args = []) {
  return { executable: process.execPath, args: [path.join(SCRIPT_DIR, name), ...args] };
}

function appendOption(args, options, option, parameter) {
  if (options[option] !== undefined) args.push(parameter, String(options[option]));
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
  if (action === "TapText") {
    args.push("-Text", String(requireOption(options, "text")));
    if (!options["expect-text"] && !options["expect-package"] && !options["expect-resource-id"]) {
      throw new Error("device tap-text requires --expect-text, --expect-package, or --expect-resource-id");
    }
    appendOption(args, options, "expect-text", "-ExpectText");
    appendOption(args, options, "expect-package", "-ExpectPackage");
    appendOption(args, options, "expect-resource-id", "-ExpectResourceId");
  }
  if (confirmation) {
    if (!options.confirm) throw new Error("This device-local change requires --confirm, --reason, and --rollback");
    appendConfirmation(args, options);
  }
  return psScript("Invoke-MatrixAction.ps1", args);
}

function xiaoweiReadDispatch(action, options, {
  targetRequired = true, packageRequired = false, tapText = false, tapOcr = false, nodeSelector = false,
  nodeActivate = false, ordinal = false, confirmation = false,
} = {}) {
  const args = ["-Action", action];
  appendOption(args, options, "config", "-ConfigPath");
  appendTargets(args, options, { required: targetRequired });
  if (packageRequired) args.push("-PackageName", String(requireOption(options, "package")));
  if (tapText) {
    args.push("-Text", String(requireOption(options, "text")));
    if (!options["expect-text"] && !options["expect-package"] && !options["expect-resource-id"]) {
      throw new Error("device tap-text requires --expect-text, --expect-package, or --expect-resource-id");
    }
    appendOption(args, options, "expect-text", "-ExpectText");
    appendOption(args, options, "expect-package", "-ExpectPackage");
    appendOption(args, options, "expect-resource-id", "-ExpectResourceId");
  }
  if (tapOcr) {
    args.push("-Text", String(requireOption(options, "text")));
    args.push("-ExpectText", String(requireOption(options, "expect-text")));
  }
  if (nodeSelector) args.push("-SelectorBase64", String(requireOption(options, "selector-base64")));
  if (nodeActivate) args.push("-ExpectText", String(requireOption(options, "expect-text")));
  if (ordinal) args.push("-Ordinal", String(requireOption(options, "ordinal")));
  if (confirmation) {
    if (!options.confirm) throw new Error("This device-local change requires --confirm, --reason, and --rollback");
    appendConfirmation(args, options);
  }
  return psScript("Invoke-XiaoweiDeviceRead.ps1", args);
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
  if (area === "repo" && command === "status") {
    assertAllowedOptions(options, ["json"], "repo status");
    return nodeScript("repo-status.mjs", options.json ? ["--json"] : []);
  }
  if (area === "repo" && command === "audit") {
    assertAllowedOptions(options, ["json"], "repo audit");
    return nodeScript("repo-audit.mjs", options.json ? ["--json"] : []);
  }
  if (area === "repo" && command === "policy") {
    assertAllowedOptions(options, ["json"], "repo policy");
    return nodeScript("repo-policy-scan.mjs", options.json ? ["--json"] : []);
  }
  if (area === "capability" && command === "status") {
    assertAllowedOptions(options, ["acceptance-root", "json"], "capability status");
    const args = ["status"];
    appendOption(args, options, "acceptance-root", "--acceptance-root");
    if (options.json) args.push("--json");
    return nodeScript("capability-cli.mjs", args);
  }
  if (area === "capability" && command === "accept") {
    assertAllowedOptions(options, [
      "profile", "evidence", "acceptance-root", "confirm-profile-hash", "confirm-evidence-hash", "confirm-human", "json",
    ], "capability accept");
    if (!options["confirm-human"]) throw new Error("capability accept requires --confirm-human");
    const args = [
      "accept",
      "--profile", String(requireOption(options, "profile")),
      "--evidence", String(requireOption(options, "evidence")),
      "--confirm-profile-hash", String(requireOption(options, "confirm-profile-hash")),
      "--confirm-evidence-hash", String(requireOption(options, "confirm-evidence-hash")),
      "--confirm-human",
    ];
    appendOption(args, options, "acceptance-root", "--acceptance-root");
    if (options.json) args.push("--json");
    return nodeScript("capability-cli.mjs", args);
  }
  if (area === "task" && command === "run") {
    assertAllowedOptions(options, ["spec", "config", "output", "acceptance-root", "confirm-plan-hash", "dry-run", "json"], "task run");
    if (options["dry-run"]) {
      if (options.config || options["acceptance-root"] || options["confirm-plan-hash"]) {
        throw new Error("task run --dry-run does not accept live configuration or approval options");
      }
      const args = ["--spec", String(requireOption(options, "spec")), "--dry-run"];
      appendOption(args, options, "output", "--output");
      if (options.json) args.push("--json");
      return nodeScript("task-runner.mjs", args);
    }
    const args = ["-SpecPath", String(requireOption(options, "spec"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    appendOption(args, options, "acceptance-root", "-AcceptanceRoot");
    appendOption(args, options, "confirm-plan-hash", "-ConfirmPlanHash");
    if (options.json) args.push("-Json");
    return psScript("Run-TaskWorkflow.ps1", args);
  }
  if (area === "host" && [
    "status", "start", "refresh", "restart-adb", "private-api-status", "enable-private-api", "disable-private-api",
  ].includes(command)) {
    assertAllowedOptions(options, ["config"], `host ${command}`);
    const action = command === "start" ? "Start"
      : command === "status" ? "Status"
        : command === "refresh" ? "Refresh"
          : command === "restart-adb" ? "RestartAdb"
            : command === "private-api-status" ? "PrivateApiStatus"
              : command === "enable-private-api" ? "EnablePrivateApi" : "DisablePrivateApi";
    const args = ["-Action", action];
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
  if (area === "api" && command === "private-catalog") {
    assertAllowedOptions(options, [], "api private-catalog");
    return nodeScript("xiaowei-private-api.mjs", ["catalog"]);
  }
  if (area === "remote" && ["start", "status", "stop", "install", "uninstall"].includes(command)) {
    assertAllowedOptions(options, [], `remote ${command}`);
    const action = command[0].toUpperCase() + command.slice(1);
    return psScript("Manage-XhsRemoteGateway.ps1", ["-Action", action]);
  }
  if (area === "api" && (command === "probe" || command === "status")) {
    assertAllowedOptions(options, ["config"], `api ${command}`);
    const args = ["-ProbeApi"];
    appendOption(args, options, "config", "-ConfigPath");
    return psScript("Matrix-Preflight.ps1", args);
  }
  if (area === "dev" && command === "invoke") {
    assertAllowedOptions(options, [
      "action", "config", "machine", "machine-name", "device", "group", "devices", "data-file", "data-json", "endpoint", "all",
    ], "dev invoke");
    const args = ["-Action", String(requireOption(options, "action"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendTargets(args, options, { required: false });
    appendOption(args, options, "devices", "-DevicesCsv");
    if (options.all) args.push("-All");
    appendOption(args, options, "data-file", "-DataFile");
    appendOption(args, options, "data-json", "-DataJson");
    appendOption(args, options, "endpoint", "-Endpoint");
    return psScript("Invoke-XiaoweiDev.ps1", args);
  }
  if (area === "dev" && command === "private-invoke") {
    assertAllowedOptions(options, ["command", "args-json", "args-base64", "config", "endpoint"], "dev private-invoke");
    if (options["args-json"] !== undefined && options["args-base64"] !== undefined) {
      throw new Error("dev private-invoke accepts args-json or args-base64, not both");
    }
    const args = ["-Command", String(requireOption(options, "command"))];
    appendOption(args, options, "args-json", "-ArgsJson");
    appendOption(args, options, "args-base64", "-ArgsBase64");
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "endpoint", "-Endpoint");
    return psScript("Invoke-XiaoweiPrivateDev.ps1", args);
  }
  if (area === "device") {
    if (command === "guide") {
      assertAllowedOptions(options, ["failure-code"], "device guide");
      return nodeScript("device-control-guide.mjs", ["--code", String(requireOption(options, "failure-code"))]);
    }
    const actions = new Map([
      ["list", ["List", { targetRequired: false, noTargetOptions: true, xiaoweiRead: true }]],
      ["size", ["Size", { xiaoweiRead: true }]],
      ["ui", ["Ui", { xiaoweiRead: true }]],
      ["screen", ["Screen", { xiaoweiRead: true }]],
      ["tap-text", ["TapText", { confirmation: true, tapText: true, xiaoweiRead: true }]],
      ["tap-ocr", ["TapOcr", { confirmation: true, tapOcr: true, packageRequired: true, xiaoweiRead: true }]],
      ["node-resolve", ["NodeResolve", { nodeSelector: true, packageRequired: true, xiaoweiRead: true }]],
      ["node-activate", ["NodeActivate", {
        nodeSelector: true, nodeActivate: true, confirmation: true, packageRequired: true, xiaoweiRead: true,
      }]],
      ["open-xhs", ["OpenXhs", {}]],
      ["open-profile", ["OpenProfile", {}]],
      ["home", ["Home", { xiaoweiRead: true }]],
      ["back", ["Back", {}]],
      ["screen-off", ["ScreenOff", { confirmation: true }]],
      ["screen-on", ["ScreenOn", { confirmation: true }]],
      ["settings", ["OpenSettings", { confirmation: true }]],
    ]);
    const entry = actions.get(command);
    if (!entry) throw new Error(`Unknown device command: ${command || "(missing)"}`);
    const allowed = entry[1].noTargetOptions ? ["config"] : ["config", "machine", "machine-name", "device", "group"];
    if (entry[1].tapText) allowed.push("text", "expect-text", "expect-package", "expect-resource-id");
    if (entry[1].tapOcr) allowed.push("package", "text", "expect-text");
    if (entry[1].nodeSelector) allowed.push("package", "selector-base64");
    if (entry[1].nodeActivate) allowed.push("expect-text");
    if (entry[1].confirmation) allowed.push("confirm", "reason", "rollback");
    assertAllowedOptions(options, allowed, `device ${command}`);
    if (entry[1].xiaoweiRead) return xiaoweiReadDispatch(entry[0], options, entry[1]);
    return matrixDispatch(entry[0], options, entry[1]);
  }
  if (area === "app") {
    if (command === "list") {
      assertAllowedOptions(options, ["config", "machine", "machine-name", "device", "group"], "app list");
      return matrixDispatch("ListApps", options);
    }
    if (command === "open") {
      assertAllowedOptions(options, ["config", "machine", "machine-name", "device", "group", "package"], "app open");
      return xiaoweiReadDispatch("OpenApp", options, { packageRequired: true });
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
  if (area === "wechat" && command === "wallet-balance") {
    assertAllowedOptions(options, ["config", "machine", "machine-name", "device"], "wechat wallet-balance");
    return xiaoweiReadDispatch("WeChatWalletBalance", options);
  }
  if (area === "xhs" && command === "observe") {
    assertAllowedOptions(options, ["config", "machine", "machine-name", "device"], "xhs observe");
    return xiaoweiReadDispatch("XhsObserve", options);
  }
  if (area === "xhs" && command === "open-visible") {
    assertAllowedOptions(options, ["config", "machine", "machine-name", "device", "ordinal"], "xhs open-visible");
    return xiaoweiReadDispatch("XhsOpenVisible", options, { ordinal: true });
  }
  if (["like", "favorite", "collect", "follow", "comment", "publish", "delete"].includes(area)) {
    throw new Error(`${area} is retired as a direct command; use an implemented approved workflow through xhs.cmd`);
  }
  if (area === "feed" && command === "run") {
    assertAllowedOptions(
      options,
      [
        "task-id", "count", "like-at", "favorite-at", "max-parallel",
        "capability-profile", "acceptance-root", "confirm-plan-hash", "dry-run", "json",
        "config", "output", "machine", "machine-name", "device", "group",
      ],
      "feed run",
    );
    const feedOptions = options;
    const machines = feedOptions.machine ?? [];
    const devices = feedOptions.device ?? [];
    const selectionModes = [machines.length > 0, feedOptions["machine-name"] !== undefined, devices.length > 0, feedOptions.group !== undefined].filter(Boolean).length;
    if (selectionModes !== 1) throw new Error("Feed run requires exactly one machine selector mode");
    const args = [
      "-Kind", "Feed",
      "-TaskId", String(requireOption(feedOptions, "task-id")),
      "-Count", String(requireOption(feedOptions, "count")),
    ];
    if (machines.length) args.push("-MachineNumbersCsv", machines.map(String).join(","));
    if (feedOptions["machine-name"] !== undefined) args.push("-MachineName", String(feedOptions["machine-name"]));
    if (devices.length) args.push("-DeviceAliasesCsv", devices.map(String).join(","));
    if (feedOptions.group !== undefined) args.push("-Group", String(feedOptions.group));
    appendOption(args, feedOptions, "like-at", "-LikeAt");
    appendOption(args, feedOptions, "favorite-at", "-FavoriteAt");
    appendOption(args, feedOptions, "max-parallel", "-MaxParallel");
    appendOption(args, feedOptions, "capability-profile", "-CapabilityProfileId");
    appendOption(args, feedOptions, "acceptance-root", "-AcceptanceRoot");
    appendOption(args, feedOptions, "confirm-plan-hash", "-ConfirmPlanHash");
    appendOption(args, feedOptions, "config", "-ConfigPath");
    appendOption(args, feedOptions, "output", "-OutputRoot");
    if (feedOptions["dry-run"]) args.push("-DryRun");
    if (feedOptions.json) args.push("-Json");
    return psScript("Run-TaskCompatibility.ps1", args);
  }
  if (area === "feed" && command === "batch") {
    assertAllowedOptions(options, [
      "spec", "config", "output", "capability-profile", "acceptance-root", "confirm-plan-hash", "dry-run", "json",
    ], "feed batch");
    const args = ["-Kind", "Batch", "-LegacySpecPath", String(requireOption(options, "spec"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    appendOption(args, options, "capability-profile", "-CapabilityProfileId");
    appendOption(args, options, "acceptance-root", "-AcceptanceRoot");
    appendOption(args, options, "confirm-plan-hash", "-ConfirmPlanHash");
    if (options["dry-run"]) args.push("-DryRun");
    if (options.json) args.push("-Json");
    return psScript("Run-TaskCompatibility.ps1", args);
  }
  if (area === "research" && command === "run") {
    assertAllowedOptions(options, [
      "task", "config", "output", "group", "device", "max-parallel", "capability-profile",
      "acceptance-root", "confirm-plan-hash", "dry-run", "json",
    ], "research run");
    const args = ["-Kind", "Research", "-LegacySpecPath", String(requireOption(options, "task"))];
    appendOption(args, options, "config", "-ConfigPath");
    appendOption(args, options, "output", "-OutputRoot");
    if (options.group) throw new Error("Research selects its live group from task.deviceGroup, not --group");
    const devices = options.device ?? [];
    if (devices.length && !options["dry-run"]) {
      throw new Error("Live research selects devices from task.deviceGroup; --device is only for dry-run aliases");
    }
    if (options["dry-run"]) {
      args.push("-DryRun");
      if (devices.length) args.push("-DeviceAliasesCsv", devices.map(String).join(","));
    }
    appendOption(args, options, "max-parallel", "-MaxParallel");
    appendOption(args, options, "capability-profile", "-CapabilityProfileId");
    appendOption(args, options, "acceptance-root", "-AcceptanceRoot");
    appendOption(args, options, "confirm-plan-hash", "-ConfirmPlanHash");
    if (options.json) args.push("-Json");
    return psScript("Run-TaskCompatibility.ps1", args);
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
