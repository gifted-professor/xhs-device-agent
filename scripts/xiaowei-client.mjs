import path from "node:path";

import {
  buildXiaoweiRequest,
  getXiaoweiAction,
  listXiaoweiActions,
} from "./xiaowei-action-catalog.mjs";
import {
  normalizeXiaoweiResponse,
  sendXiaoweiRequest,
  validateXiaoweiEndpoint,
} from "./xiaowei-transport.mjs";

const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const PROFILE_CAPABILITIES = new Set(["selectIme", "inputText"]);
const ORDINARY_ACCEPTED_CAPABILITIES = new Set([
  "screen", "pushEvent", "apkList", "startApk", "stopApk",
  "imeList", "selectIme", "inputText",
]);

export class XiaoweiClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "XiaoweiClientError";
    this.code = code;
    this.action = details.action;
    this.outcome = details.outcome ?? "failed";
    this.vendorCode = details.vendorCode;
    this.sent = details.sent;
  }
}

function fail(code, message, details) {
  throw new XiaoweiClientError(code, message, details);
}

function validateAcceptedActions(actions, { developmentMode = false } = {}) {
  if (!Array.isArray(actions)) throw new Error("Xiaowei acceptedActions must be an array");
  const result = [];
  for (const action of actions) {
    const definition = getXiaoweiAction(action);
    if (!definition) throw new Error(`Unknown accepted Xiaowei action: ${String(action)}`);
    if (!developmentMode && (definition.blockedByDefault || definition.risk === "privileged"
        || !ORDINARY_ACCEPTED_CAPABILITIES.has(action))) {
      throw new Error(`Xiaowei action ${action} cannot be enabled as an ordinary accepted capability`);
    }
    if (!result.includes(action)) result.push(action);
  }
  return Object.freeze(result);
}

function requireSessionConfirmation(definition, authorization) {
  if (authorization.mode !== "session_confirmation" || authorization.confirmed !== true
      || typeof authorization.reason !== "string" || authorization.reason.trim().length < 3
      || typeof authorization.rollback !== "string" || authorization.rollback.trim().length < 3) {
    fail("CONFIRMATION_REQUIRED", `${definition.action} requires this session's confirmation, reason, and rollback`, { action: definition.action });
  }
}

function requireSingleDevice(definition, request, { developmentMode = false } = {}) {
  if (developmentMode) return;
  if (definition.devices !== "required") return;
  if (typeof request.devices !== "string" || request.devices.includes(",")
      || request.devices.toLowerCase() === "all") {
    fail("SINGLE_DEVICE_REQUIRED", `${definition.action} must target exactly one device through the ordinary client`, {
      action: definition.action,
    });
  }
}

function requireApprovedPackage(definition, request, authorization) {
  if (!["startApk", "stopApk"].includes(definition.action)) return;
  const apk = request.data?.apk;
  if (!PACKAGE_NAME.test(String(apk ?? "")) || authorization.approvedPackage !== apk) {
    fail("APP_PACKAGE_NOT_APPROVED", `${definition.action} requires the exact approved application package`, {
      action: definition.action,
    });
  }
}

function isWithinWindowsRoot(candidate, root) {
  if (typeof candidate !== "string" || typeof root !== "string" || !candidate || !root) return false;
  const resolvedRoot = path.win32.resolve(root);
  const relative = path.win32.relative(resolvedRoot, path.win32.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative));
}

function validateAuthorization(definition, request, authorization = {}, { developmentMode = false } = {}) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    fail("AUTHORIZATION_REQUIRED", `${definition.action} requires a structured authorization`, { action: definition.action });
  }
  if (developmentMode) return;
  if (definition.risk === "privileged") {
    fail("PRIVILEGED_BLOCKED", `${definition.action} is not available through the ordinary Xiaowei client`, { action: definition.action });
  }
  if (definition.risk === "opaque_automation_blocked") {
    fail("OPAQUE_AUTOMATION_BLOCKED", `${definition.action} is visible for audit but cannot be executed`, { action: definition.action });
  }
  if (definition.risk === "read_only") return;
  if (definition.risk === "read_only_sensitive") {
    if (definition.action === "screen") {
      if (authorization.mode !== "verified_read"
          || !isWithinWindowsRoot(request.data.savePath, authorization.approvedSaveRoot)) {
        fail("SENSITIVE_PATH_NOT_APPROVED", "screen requires a save path under the approved local root", { action: definition.action });
      }
      return;
    }
    requireSessionConfirmation(definition, authorization);
    if (definition.action !== "pullFile"
        || authorization.approvedDevicePath !== request.data.filePath
        || !isWithinWindowsRoot(request.data.savePath, authorization.approvedSaveRoot)) {
      fail("SENSITIVE_PATH_NOT_APPROVED", "pullFile requires the exact approved device path and a save path under the approved local root", { action: definition.action });
    }
    return;
  }

  if (definition.risk === "navigation") {
    if (authorization.mode !== "verified_navigation" || authorization.singleDevice !== true
        || typeof authorization.expectedPostcondition !== "string"
        || authorization.expectedPostcondition.trim().length < 3) {
      fail("NAVIGATION_CONTEXT_REQUIRED", `${definition.action} requires a single-device verification plan`, { action: definition.action });
    }
    if (definition.action === "pointerEvent" && authorization.semanticTargetResolved !== true) {
      fail("SEMANTIC_TARGET_REQUIRED", "pointerEvent requires a target resolved from a fresh device hierarchy", { action: definition.action });
    }
    if (definition.action === "pushEvent" && !["1", "2", "3"].includes(request.data?.type)) {
      fail("PUSH_EVENT_NOT_PUBLIC", "the ordinary client exposes only RECENT, HOME, and BACK push events", { action: definition.action });
    }
    requireApprovedPackage(definition, request, authorization);
    return;
  }

  if (definition.risk === "device_local_change" && authorization.mode === "approved_device_profile") {
    if (!PROFILE_CAPABILITIES.has(definition.action)
        || authorization.capability !== definition.action
        || !SAFE_ALIAS.test(String(authorization.deviceAlias ?? ""))) {
      fail("PROFILE_APPROVAL_INVALID", `${definition.action} is not covered by this device profile`, { action: definition.action });
    }
    return;
  }

  requireSessionConfirmation(definition, authorization);
  requireApprovedPackage(definition, request, authorization);
  if (definition.risk === "destructive"
      && (authorization.exactAction !== definition.action || authorization.irreversibleAcknowledged !== true)) {
    fail("DESTRUCTIVE_ACK_REQUIRED", `${definition.action} requires an exact irreversible-action acknowledgement`, { action: definition.action });
  }
}

function transportOutcome(error) {
  if (error?.sent === true) return "unknown";
  if (error?.outcome === "unknown") return "unknown";
  if (error?.sent === false) return "failed";
  if (error?.outcome === "failed") return "failed";
  return /outcome is unknown|after the request was sent|before responding/iu.test(String(error?.message ?? ""))
    ? "unknown"
    : "failed";
}

export function createXiaoweiClient(config = {}, runtime = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Xiaowei client config must be an object");
  }
  const endpoint = validateXiaoweiEndpoint(config.endpoint ?? "ws://127.0.0.1:22222/");
  const developmentMode = config.developmentMode === true;
  const acceptedActions = validateAcceptedActions(config.acceptedActions ?? [], { developmentMode });
  const accepted = new Set(acceptedActions);
  const sendRequest = runtime.sendRequest ?? sendXiaoweiRequest;
  const now = runtime.now ?? (() => Date.now());

  return Object.freeze({
    endpoint,
    acceptedActions,
    developmentMode,
    catalog() {
      return listXiaoweiActions();
    },
    async probe() {
      const startedAt = now();
      let raw;
      try {
        raw = await sendRequest({ action: "list" }, { endpoint });
      } catch (error) {
        throw new XiaoweiClientError("TRANSPORT_FAILED", error.message, {
          action: "list",
          outcome: transportOutcome(error),
          sent: error?.sent,
        });
      }
      let response;
      try { response = normalizeXiaoweiResponse(raw); } catch (error) {
        throw new XiaoweiClientError("INVALID_RESPONSE", error.message, { action: "list", outcome: "unknown", sent: true });
      }
      if (!response.ok) {
        throw new XiaoweiClientError("VENDOR_FAILED", response.message || "Xiaowei list probe failed", {
          action: "list",
          vendorCode: response.code,
        });
      }
      return Object.freeze({
        ok: true,
        action: "list",
        outcome: "accepted_unverified",
        data: response.data,
        vendor: Object.freeze({ code: response.code, message: response.message }),
        audit: Object.freeze({ transport: "xiaowei-api", durationMs: Math.max(0, now() - startedAt) }),
      });
    },
    async invoke(action, payload = {}, execution = {}) {
      const definition = getXiaoweiAction(action);
      if (!definition) fail("UNKNOWN_ACTION", `Unknown Xiaowei action ${String(action)}`, { action });
      if (!accepted.has(action)) {
        fail("CAPABILITY_NOT_ACCEPTED", `Xiaowei action ${action} has not passed local per-action acceptance`, { action });
      }
      const request = buildXiaoweiRequest(action, payload, developmentMode ? {
        unsafeInternal: { allowAllDevices: true, allowOpaqueAutomation: true },
      } : {});
      requireSingleDevice(definition, request, { developmentMode });
      validateAuthorization(definition, request, execution.authorization ?? {}, { developmentMode });
      const startedAt = now();
      let raw;
      try {
        raw = await sendRequest(request, { endpoint });
      } catch (error) {
        throw new XiaoweiClientError("TRANSPORT_FAILED", error.message, {
          action,
          outcome: transportOutcome(error),
          sent: error?.sent,
        });
      }
      let response;
      try { response = normalizeXiaoweiResponse(raw); } catch (error) {
        throw new XiaoweiClientError("INVALID_RESPONSE", error.message, { action, outcome: "unknown", sent: true });
      }
      if (!response.ok) {
        throw new XiaoweiClientError("VENDOR_FAILED", response.message || `Xiaowei ${action} failed`, {
          action,
          vendorCode: response.code,
          sent: true,
        });
      }
      return Object.freeze({
        ok: true,
        action,
        risk: definition.risk,
        outcome: "accepted_unverified",
        data: response.data,
        vendor: Object.freeze({ code: response.code, message: response.message }),
        audit: Object.freeze({ transport: "xiaowei-api", durationMs: Math.max(0, now() - startedAt) }),
      });
    },
  });
}
