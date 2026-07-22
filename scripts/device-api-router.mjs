import { createPublicManifest, summarizeCapabilities } from "./lib/xiaowei-capabilities.mjs";
import { XiaoweiError, toErrorResult } from "./lib/xiaowei-errors.mjs";

function statusForError(error) {
  if (!(error instanceof XiaoweiError)) return 500;
  if (["XIAOWEI_INVALID_ACTION", "XIAOWEI_INVALID_TIMEOUT", "XIAOWEI_INVALID_PARAMETERS", "XIAOWEI_INVALID_REQUEST", "XIAOWEI_IDEMPOTENCY_REQUIRED"].includes(error.code)) return 400;
  if (["XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE", "XIAOWEI_IDEMPOTENCY_CONFLICT", "XIAOWEI_DEVICE_BUSY"].includes(error.code)) return 409;
  if (error.code === "XIAOWEI_DEVICE_LIST_INVALID") return 502;
  if (error.code.startsWith("XIAOWEI_")) return 502;
  return 500;
}

function sanitizedDevices(response) {
  const devices = Array.isArray(response?.data) ? response.data : [];
  return devices.filter((device) => device?.hide !== true).map((device) => ({
    alias: String(device?.sort ?? "").padStart(2, "0"),
    model: device?.model ?? null,
    online: true,
  }));
}

export function createDeviceApiRouter({ rawService, client, operationService }) {
  if (!rawService || typeof rawService.invokeRaw !== "function") {
    throw new TypeError("createDeviceApiRouter requires rawService.invokeRaw()");
  }

  return {
    async handle({ method, path, body }) {
      if (method === "GET" && path === "/device/v1/manifest") {
        return {
          status: 200,
          body: {
            ...createPublicManifest(),
            summary: summarizeCapabilities(),
            raw: {
              method: "POST",
              path: "/device/v1/raw",
              allowAnyAction: true,
              actionAllowlist: null,
              data: "any JSON value",
              canaryDeviceAlias: "01",
            },
            endpoints: {
              devices: "GET /device/v1/devices",
              invoke: "POST /device/v1/invoke",
              raw: "POST /device/v1/raw",
              operations: "POST /device/v1/operations",
              operation: "GET /device/v1/operations/:id",
            },
            requirements: {
              takeover: false,
              labSession: false,
              rawActionAllowlist: false,
            },
          },
        };
      }

      if (method === "POST" && path === "/device/v1/raw") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return {
            status: 400,
            body: toErrorResult(new XiaoweiError("XIAOWEI_INVALID_REQUEST", "JSON object body is required")),
          };
        }
        try {
          return { status: 200, body: await rawService.invokeRaw(body) };
        } catch (error) {
          return { status: statusForError(error), body: toErrorResult(error) };
        }
      }

      if (method === "GET" && path === "/device/v1/devices") {
        if (!client?.deviceList) return { status: 503, body: toErrorResult(new Error("typed client unavailable")) };
        try {
          return { status: 200, body: { ok: true, devices: sanitizedDevices(await client.deviceList()) } };
        } catch (error) {
          return { status: statusForError(error), body: toErrorResult(error) };
        }
      }

      if (method === "POST" && path === "/device/v1/invoke") {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return { status: 400, body: toErrorResult(new XiaoweiError("XIAOWEI_INVALID_REQUEST", "JSON object body is required")) };
        }
        if (!client?.invoke) return { status: 503, body: toErrorResult(new Error("typed client unavailable")) };
        try {
          const { capability, deviceAlias, params = {} } = body;
          return { status: 200, body: await client.invoke(capability, { deviceAlias, params }) };
        } catch (error) {
          return { status: statusForError(error), body: toErrorResult(error) };
        }
      }

      if (method === "POST" && path === "/device/v1/operations") {
        if (!operationService?.run) return { status: 503, body: toErrorResult(new Error("operation service unavailable")) };
        try {
          return { status: 200, body: await operationService.run({ idempotencyKey: body?.idempotencyKey, request: body?.request }) };
        } catch (error) {
          return { status: statusForError(error), body: toErrorResult(error) };
        }
      }

      const operationMatch = method === "GET" && path.match(/^\/device\/v1\/operations\/([^/]+)$/);
      if (operationMatch) {
        const operation = operationService?.get?.(decodeURIComponent(operationMatch[1]));
        if (operation) return { status: 200, body: operation };
        return { status: 404, body: toErrorResult(new XiaoweiError("XIAOWEI_NOT_FOUND", "operation not found")) };
      }

      return {
        status: 404,
        body: toErrorResult(new XiaoweiError("XIAOWEI_NOT_FOUND", `No route for ${method} ${path}`)),
      };
    },
  };
}
