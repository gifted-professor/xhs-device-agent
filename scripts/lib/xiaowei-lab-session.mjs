import { XiaoweiError } from "./xiaowei-errors.mjs";

export class XiaoweiLabSession {
  constructor({ id, deviceAlias, host, version, expiresAt, now = Date.now }) {
    this.id = id;
    this.deviceAlias = deviceAlias;
    this.host = host;
    this.version = version;
    this.expiresAt = expiresAt;
    this.now = now;
  }

  assertUsable({ deviceAlias, host, version, online }) {
    if (this.now() > this.expiresAt) throw new XiaoweiError("XIAOWEI_LAB_EXPIRED", "lab session expired");
    if (deviceAlias !== this.deviceAlias) throw new XiaoweiError("XIAOWEI_LAB_ALIAS_MISMATCH", "lab session alias mismatch");
    if (host !== this.host) throw new XiaoweiError("XIAOWEI_LAB_HOST_MISMATCH", "lab session host mismatch");
    if (version !== this.version) throw new XiaoweiError("XIAOWEI_LAB_VERSION_MISMATCH", "lab session version mismatch");
    if (!online) throw new XiaoweiError("XIAOWEI_LAB_DEVICE_OFFLINE", "lab session device is offline");
    return true;
  }
}
