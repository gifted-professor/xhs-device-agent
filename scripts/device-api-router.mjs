import { summarizeCapabilities } from "./lib/xiaowei-capabilities.mjs";
import { XiaoweiError, toErrorResult } from "./lib/xiaowei-errors.mjs";

function statusForError(error) {
  if (!(error instanceof XiaoweiError)) return 500;
  if (["XIAOWEI_INVALID_ACTION", "XIAOWEI_INVALID_TIMEOUT"].includes(error.code)) return 400;
  if (error.code === "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE") return 409;
  if (error.code === "XIAOWEI_DEVICE_LIST_INVALID") return 502;
  if (error.code.startsWith("XIAOWEI_")) return 502;
  return 500;
}

export function createDeviceApiRouter({ rawService }) {
  if (!rawService || typeof rawService.invokeRaw !== "function") {
    throw new TypeError("createDeviceApiRouter requires rawService.invokeRaw()");
  }

  return {
    async handle({ method, path, body }) {
      if (method === "GET" && path === "/device/v1/manifest") {
        return {
          status: 200,
          body: {
            version: 1,
            capabilities: summarizeCapabilities(),
            raw: {
              method: "POST",
              path: "/device/v1/raw",
              allowAnyAction: true,
              actionAllowlist: null,
              data: "any JSON value",
              canaryDeviceAlias: "01",
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

      return {
        status: 404,
        body: toErrorResult(new XiaoweiError("XIAOWEI_NOT_FOUND", `No route for ${method} ${path}`)),
      };
    },
  };
}
