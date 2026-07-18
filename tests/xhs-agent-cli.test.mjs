import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDispatch, parseCliArgs, runCli } from "../scripts/xhs-agent.mjs";
import { POWERSHELL_EXECUTABLE } from "../scripts/powershell-runtime.mjs";

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

test("private API catalog is available to remote agents through xhs", () => {
  const dispatch = buildDispatch(parseCliArgs(["api", "private-catalog"]));
  assert.ok(dispatch.args.some((value) => value.endsWith("xiaowei-private-api.mjs")));
  assert.equal(dispatch.args.at(-1), "catalog");
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
  assert.equal(live.executable, POWERSHELL_EXECUTABLE);
  assert.ok(live.args.some((value) => value.endsWith("Run-TaskWorkflow.ps1")));
  assert.deepEqual(live.args.slice(-4), ["-SpecPath", "data/task.json", "-ConfirmPlanHash", "a".repeat(64)]);
  assert.throws(
    () => buildDispatch(parseCliArgs([
      "task", "run", "--spec", "data/task.json", "--dry-run", "--confirm-plan-hash", "a".repeat(64),
    ])),
    /does not accept live configuration/u,
  );
});

test("unified CLI routes a targeted XHS open through the Xiaowei app adapter", () => {
  const dispatch = buildDispatch(parseCliArgs(["device", "open-xhs", "--machine", "04"]));
  assert.equal(dispatch.executable, POWERSHELL_EXECUTABLE);
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-6), [
    "-Action", "OpenApp", "-MachineNumber", "04", "-PackageName", "com.xingin.xhs",
  ]);
  assert.ok(!dispatch.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
});

test("device UI and screen use the Xiaowei API read adapter instead of local ADB", () => {
  for (const [command, action] of [["ui", "Ui"], ["screen", "Screen"]]) {
    const dispatch = buildDispatch(parseCliArgs(["device", command, "--machine", "02"]));
    assert.equal(dispatch.executable, POWERSHELL_EXECUTABLE);
    assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
    assert.deepEqual(dispatch.args.slice(-4), ["-Action", action, "-MachineNumber", "02"]);
    assert.ok(!dispatch.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
  }
});

test("device list and size use the Xiaowei read adapter without local ADB inventory", () => {
  const list = buildDispatch(parseCliArgs(["device", "list"]));
  assert.ok(list.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(list.args.slice(-2), ["-Action", "List"]);
  assert.ok(!list.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));

  const size = buildDispatch(parseCliArgs(["device", "size", "--machine", "02"]));
  assert.ok(size.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(size.args.slice(-4), ["-Action", "Size", "-MachineNumber", "02"]);
  assert.ok(!size.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
});

test("device guide and generic node commands route through their bounded adapters", () => {
  const guide = buildDispatch(parseCliArgs(["device", "guide", "--failure-code", "UI_EMPTY"]));
  assert.ok(guide.args.some((value) => value.endsWith("device-control-guide.mjs")));
  assert.deepEqual(guide.args.slice(-2), ["--code", "UI_EMPTY"]);

  const selector = Buffer.from(JSON.stringify({
    label: "我", role: "tab", sources: ["ocr"],
  }), "utf8").toString("base64");
  const resolve = buildDispatch(parseCliArgs([
    "device", "node-resolve", "--machine", "03", "--package", "com.tencent.mm",
    "--selector-base64", selector,
  ]));
  assert.deepEqual(resolve.args.slice(-8), [
    "-Action", "NodeResolve", "-MachineNumber", "03", "-PackageName", "com.tencent.mm",
    "-SelectorBase64", selector,
  ]);
  const activate = buildDispatch(parseCliArgs([
    "device", "node-activate", "--machine", "03", "--package", "com.tencent.mm",
    "--selector-base64", selector, "--expect-text", "服务", "--confirm",
    "--reason", "open verified node", "--rollback", "return to previous page",
  ]));
  assert.deepEqual(activate.args.slice(-15), [
    "-Action", "NodeActivate", "-MachineNumber", "03", "-PackageName", "com.tencent.mm",
    "-SelectorBase64", selector, "-ExpectText", "服务", "-ConfirmAction", "-ConfirmationReason",
    "open verified node", "-RollbackInfo", "return to previous page",
  ]);
  assert.equal(activate.args.some((value) => /serial|deviceId|coordinate|^-x$|^-y$/iu.test(value)), false);
});

test("device home and app open use the Xiaowei API adapter without local ADB", () => {
  const home = buildDispatch(parseCliArgs(["device", "home", "--machine", "02"]));
  assert.ok(home.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(home.args.slice(-4), ["-Action", "Home", "-MachineNumber", "02"]);

  const open = buildDispatch(parseCliArgs([
    "app", "open", "--machine", "02", "--package", "com.example.approved",
  ]));
  assert.ok(open.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(open.args.slice(-6), [
    "-Action", "OpenApp", "-MachineNumber", "02", "-PackageName", "com.example.approved",
  ]);

  const alias = buildDispatch(parseCliArgs([
    "device", "start-apk", "--machine", "02", "--package", "com.example.approved",
  ]));
  assert.deepEqual(alias.args.slice(-6), [
    "-Action", "OpenApp", "-MachineNumber", "02", "-PackageName", "com.example.approved",
  ]);

  const recent = buildDispatch(parseCliArgs(["device", "recent", "--machine", "02"]));
  assert.deepEqual(recent.args.slice(-4), ["-Action", "Recent", "-MachineNumber", "02"]);

  const appList = buildDispatch(parseCliArgs(["app", "list", "--machine", "02"]));
  assert.deepEqual(appList.args.slice(-4), ["-Action", "AppList", "-MachineNumber", "02"]);
  assert.ok(!appList.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
});

test("device input routes a bounded text value through the Xiaowei adapter", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "device", "input", "--machine", "02", "--package", "com.xingin.xhs", "--text", "通勤穿搭",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-8), [
    "-Action", "Input", "-MachineNumber", "02", "-PackageName", "com.xingin.xhs", "-Text", "通勤穿搭",
  ]);
  assert.throws(() => buildDispatch(parseCliArgs([
    "device", "input", "--machine", "02", "--package", "com.xingin.xhs",
  ])), /text is required/u);
});

test("device scroll routes a semantic direction and bounded step count through the Xiaowei adapter", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "device", "scroll", "--machine", "02", "--direction", "down", "--steps", "2", "--package", "com.xingin.xhs",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-10), [
    "-Action", "Scroll", "-MachineNumber", "02", "-Direction", "down", "-Steps", "2", "-PackageName", "com.xingin.xhs",
  ]);
  assert.throws(() => buildDispatch(parseCliArgs([
    "device", "scroll", "--machine", "02",
  ])), /direction is required/u);
});

test("device coordinate tap routes bounded percentages with one postcondition", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "device", "tap-coords", "--machine", "02", "--package", "com.example.launcher",
    "--x", "50", "--y", "8.5", "--expect-package", "com.xingin.xhs",
  ]));
  assert.deepEqual(dispatch.args.slice(-12), [
    "-Action", "TapCoords", "-MachineNumber", "02", "-PackageName", "com.example.launcher",
    "-X", "50", "-Y", "8.5", "-ExpectPackage", "com.xingin.xhs",
  ]);
  assert.throws(() => buildDispatch(parseCliArgs([
    "device", "tap-coords", "--machine", "02", "--package", "com.example.launcher", "--x", "50", "--y", "8.5",
  ])), /expect-text|expect-package|expect-resource-id/u);
});

test("manual safe-label tap requires one machine, confirmation, and a postcondition", () => {
  const base = ["device", "tap-text", "--machine", "02", "--text", "Cancel"];
  assert.throws(() => buildDispatch(parseCliArgs(base)), /expect-text|expect-package|expect-resource-id/u);
  assert.throws(
    () => buildDispatch(parseCliArgs([...base, "--expect-package", "com.xingin.xhs"])),
    /requires --confirm/u,
  );
  const dispatch = buildDispatch(parseCliArgs([
    ...base,
    "--expect-package", "com.xingin.xhs",
    "--confirm", "--reason", "dismiss local overlay", "--rollback", "press back",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.ok(!dispatch.args.some((value) => value.endsWith("Invoke-MatrixAction.ps1")));
  assert.ok(dispatch.args.includes("-ConfirmAction"));
  assert.deepEqual(dispatch.args.slice(-13), [
    "-Action", "TapText", "-MachineNumber", "02", "-Text", "Cancel",
    "-ExpectPackage", "com.xingin.xhs", "-ConfirmAction", "-ConfirmationReason",
    "dismiss local overlay", "-RollbackInfo", "press back",
  ]);
  const packageBound = buildDispatch(parseCliArgs([
    "device", "tap-text", "--machine", "01", "--package", "com.xingin.xhs", "--text", "发送",
    "--expect-text", "已发送", "--confirm", "--reason", "submit prepared comment", "--rollback", "inspect comment count",
  ]));
  assert.ok(packageBound.args.includes("-PackageName"));
  assert.ok(packageBound.args.includes("com.xingin.xhs"));
  const secondReply = buildDispatch(parseCliArgs([
    "device", "tap-text", "--machine", "01", "--package", "com.xingin.xhs", "--text", "回复",
    "--match", "suffix", "--ordinal", "2", "--expect-text", "发送",
    "--confirm", "--reason", "open selected reply composer", "--rollback", "press back once",
  ]));
  assert.ok(secondReply.args.includes("-TextMatch"));
  assert.ok(secondReply.args.includes("suffix"));
  assert.ok(secondReply.args.includes("-Ordinal"));
  assert.ok(secondReply.args.includes("2"));
});

test("OCR tap routes through the Xiaowei adapter without exposing coordinates or device identifiers", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "device", "tap-ocr", "--machine", "04", "--package", "com.tencent.mm",
    "--text", "我", "--expect-text", "服务", "--confirm",
    "--reason", "open verified account tab", "--rollback", "return to previous page",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-15), [
    "-Action", "TapOcr", "-MachineNumber", "04", "-PackageName", "com.tencent.mm",
    "-Text", "我", "-ExpectText", "服务", "-ConfirmAction", "-ConfirmationReason",
    "open verified account tab", "-RollbackInfo", "return to previous page",
  ]);
  assert.equal(dispatch.args.some((value) => /serial|coordinate|^-x$|^-y$/iu.test(value)), false);
});

test("WeChat wallet balance is a named read-only machine command", () => {
  const dispatch = buildDispatch(parseCliArgs(["wechat", "wallet-balance", "--machine", "04"]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-4), ["-Action", "WeChatWalletBalance", "-MachineNumber", "04"]);
  assert.equal(dispatch.args.some((value) => /serial|screenshot|coordinate/iu.test(value)), false);
  assert.throws(
    () => buildDispatch(parseCliArgs(["wechat", "wallet-balance", "--machine", "04", "--text", "x"])),
    /does not support option/u,
  );
});

test("XHS observation is a named read-only machine command", () => {
  const dispatch = buildDispatch(parseCliArgs(["xhs", "observe", "--machine", "04"]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDeviceRead.ps1")));
  assert.deepEqual(dispatch.args.slice(-4), ["-Action", "XhsObserve", "-MachineNumber", "04"]);
  assert.equal(dispatch.args.some((value) => /serial|coordinate|message|private/iu.test(value)), false);
  assert.throws(
    () => buildDispatch(parseCliArgs(["xhs", "observe", "--machine", "04", "--text", "x"])),
    /does not support option/u,
  );
});

test("XHS find-video exposes bounded scroll and duration budgets", () => {
  const defaults = buildDispatch(parseCliArgs(["xhs", "find-video", "--machine", "04"]));
  assert.deepEqual(defaults.args.slice(-8), [
    "-Action", "XhsFindVideo", "-MachineNumber", "04", "-MaxScrolls", "3", "-MaxDurationMs", "28000",
  ]);
  const explicit = buildDispatch(parseCliArgs([
    "xhs", "find-video", "--machine", "04", "--max-scrolls", "5", "--max-duration-ms", "30000",
  ]));
  assert.deepEqual(explicit.args.slice(-8), [
    "-Action", "XhsFindVideo", "-MachineNumber", "04", "-MaxScrolls", "5", "-MaxDurationMs", "30000",
  ]);
  assert.throws(
    () => buildDispatch(parseCliArgs(["xhs", "find-video", "--machine", "04", "--ordinal", "1"])),
    /does not support option/u,
  );
});

test("XHS comment workflow exposes independent open, input, and send commands", () => {
  const opened = buildDispatch(parseCliArgs(["xhs", "comment-open", "--machine", "01"]));
  assert.deepEqual(opened.args.slice(-4), ["-Action", "XhsCommentOpen", "-MachineNumber", "01"]);
  const input = buildDispatch(parseCliArgs([
    "xhs", "comment-input", "--machine", "01", "--text", "[微笑R]", "--expected-editor-state-hash", "a".repeat(64),
  ]));
  assert.deepEqual(input.args.slice(-8), [
    "-Action", "XhsCommentInput", "-MachineNumber", "01", "-Text", "[微笑R]", "-ExpectedEditorStateHash", "a".repeat(64),
  ]);
  const replyInput = buildDispatch(parseCliArgs([
    "xhs", "comment-reply-input", "--machine", "04", "--ordinal", "2", "--text", "感谢分享",
  ]));
  assert.deepEqual(replyInput.args.slice(-8), [
    "-Action", "XhsCommentReplyInput", "-MachineNumber", "04", "-Text", "感谢分享", "-Ordinal", "2",
  ]);
  const sent = buildDispatch(parseCliArgs([
    "xhs", "comment-send", "--machine", "01", "--expected-draft", "[微笑R]", "--expected-before-count", "192",
    "--expected-target-base64", "dGFyZ2V0", "--expected-empty-editor-state-hash", "a".repeat(64),
  ]));
  assert.deepEqual(sent.args.slice(-12), [
    "-Action", "XhsCommentSend", "-MachineNumber", "01", "-ExpectedDraft", "[微笑R]", "-ExpectedBeforeCount", "192",
    "-ExpectedTargetBase64", "dGFyZ2V0", "-ExpectedEmptyEditorStateHash", "a".repeat(64),
  ]);
});

test("XHS private-message send binds one expected draft", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "xhs", "dm-send", "--machine", "01", "--expected-draft", "测试",
  ]));
  assert.deepEqual(dispatch.args.slice(-6), [
    "-Action", "XhsDmSend", "-MachineNumber", "01", "-ExpectedDraft", "测试",
  ]);
});

test("XHS visible-card opening accepts only a machine and ordinal", () => {
  const dispatch = buildDispatch(parseCliArgs(["xhs", "open-visible", "--machine", "04", "--ordinal", "2"]));
  assert.deepEqual(dispatch.args.slice(-6), ["-Action", "XhsOpenVisible", "-MachineNumber", "04", "-Ordinal", "2"]);
  assert.equal(dispatch.args.some((value) => /serial|coordinate/iu.test(value)), false);
  assert.throws(
    () => buildDispatch(parseCliArgs(["xhs", "open-visible", "--machine", "04"])),
    /ordinal is required/u,
  );
});

test("XHS emoji commenting routes one bounded label through the Xiaowei adapter", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "xhs", "comment-emoji", "--machine", "01", "--emoji", "[微笑R]",
  ]));
  assert.deepEqual(dispatch.args.slice(-6), [
    "-Action", "XhsCommentEmoji", "-MachineNumber", "01", "-Emoji", "[微笑R]",
  ]);
  assert.throws(() => buildDispatch(parseCliArgs([
    "xhs", "comment-emoji", "--machine", "01",
  ])), /emoji is required/u);
});

test("host status and start remain available through the unified entry", () => {
  for (const command of ["status", "start"]) {
    const dispatch = buildDispatch(parseCliArgs(["host", command]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XiaoweiHost.ps1")));
    assert.equal(dispatch.args.at(-1), command === "start" ? "Start" : "Status");
  }
});

test("host refresh and restart-adb route through the host wrapper", () => {
  for (const [command, action] of [["refresh", "Refresh"], ["restart-adb", "RestartAdb"]]) {
    const dispatch = buildDispatch(parseCliArgs(["host", command]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XiaoweiHost.ps1")));
    assert.equal(dispatch.args.at(-1), action);
  }
});

test("Xiaowei private API setup and status stay behind the host wrapper", () => {
  for (const [command, action] of [
    ["enable-private-api", "EnablePrivateApi"],
    ["private-api-status", "PrivateApiStatus"],
    ["disable-private-api", "DisablePrivateApi"],
  ]) {
    const dispatch = buildDispatch(parseCliArgs(["host", command]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XiaoweiHost.ps1")));
    assert.equal(dispatch.args.at(-1), action);
  }
});

test("remote gateway lifecycle stays behind the unified entry", () => {
  for (const [command, action] of [
    ["start", "Start"], ["status", "Status"], ["stop", "Stop"], ["restart", "Restart"], ["install", "Install"], ["uninstall", "Uninstall"],
  ]) {
    const dispatch = buildDispatch(parseCliArgs(["remote", command]));
    assert.ok(dispatch.args.some((value) => value.endsWith("Manage-XhsRemoteGateway.ps1")));
    assert.deepEqual(dispatch.args.slice(-2), ["-Action", action]);
  }
});

test("remote gateway manager proves listener ownership, build identity, and a fresh boot before success", () => {
  const source = readFileSync(new URL("../scripts/Manage-XhsRemoteGateway.ps1", import.meta.url), "utf8");
  assert.match(source, /Get-NetTCPConnection[^\r\n]+17891[^\r\n]+Listen/u);
  assert.match(source, /\[int\]\$listener\.OwningProcess -eq \$child\.Id/u);
  assert.match(source, /\$health\.buildId -eq \$expectedBuildId/u);
  assert.match(source, /--print-build-id/u);
  assert.match(source, /\$health\.bootId -ne \$PreviousBootId/u);
  assert.match(source, /admin\/drain-and-shutdown/u);
  assert.match(source, /authenticated_drain/u);
  assert.match(source, /refusing to overwrite the PID file/u);
  assert.match(source, /\[ValidateSet\([^\r\n]+"Restart"/u);
});

test("development invoke routes through the explicit Xiaowei development wrapper", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "dev", "invoke", "--action", "adb", "--machine", "04", "--data-file", "data/adb.json",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiDev.ps1")));
  assert.deepEqual(dispatch.args.slice(-6), [
    "-Action", "adb", "-MachineNumber", "04", "-DataFile", "data/adb.json",
  ]);
});

test("private Tauri development invoke routes through the version-gated wrapper", () => {
  const dispatch = buildDispatch(parseCliArgs([
    "dev", "private-invoke", "--command", "reconnect_device", "--args-json", "{}",
  ]));
  assert.ok(dispatch.args.some((value) => value.endsWith("Invoke-XiaoweiPrivateDev.ps1")));
  assert.deepEqual(dispatch.args.slice(-4), ["-Command", "reconnect_device", "-ArgsJson", "{}"]);

  const encoded = Buffer.from(JSON.stringify({ nested: { value: "quoted text" } }), "utf8").toString("base64");
  const remote = buildDispatch(parseCliArgs([
    "dev", "private-invoke", "--command", "get_size", "--args-base64", encoded,
  ]));
  assert.deepEqual(remote.args.slice(-4), ["-Command", "get_size", "-ArgsBase64", encoded]);
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
  assert.deepEqual(dispatch.args.slice(-4), ["-Action", "Ui", "-DeviceAliasesCsv", "device-01,device-02"]);
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
  assert.deepEqual(multiple.args.slice(-4), ["-Action", "Ui", "-MachineNumbersCsv", "01,03"]);

  const named = buildDispatch(parseCliArgs([
    "device", "screen", "--machine-name", "VISIBLE_NAME",
  ]));
  assert.deepEqual(named.args.slice(-4), ["-Action", "Screen", "-MachineName", "VISIBLE_NAME"]);

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
    [["research", "run", "--task", "task.json", "--package", "com.example.app"], /research run does not support option: --package/u],
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
  assert.equal(dispatch.executable, POWERSHELL_EXECUTABLE);
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
  assert.match(text, /Agent 默认使用命名 HTTP API/u);
  assert.match(text, /xhs\.cmd 用于人工调试、兼容流程和能力缺口/u);
  assert.match(text, /当前请求明确包含的登录、权限、支付、互动和账号状态动作可以继续/u);
});
