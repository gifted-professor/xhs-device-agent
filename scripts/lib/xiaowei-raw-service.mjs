import { XiaoweiError } from "./xiaowei-errors.mjs";
import { makeRequest } from "./xiaowei-transport.mjs";

export class XiaoweiRawService {
  constructor({ transport, canaryAlias = "01" }) {
    if (!transport || typeof transport.invoke !== "function") {
      throw new TypeError("XiaoweiRawService requires a transport with invoke()");
    }
    this.transport = transport;
    this.canaryAlias = canaryAlias;
  }

  async resolveDevice(deviceAlias) {
    const response = await this.transport.invoke({ action: "list" });
    if (!Array.isArray(response?.data)) {
      throw new XiaoweiError(
        "XIAOWEI_DEVICE_LIST_INVALID",
        "Xiaowei list did not return a device array",
        { deviceAlias },
      );
    }

    const numericAlias = Number.parseInt(deviceAlias, 10);
    const matches = deviceAlias === this.canaryAlias
      ? response.data.filter((device) => Number(device?.sort) === numericAlias && device?.hide !== true)
      : [];

    const identifiers = matches
      .map((device) => device?.serial || device?.onlySerial)
      .filter((identifier) => typeof identifier === "string" && identifier.length > 0);

    if (matches.length !== 1 || identifiers.length !== 1) {
      throw new XiaoweiError(
        "XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE",
        `Device alias ${deviceAlias} did not resolve to exactly one online Xiaowei device`,
        { deviceAlias, matchCount: matches.length },
      );
    }

    return { identifier: identifiers[0], vendorDevice: matches[0] };
  }

  async invokeRaw({ deviceAlias, action, data, timeoutMs }) {
    // makeRequest validates only that action is a non-empty string. It does not use an allowlist.
    makeRequest({ action, data });
    if (typeof deviceAlias !== "string" || deviceAlias.length === 0) {
      throw new XiaoweiError("XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE", "deviceAlias is required", {
        deviceAlias: deviceAlias ?? null,
        matchCount: 0,
      });
    }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new XiaoweiError("XIAOWEI_INVALID_TIMEOUT", "timeoutMs must be a positive number", { timeoutMs });
    }

    const { identifier } = await this.resolveDevice(deviceAlias);
    const vendorResponse = await this.transport.invoke(
      makeRequest({ action, devices: identifier, data }),
      timeoutMs === undefined ? undefined : { timeoutMs },
    );

    return {
      ok: true,
      deviceAlias,
      action,
      vendorResponse,
    };
  }
}
