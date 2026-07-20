import assert from "node:assert/strict";
import test from "node:test";

import {
  XIAOWEI_ACTION_CATALOG,
  XIAOWEI_ACTION_LIMITS,
  XIAOWEI_ACTION_RISKS,
  buildXiaoweiRequest,
  getXiaoweiAction,
  listXiaoweiActions,
  validateXiaoweiRequest,
} from "../scripts/xiaowei-action-catalog.mjs";

const automationTiming = {
  count: 1,
  startTimes: [],
  taskInterval: [0, 0],
  deviceInterval: 0,
};

const MINIMUM_REQUESTS = [
  ["list", {}],
  ["updateDevices", { devices: "device-01", data: { sort: 0, name: "phone-01" } }],
  ["adb", { devices: "device-01", data: { command: "adb shell getprop ro.product.model" } }],
  ["screen", { devices: "device-01", data: { savePath: "D:\\Pictures" } }],
  ["pointerEvent", { devices: "device-01", data: { type: "10", x: "0", y: "100" } }],
  ["pushEvent", { devices: "device-01", data: { type: "3" } }],
  ["writeClipBoard", { devices: "device-01", data: { content: "" } }],
  ["uploadFile", { devices: "device-01", data: { filePath: "D:\\upload.txt", isMedia: "0" } }],
  ["pullFile", { devices: "device-01", data: { filePath: "/sdcard/a.txt", savePath: "D:\\Downloads" } }],
  ["apkList", { devices: "device-01" }],
  ["installApk", { devices: "device-01", data: { filePath: "D:\\app.apk" } }],
  ["uninstallApk", { devices: "device-01", data: { apk: "com.example.app" } }],
  ["startApk", { devices: "device-01", data: { apk: "com.example.app" } }],
  ["stopApk", { devices: "device-01", data: { apk: "com.example.app" } }],
  ["imeList", { devices: "device-01" }],
  ["installInputIme", { devices: "device-01" }],
  ["selectIme", { devices: "device-01", data: { ime: "com.android.xwkeyboard/.XwIME" } }],
  ["inputText", { devices: "device-01", data: { content: "text" } }],
  ["getTags", {}],
  ["addTag", { data: { name: "content" } }],
  ["updateTag", { data: { oldName: "content", name: "research" } }],
  ["removeTag", { data: { name: "research" } }],
  ["addTagDevice", { devices: "device-01", data: { name: "content" } }],
  ["removeTagDevice", { devices: "device-01", data: { name: "content" } }],
  ["adb_shell", { devices: "device-01", data: { command: "wm size" } }],
  ["actionTasks", { devices: "device-01" }],
  ["actionCreate", {
    devices: "device-01",
    data: [{ actionName: "read-only-diagnostic", ...automationTiming }],
  }],
  ["actionRemove", { devices: "device-01", data: { name: "read-only-diagnostic" } }],
  ["autojsTasks", { devices: "device-01" }],
  ["autojsCreate", {
    devices: "device-01",
    data: [{ path: "D:\\tasks\\diagnostic.js", ...automationTiming }],
  }],
  ["autojsRemove", { devices: "device-01", data: { name: "diagnostic" } }],
];

const OPAQUE_ACTIONS = new Set(["actionCreate", "actionRemove", "autojsCreate", "autojsRemove"]);
const READ_ONLY_RISKS = new Set(["read_only", "read_only_sensitive"]);
const unsafeOpaque = { unsafeInternal: { allowOpaqueAutomation: true } };

function throwsCode(code) {
  return (error) => error?.code === code;
}

test("catalog contains all 31 official actions with immutable contracts and risk metadata", () => {
  assert.equal(XIAOWEI_ACTION_CATALOG.length, 31);
  assert.deepEqual(
    XIAOWEI_ACTION_CATALOG.map(({ action }) => action),
    MINIMUM_REQUESTS.map(([action]) => action),
  );
  assert.equal(new Set(XIAOWEI_ACTION_CATALOG.map(({ action }) => action)).size, 31);
  assert.deepEqual(XIAOWEI_ACTION_RISKS, [
    "read_only",
    "read_only_sensitive",
    "navigation",
    "device_local_change",
    "destructive",
    "privileged",
    "opaque_automation_blocked",
  ]);
  assert.equal(getXiaoweiAction("addTagDevice")?.action, "addTagDevice");
  assert.equal(getXiaoweiAction("addtagdevice"), undefined);
  assert.equal(listXiaoweiActions(), XIAOWEI_ACTION_CATALOG);
  assert(listXiaoweiActions({ risk: "privileged" }).every(({ risk }) => risk === "privileged"));
  assert(Object.isFrozen(XIAOWEI_ACTION_CATALOG));
  assert(Object.isFrozen(getXiaoweiAction("actionCreate").data.items.properties.taskInterval.items));
  assert.throws(() => XIAOWEI_ACTION_CATALOG.push({}), TypeError);
  assert.throws(() => { getXiaoweiAction("list").risk = "navigation"; }, TypeError);
});

test("every catalog action accepts its minimum official wire request", () => {
  for (const [action, payload] of MINIMUM_REQUESTS) {
    const options = OPAQUE_ACTIONS.has(action) ? unsafeOpaque : undefined;
    const request = buildXiaoweiRequest(action, payload, options);
    assert.deepEqual(request, { action, ...payload }, action);
    assert(Object.isFrozen(request), action);
    if (request.data && typeof request.data === "object") assert(Object.isFrozen(request.data), action);
    assert.deepEqual(validateXiaoweiRequest(request, options), request, action);
  }
});

test("opaque automation execution and stop contracts are visible but publicly blocked by default", () => {
  for (const [action, payload] of MINIMUM_REQUESTS.filter(([name]) => OPAQUE_ACTIONS.has(name))) {
    assert.equal(getXiaoweiAction(action).risk, "opaque_automation_blocked");
    assert.equal(getXiaoweiAction(action).blockedByDefault, true);
    assert.throws(() => buildXiaoweiRequest(action, payload), throwsCode("OPAQUE_AUTOMATION_BLOCKED"));
    assert.doesNotThrow(() => buildXiaoweiRequest(action, payload, unsafeOpaque));
  }
  assert.equal(getXiaoweiAction("actionTasks").risk, "read_only");
  assert.equal(getXiaoweiAction("autojsTasks").risk, "read_only");
});

test("strict envelopes reject unknown actions, fields, missing data, and wrong official casing", () => {
  assert.throws(() => buildXiaoweiRequest("unknown", {}), throwsCode("UNKNOWN_ACTION"));
  assert.throws(() => buildXiaoweiRequest("addtagdevice", {
    devices: "device-01",
    data: { name: "content" },
  }), throwsCode("UNKNOWN_ACTION"));
  assert.throws(() => buildXiaoweiRequest("list", { unexpected: true }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => validateXiaoweiRequest({ action: "list", data: {} }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("screen", { devices: "device-01" }), throwsCode("MISSING_FIELD"));
  assert.throws(() => buildXiaoweiRequest("screen", {
    devices: "device-01",
    data: { savePath: "D:\\Pictures", extra: true },
  }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("actionCreate", {
    devices: "device-01",
    data: [{ actionName: "task", ...automationTiming, extra: true }],
  }, unsafeOpaque), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("getTags", { devices: "device-01" }), throwsCode("UNKNOWN_FIELD"));
});

test("devices='all' is rejected for every targeted non-read-only action by default", () => {
  for (const [action, payload] of MINIMUM_REQUESTS) {
    const definition = getXiaoweiAction(action);
    if (definition.devices !== "required" || READ_ONLY_RISKS.has(definition.risk)) continue;
    const options = OPAQUE_ACTIONS.has(action) ? unsafeOpaque : undefined;
    assert.throws(
      () => buildXiaoweiRequest(action, { ...payload, devices: "all" }, options),
      throwsCode("ALL_DEVICES_FORBIDDEN"),
      action,
    );
  }
  assert.doesNotThrow(() => buildXiaoweiRequest("screen", {
    devices: "all",
    data: { savePath: "D:\\Pictures" },
  }));
  assert.doesNotThrow(() => buildXiaoweiRequest("actionTasks", { devices: "all" }));
});

test("pointer and key events enforce official type and coordinate boundaries", () => {
  assert.doesNotThrow(() => buildXiaoweiRequest("pointerEvent", {
    devices: "device-01",
    data: { type: "5", x: "0", y: "100" },
  }));
  assert.doesNotThrow(() => buildXiaoweiRequest("pointerEvent", {
    devices: "device-01",
    data: { type: "9" },
  }));
  for (const data of [
    { type: "0", x: "-0.01", y: "50" },
    { type: "0", x: "50", y: "100.01" },
    { type: "0", x: "50" },
    { type: "6", x: "50", y: "50" },
    { type: "3", x: "50", y: "50" },
    { type: 10, x: "50", y: "50" },
    { type: "10", x: 50, y: "50" },
  ]) {
    assert.throws(() => buildXiaoweiRequest("pointerEvent", { devices: "device-01", data }));
  }
  for (const type of [0, 4, 1.5, "0", "4"]) {
    assert.throws(() => buildXiaoweiRequest("pushEvent", { devices: "device-01", data: { type } }));
  }
});

test("paths, selectors, names, commands, and content enforce exact length and safety boundaries", () => {
  const maxPath = `D:\\${"p".repeat(XIAOWEI_ACTION_LIMITS.path - 3)}`;
  const maxDevice = "d".repeat(XIAOWEI_ACTION_LIMITS.deviceSelector);
  const maxName = "😀".repeat(XIAOWEI_ACTION_LIMITS.name);
  const maxContent = "文".repeat(XIAOWEI_ACTION_LIMITS.content);
  assert.doesNotThrow(() => buildXiaoweiRequest("screen", { devices: maxDevice, data: { savePath: maxPath } }));
  assert.doesNotThrow(() => buildXiaoweiRequest("addTag", { data: { name: maxName } }));
  assert.doesNotThrow(() => buildXiaoweiRequest("inputText", { devices: "device-01", data: { content: maxContent } }));
  assert.throws(() => buildXiaoweiRequest("screen", {
    devices: "device-01",
    data: { savePath: `${maxPath}p` },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("screen", {
    devices: `${maxDevice}d`,
    data: { savePath: "D:\\Pictures" },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("addTag", { data: { name: `${maxName}😀` } }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("inputText", {
    devices: "device-01",
    data: { content: `${maxContent}文` },
  }), throwsCode("INVALID_FIELD"));
  for (const savePath of [" D:\\Pictures", "D:\\Pic\0tures", "D:\\Pic\ntures"] ) {
    assert.throws(() => buildXiaoweiRequest("screen", { devices: "device-01", data: { savePath } }));
  }
  for (const savePath of ["relative\\Pictures", "/sdcard/Pictures", "D:\\safe\\..\\outside"]) {
    assert.throws(() => buildXiaoweiRequest("screen", { devices: "device-01", data: { savePath } }), throwsCode("INVALID_FIELD"));
  }
  for (const filePath of ["D:\\phone.txt", "sdcard/a.txt", "/sdcard/../data/a.txt"]) {
    assert.throws(() => buildXiaoweiRequest("pullFile", {
      devices: "device-01",
      data: { filePath, savePath: "D:\\Downloads" },
    }), throwsCode("INVALID_FIELD"));
  }
  for (const [action, data] of [
    ["uploadFile", { filePath: "/sdcard/upload.txt", isMedia: "0" }],
    ["installApk", { filePath: "/sdcard/app.apk" }],
  ]) {
    assert.throws(() => buildXiaoweiRequest(action, { devices: "device-01", data }), throwsCode("INVALID_FIELD"));
  }
  assert.throws(() => buildXiaoweiRequest("pullFile", {
    devices: "device-01",
    data: { filePath: "/sdcard/a.txt", savePath: "/sdcard/Downloads" },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("autojsCreate", {
    devices: "device-01",
    data: [{ path: "/sdcard/task.js", ...automationTiming }],
  }, unsafeOpaque), throwsCode("INVALID_FIELD"));
  assert.doesNotThrow(() => buildXiaoweiRequest("adb", {
    devices: "device-01",
    data: { command: "adb shell wm size" },
  }));
  assert.throws(() => buildXiaoweiRequest("adb_shell", {
    devices: "device-01",
    data: { command: "adb shell wm size" },
  }), throwsCode("INVALID_FIELD"));
});

test("APK, IME, tag, upload, and opaque task data types remain strict", () => {
  assert.throws(() => buildXiaoweiRequest("updateDevices", {
    devices: "device-01",
    data: { sort: 1.5, name: "phone" },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("uploadFile", {
    devices: "device-01",
    data: { filePath: "D:\\a.txt", isMedia: 1 },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("uploadFile", {
    devices: "device-01",
    data: { filePath: "D:\\a.txt", isMedia: "2" },
  }), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("installApk", {
    devices: "device-01",
    data: { apk: "com.example" },
  }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("startApk", {
    devices: "device-01",
    data: { filePath: "D:\\app.apk" },
  }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("selectIme", {
    devices: "device-01",
    data: { content: "ime" },
  }), throwsCode("UNKNOWN_FIELD"));
  assert.throws(() => buildXiaoweiRequest("updateTag", {
    data: { name: "new" },
  }), throwsCode("MISSING_FIELD"));
  assert.throws(() => buildXiaoweiRequest("actionCreate", {
    devices: "device-01",
    data: [],
  }, unsafeOpaque), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("actionCreate", {
    devices: "device-01",
    data: [{ actionName: "task", ...automationTiming, taskInterval: [5, 1] }],
  }, unsafeOpaque), throwsCode("INVALID_FIELD"));
  assert.throws(() => buildXiaoweiRequest("autojsCreate", {
    devices: "device-01",
    data: [{ path: "D:\\task.js", ...automationTiming, startTimes: Array(513).fill("00:00") }],
  }, unsafeOpaque), throwsCode("INVALID_FIELD"));
});
