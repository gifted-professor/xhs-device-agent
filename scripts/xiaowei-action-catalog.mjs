const LIMITS = Object.freeze({
  deviceSelector: 1024,
  name: 128,
  path: 1024,
  command: 32768,
  content: 65536,
  ime: 512,
  apk: 512,
  automationItems: 256,
  startTimes: 512,
  startTime: 64,
});

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const text = (maxLength, extras = {}) => ({
  kind: "string",
  minLength: 1,
  maxLength,
  ...extras,
});
const windowsPathText = () => text(LIMITS.path, { format: "windows-absolute-path" });
const androidPathText = () => text(LIMITS.path, { format: "android-absolute-path" });
const dataObject = (required, properties) => ({
  kind: "object",
  required,
  additionalProperties: false,
  properties,
});

const TASK_TIMING_FIELDS = {
  count: { kind: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  startTimes: {
    kind: "array",
    minItems: 0,
    maxItems: LIMITS.startTimes,
    items: text(LIMITS.startTime, { trimmed: true, disallowControls: true }),
  },
  taskInterval: {
    kind: "tuple",
    ordered: true,
    items: [
      { kind: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      { kind: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    ],
  },
  deviceInterval: { kind: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
};

const AUTOMATION_ITEM_BASE = ["count", "startTimes", "taskInterval", "deviceInterval"];
const actionAutomationItem = dataObject(
  ["actionName", ...AUTOMATION_ITEM_BASE],
  {
    actionName: text(LIMITS.name, { trimmed: true, disallowControls: true }),
    ...TASK_TIMING_FIELDS,
  },
);
const autojsAutomationItem = dataObject(
  ["path", ...AUTOMATION_ITEM_BASE],
  { path: windowsPathText(), ...TASK_TIMING_FIELDS },
);
const automationArray = (items) => ({
  kind: "array",
  minItems: 1,
  maxItems: LIMITS.automationItems,
  items,
});

const NO_DATA = null;
const DEVICE_REQUIRED = "required";
const DEVICE_FORBIDDEN = "forbidden";

function entry(action, summary, risk, devices, data = NO_DATA) {
  return {
    action,
    summary,
    risk,
    devices,
    data,
    blockedByDefault: risk === "opaque_automation_blocked",
  };
}

const adbCommandData = dataObject(["command"], {
  command: text(LIMITS.command, {
    trimmed: true,
    disallowNul: true,
  }),
});
const adbShellCommandData = dataObject(["command"], {
  command: text(LIMITS.command, {
    trimmed: true,
    disallowNul: true,
    omitAdbShellPrefix: true,
  }),
});
const nameData = dataObject(["name"], {
  name: text(LIMITS.name, { trimmed: true, disallowControls: true }),
});
const apkData = dataObject(["apk"], {
  apk: text(LIMITS.apk, { trimmed: true, disallowControls: true }),
});

/**
 * The complete Xiaowei local-WebSocket action contract. Definitions are deeply
 * frozen so callers cannot weaken validation or alter risk classifications.
 */
export const XIAOWEI_ACTION_CATALOG = deepFreeze([
  entry("list", "List connected devices", "read_only", DEVICE_FORBIDDEN),
  entry("updateDevices", "Update a device name and sort number", "device_local_change", DEVICE_REQUIRED,
    dataObject(["sort", "name"], {
      sort: { kind: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      name: text(LIMITS.name, { trimmed: true, disallowControls: true }),
    })),
  entry("adb", "Execute a complete legacy ADB command", "privileged", DEVICE_REQUIRED, adbCommandData),
  entry("screen", "Capture the current screen", "read_only_sensitive", DEVICE_REQUIRED,
    dataObject(["savePath"], { savePath: windowsPathText() })),
  entry("pointerEvent", "Send a pointer or swipe event", "navigation", DEVICE_REQUIRED,
    dataObject(["type"], {
      type: { kind: "string", enum: ["0", "1", "2", "4", "5", "6", "7", "8", "9", "10"] },
      x: { kind: "number-string", minimum: 0, maximum: 100 },
      y: { kind: "number-string", minimum: 0, maximum: 100 },
    })),
  entry("pushEvent", "Send task/home/back key", "navigation", DEVICE_REQUIRED,
    dataObject(["type"], { type: { kind: "string", enum: ["1", "2", "3"] } })),
  entry("writeClipBoard", "Write text to the device clipboard", "device_local_change", DEVICE_REQUIRED,
    dataObject(["content"], {
      content: text(LIMITS.content, { minLength: 0, disallowNul: true }),
    })),
  entry("uploadFile", "Upload a local file to a device", "device_local_change", DEVICE_REQUIRED,
    dataObject(["filePath", "isMedia"], {
      filePath: windowsPathText(),
      isMedia: { kind: "string", enum: ["0", "1"] },
    })),
  entry("pullFile", "Download a device file to the computer", "read_only_sensitive", DEVICE_REQUIRED,
    dataObject(["filePath", "savePath"], {
      filePath: androidPathText(),
      savePath: windowsPathText(),
    })),
  entry("apkList", "List installed applications", "read_only", DEVICE_REQUIRED),
  entry("installApk", "Install an APK", "device_local_change", DEVICE_REQUIRED,
    dataObject(["filePath"], { filePath: windowsPathText() })),
  entry("uninstallApk", "Uninstall an application", "destructive", DEVICE_REQUIRED, apkData),
  entry("startApk", "Start an application", "navigation", DEVICE_REQUIRED, apkData),
  entry("stopApk", "Stop an application", "device_local_change", DEVICE_REQUIRED, apkData),
  entry("imeList", "List installed input methods", "read_only", DEVICE_REQUIRED),
  entry("installInputIme", "Install the Xiaowei input method", "device_local_change", DEVICE_REQUIRED),
  entry("selectIme", "Select an input method", "device_local_change", DEVICE_REQUIRED,
    dataObject(["ime"], {
      ime: text(LIMITS.ime, { trimmed: true, disallowControls: true }),
    })),
  entry("inputText", "Input text through the selected Xiaowei IME", "device_local_change", DEVICE_REQUIRED,
    dataObject(["content"], { content: text(LIMITS.content, { disallowNul: true }) })),
  entry("getTags", "List device-group tags", "read_only", DEVICE_FORBIDDEN),
  entry("addTag", "Create a device-group tag", "device_local_change", DEVICE_FORBIDDEN, nameData),
  entry("updateTag", "Rename a device-group tag", "device_local_change", DEVICE_FORBIDDEN,
    dataObject(["oldName", "name"], {
      oldName: text(LIMITS.name, { trimmed: true, disallowControls: true }),
      name: text(LIMITS.name, { trimmed: true, disallowControls: true }),
    })),
  entry("removeTag", "Delete a device-group tag", "destructive", DEVICE_FORBIDDEN, nameData),
  entry("addTagDevice", "Add devices to a tag", "device_local_change", DEVICE_REQUIRED, nameData),
  entry("removeTagDevice", "Remove devices from a tag", "destructive", DEVICE_REQUIRED, nameData),
  entry("adb_shell", "Execute the command following adb shell", "privileged", DEVICE_REQUIRED, adbShellCommandData),
  entry("actionTasks", "List running action tasks", "read_only", DEVICE_REQUIRED),
  entry("actionCreate", "Create opaque action automation tasks", "opaque_automation_blocked", DEVICE_REQUIRED,
    automationArray(actionAutomationItem)),
  entry("actionRemove", "Stop an opaque action automation task", "opaque_automation_blocked", DEVICE_REQUIRED,
    nameData),
  entry("autojsTasks", "List running AutoJS tasks", "read_only", DEVICE_REQUIRED),
  entry("autojsCreate", "Create opaque AutoJS automation tasks", "opaque_automation_blocked", DEVICE_REQUIRED,
    automationArray(autojsAutomationItem)),
  entry("autojsRemove", "Stop an opaque AutoJS automation task", "opaque_automation_blocked", DEVICE_REQUIRED,
    nameData),
]);

export const XIAOWEI_ACTION_RISKS = deepFreeze([
  "read_only",
  "read_only_sensitive",
  "navigation",
  "device_local_change",
  "destructive",
  "privileged",
  "opaque_automation_blocked",
]);

const ACTION_INDEX = new Map(XIAOWEI_ACTION_CATALOG.map((definition) => [definition.action, definition]));
const READ_ONLY_RISKS = new Set(["read_only", "read_only_sensitive"]);

export class XiaoweiActionContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "XiaoweiActionContractError";
    this.code = code;
    if (details.action !== undefined) this.action = details.action;
    if (details.field !== undefined) this.field = details.field;
  }
}

function fail(code, message, action, field) {
  throw new XiaoweiActionContractError(code, message, { action, field });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value) {
  return Reflect.ownKeys(value);
}

function assertPlainObject(value, action, field) {
  if (!isPlainObject(value)) {
    fail("INVALID_FIELD", `${field} must be a plain object`, action, field);
  }
}

function assertAllowedKeys(value, allowed, action, field) {
  for (const key of ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail("UNKNOWN_FIELD", `${field} contains unknown field ${String(key)}`, action, `${field}.${String(key)}`);
    }
  }
}

function codePointLength(value, maximum) {
  if (value.length > maximum * 2) return maximum + 1;
  return [...value].length;
}

function validateString(value, schema, action, field) {
  if (typeof value !== "string") fail("INVALID_FIELD", `${field} must be a string`, action, field);
  if (schema.enum && !schema.enum.includes(value)) {
    fail("INVALID_FIELD", `${field} must be one of ${schema.enum.join(", ")}`, action, field);
  }
  const minimumLength = schema.minLength ?? 0;
  const maximumLength = schema.maxLength ?? Number.MAX_SAFE_INTEGER;
  const length = codePointLength(value, maximumLength);
  if (length < minimumLength || length > maximumLength) {
    fail("INVALID_FIELD", `${field} length must be ${minimumLength}..${maximumLength}`, action, field);
  }
  if (schema.trimmed && value !== value.trim()) {
    fail("INVALID_FIELD", `${field} must not have surrounding whitespace`, action, field);
  }
  if (schema.disallowNul && value.includes("\0")) {
    fail("INVALID_FIELD", `${field} must not contain NUL`, action, field);
  }
  const pathFormat = schema.format === "windows-absolute-path" || schema.format === "android-absolute-path";
  if ((schema.disallowControls || pathFormat) && /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_FIELD", `${field} must not contain control characters`, action, field);
  }
  if (pathFormat && value !== value.trim()) {
    fail("INVALID_FIELD", `${field} must not have surrounding whitespace`, action, field);
  }
  if (schema.format === "windows-absolute-path"
      && (!/^[A-Za-z]:[\\/]/u.test(value) || /(?:^|[\\/])\.\.?([\\/]|$)/u.test(value))) {
    fail("INVALID_FIELD", `${field} must be an absolute Windows drive path without dot segments`, action, field);
  }
  if (schema.format === "android-absolute-path"
      && (!value.startsWith("/") || value.includes("\\") || /(?:^|\/)\.\.?(?:\/|$)/u.test(value))) {
    fail("INVALID_FIELD", `${field} must be an absolute Android path without dot segments`, action, field);
  }
  if (schema.omitAdbShellPrefix && /^adb(?:\.exe)?\s+shell(?:\s|$)/iu.test(value)) {
    fail("INVALID_FIELD", `${field} must omit the adb shell prefix`, action, field);
  }
}

function validateNumberString(value, schema, action, field) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    fail("INVALID_FIELD", `${field} must be a decimal number string`, action, field);
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < schema.minimum || numericValue > schema.maximum) {
    fail("INVALID_FIELD", `${field} must be within ${schema.minimum}..${schema.maximum}`, action, field);
  }
}

function validateNumber(value, schema, action, field, integer) {
  const validType = typeof value === "number" && Number.isFinite(value) && (!integer || Number.isSafeInteger(value));
  if (!validType) {
    fail("INVALID_FIELD", `${field} must be a finite${integer ? " safe integer" : " number"}`, action, field);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    fail("INVALID_FIELD", `${field} must be one of ${schema.enum.join(", ")}`, action, field);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    fail("INVALID_FIELD", `${field} must be at least ${schema.minimum}`, action, field);
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    fail("INVALID_FIELD", `${field} must be at most ${schema.maximum}`, action, field);
  }
}

function validateAgainstSchema(value, schema, action, field) {
  if (schema.kind === "string") {
    validateString(value, schema, action, field);
    return;
  }
  if (schema.kind === "number-string") {
    validateNumberString(value, schema, action, field);
    return;
  }
  if (schema.kind === "boolean") {
    if (typeof value !== "boolean") fail("INVALID_FIELD", `${field} must be a boolean`, action, field);
    return;
  }
  if (schema.kind === "integer" || schema.kind === "number") {
    validateNumber(value, schema, action, field, schema.kind === "integer");
    return;
  }
  if (schema.kind === "array" || schema.kind === "tuple") {
    if (!Array.isArray(value)) fail("INVALID_FIELD", `${field} must be an array`, action, field);
    if (schema.kind === "tuple") {
      if (value.length !== schema.items.length) {
        fail("INVALID_FIELD", `${field} must contain exactly ${schema.items.length} items`, action, field);
      }
      value.forEach((item, index) => validateAgainstSchema(item, schema.items[index], action, `${field}[${index}]`));
      if (schema.ordered && value[0] > value[1]) {
        fail("INVALID_FIELD", `${field} lower bound must not exceed upper bound`, action, field);
      }
      return;
    }
    if (value.length < schema.minItems || value.length > schema.maxItems) {
      fail("INVALID_FIELD", `${field} item count must be ${schema.minItems}..${schema.maxItems}`, action, field);
    }
    value.forEach((item, index) => validateAgainstSchema(item, schema.items, action, `${field}[${index}]`));
    return;
  }
  if (schema.kind === "object") {
    assertPlainObject(value, action, field);
    const allowed = new Set(Object.keys(schema.properties));
    assertAllowedKeys(value, allowed, action, field);
    for (const required of schema.required) {
      if (!Object.hasOwn(value, required)) {
        fail("MISSING_FIELD", `${field}.${required} is required`, action, `${field}.${required}`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      validateAgainstSchema(item, schema.properties[key], action, `${field}.${key}`);
    }
    return;
  }
  fail("INVALID_CATALOG", `Unsupported catalog schema kind ${String(schema.kind)}`, action, field);
}

function validatePointerCoordinates(data, action) {
  const numericType = Number(data.type);
  const directionalSwipe = numericType >= 6 && numericType <= 9;
  const hasX = Object.hasOwn(data, "x");
  const hasY = Object.hasOwn(data, "y");
  if (directionalSwipe && (hasX || hasY)) {
    fail("INVALID_FIELD", "pointerEvent types 6..9 must omit x and y", action, "data");
  }
  if (!directionalSwipe && (!hasX || !hasY)) {
    fail("MISSING_FIELD", "pointerEvent types 0,1,2,4,5,10 require both x and y", action, "data");
  }
}

function validateUnsafeOptions(options) {
  assertPlainObject(options, undefined, "options");
  assertAllowedKeys(options, new Set(["unsafeInternal"]), undefined, "options");
  if (!Object.hasOwn(options, "unsafeInternal")) return Object.freeze({});
  const unsafe = options.unsafeInternal;
  assertPlainObject(unsafe, undefined, "options.unsafeInternal");
  assertAllowedKeys(unsafe, new Set(["allowOpaqueAutomation", "allowAllDevices"]), undefined, "options.unsafeInternal");
  for (const [key, value] of Object.entries(unsafe)) {
    if (typeof value !== "boolean") fail("INVALID_FIELD", `options.unsafeInternal.${key} must be a boolean`, undefined, `options.unsafeInternal.${key}`);
  }
  return unsafe;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneValue(child);
    return result;
  }
  return value;
}

export function getXiaoweiAction(action) {
  return typeof action === "string" ? ACTION_INDEX.get(action) : undefined;
}

export function listXiaoweiActions(options = {}) {
  assertPlainObject(options, undefined, "options");
  assertAllowedKeys(options, new Set(["risk"]), undefined, "options");
  if (!Object.hasOwn(options, "risk")) return XIAOWEI_ACTION_CATALOG;
  if (!XIAOWEI_ACTION_RISKS.includes(options.risk)) {
    fail("INVALID_FIELD", `Unknown Xiaowei action risk ${String(options.risk)}`, undefined, "options.risk");
  }
  return deepFreeze(XIAOWEI_ACTION_CATALOG.filter((definition) => definition.risk === options.risk));
}

/**
 * Validate a complete wire request and return a detached, deeply frozen copy.
 * No request is sent. Unsafe overrides are intentionally nested and opt-in.
 */
export function validateXiaoweiRequest(request, options = {}) {
  const unsafe = validateUnsafeOptions(options);
  assertPlainObject(request, undefined, "request");
  assertAllowedKeys(request, new Set(["action", "devices", "data"]), request.action, "request");
  if (typeof request.action !== "string" || !request.action) {
    fail("MISSING_FIELD", "request.action must be a non-empty string", request.action, "request.action");
  }
  const definition = ACTION_INDEX.get(request.action);
  if (!definition) fail("UNKNOWN_ACTION", `Unknown Xiaowei action ${request.action}`, request.action, "request.action");

  const hasDevices = Object.hasOwn(request, "devices");
  if (definition.devices === DEVICE_REQUIRED && !hasDevices) {
    fail("MISSING_FIELD", `${request.action} requires devices`, request.action, "request.devices");
  }
  if (definition.devices === DEVICE_FORBIDDEN && hasDevices) {
    fail("UNKNOWN_FIELD", `${request.action} does not accept devices`, request.action, "request.devices");
  }
  if (hasDevices) {
    validateString(request.devices, text(LIMITS.deviceSelector, {
      trimmed: true,
      disallowControls: true,
    }), request.action, "request.devices");
  }

  const hasData = Object.hasOwn(request, "data");
  if (definition.data === NO_DATA && hasData) {
    fail("UNKNOWN_FIELD", `${request.action} does not accept data`, request.action, "request.data");
  }
  if (definition.data !== NO_DATA && !hasData) {
    fail("MISSING_FIELD", `${request.action} requires data`, request.action, "request.data");
  }
  if (hasData && definition.data !== NO_DATA) {
    validateAgainstSchema(request.data, definition.data, request.action, "request.data");
  }
  if (request.action === "pointerEvent") validatePointerCoordinates(request.data, request.action);

  if (hasDevices && request.devices.toLowerCase() === "all" && !READ_ONLY_RISKS.has(definition.risk) && !unsafe.allowAllDevices) {
    fail("ALL_DEVICES_FORBIDDEN", `devices='all' is blocked for non-read-only action ${request.action}`, request.action, "request.devices");
  }
  if (definition.blockedByDefault && !unsafe.allowOpaqueAutomation) {
    fail("OPAQUE_AUTOMATION_BLOCKED", `${request.action} is contract-visible but blocked by default`, request.action, "request.action");
  }

  return deepFreeze(cloneValue(request));
}

/** Build and validate a Xiaowei wire request without executing it. */
export function buildXiaoweiRequest(action, payload = {}, options = {}) {
  assertPlainObject(payload, action, "payload");
  assertAllowedKeys(payload, new Set(["devices", "data"]), action, "payload");
  return validateXiaoweiRequest({ action, ...payload }, options);
}

export const XIAOWEI_ACTION_LIMITS = deepFreeze({ ...LIMITS });
