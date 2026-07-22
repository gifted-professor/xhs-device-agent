import { XiaoweiError } from "./xiaowei-errors.mjs";

export const AUTOMATION_ROUTE_MAP = Object.freeze({
  "device.tag.add": "addTag",
  "device.tag.remove": "removeTag",
  "device.tag.update": "updateTag",
  "device.tag.attach": "addTagDevice",
  "device.tag.detach": "removeTagDevice",
  "automation.action.create": "actionCreate",
  "automation.action.remove": "actionRemove",
  "automation.task.create": "autojsCreate",
  "automation.task.remove": "autojsRemove",
  "automation.task.run": "execAutojs",
  "automation.command.run": "execCommand",
  "clipboard.global.read": "getGlobalClipboard",
});

export class XiaoweiAutomation {
  constructor({ rawService }) {
    if (!rawService || typeof rawService.invokeRaw !== "function") {
      throw new TypeError("rawService.invokeRaw is required");
    }
    this.rawService = rawService;
  }

  describe(capabilityId) {
    const action = AUTOMATION_ROUTE_MAP[capabilityId];
    if (!action) return null;
    return {
      capabilityId,
      action,
      routeVerified: true,
      schemaVerified: false,
      typedStable: false,
      rawCallable: true,
    };
  }

  async invokeRouteRaw({ capabilityId, deviceAlias, data, timeoutMs }) {
    const route = this.describe(capabilityId);
    if (!route) {
      throw new XiaoweiError("XIAOWEI_CAPABILITY_UNAVAILABLE", `unknown automation route: ${capabilityId}`);
    }
    const result = await this.rawService.invokeRaw({
      deviceAlias,
      action: route.action,
      data,
      timeoutMs,
    });
    return { ...result, capabilityId, maturity: "route_verified_schema_unknown" };
  }
}
