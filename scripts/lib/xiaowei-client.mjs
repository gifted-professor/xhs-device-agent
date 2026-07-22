import { getCapability } from "./xiaowei-capabilities.mjs";
import { XiaoweiError } from "./xiaowei-errors.mjs";
import { validateCapabilityParams } from "./xiaowei-validate.mjs";
import { verifyStableFile } from "./xiaowei-verifiers.mjs";

function invalid(message, details = {}) {
  throw new XiaoweiError("XIAOWEI_INVALID_PARAMETERS", message, details);
}

export function normalizeCoordinates(coordinate) {
  if (!coordinate || !["percent", "sourcePixels", "displayPixels"].includes(coordinate.space)) {
    invalid("coordinate space must be percent, sourcePixels, or displayPixels");
  }
  const { space, x, y, width, height } = coordinate;
  if (![x, y].every(Number.isFinite)) invalid("coordinate x and y must be finite numbers");

  if (space === "percent") {
    if (x < 0 || x > 100 || y < 0 || y > 100) invalid("percent coordinates must be within 0..100");
    return { x, y };
  }

  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    invalid(`${space} coordinates require positive width and height`);
  }
  if (x < 0 || x > width || y < 0 || y > height) invalid(`${space} coordinates are outside the declared bounds`);
  return {
    x: Number(((x / width) * 100).toFixed(4)),
    y: Number(((y / height) * 100).toFixed(4)),
  };
}

export class XiaoweiClient {
  constructor({ transport, resolveDevice, readCurrentIme, verifyFile = verifyStableFile }) {
    if (!transport || typeof transport.invoke !== "function") throw new TypeError("transport.invoke is required");
    if (typeof resolveDevice !== "function") throw new TypeError("resolveDevice is required");
    this.transport = transport;
    this.resolveDevice = resolveDevice;
    this.readCurrentIme = readCurrentIme;
    this.verifyFile = verifyFile;
  }

  async targeted(deviceAlias, action, data, timeoutMs) {
    if (typeof deviceAlias !== "string" || deviceAlias.length === 0) invalid("deviceAlias is required");
    const resolved = await this.resolveDevice(deviceAlias);
    const identifier = typeof resolved === "string" ? resolved : resolved?.identifier;
    if (!identifier) throw new XiaoweiError("XIAOWEI_DEVICE_ALIAS_NOT_UNIQUE", "device alias did not resolve", { deviceAlias });
    const request = { action, devices: identifier };
    if (data !== undefined) request.data = data;
    return this.transport.invoke(request, timeoutMs === undefined ? undefined : { timeoutMs });
  }

  async deviceList() {
    return this.transport.invoke({ action: "list" });
  }

  async screenCapture({ deviceAlias, savePath }) {
    const vendorResponse = await this.targeted(deviceAlias, "Screen", { savePath }, 20000);
    const verification = await this.verifyFile(savePath);
    return { status: "verified", vendorResponse, verification };
  }

  async home({ deviceAlias }) {
    const vendorResponse = await this.targeted(deviceAlias, "pushEvent", { type: "2" });
    return { status: "executed", vendorResponse };
  }

  async back({ deviceAlias }) {
    const vendorResponse = await this.targeted(deviceAlias, "pushEvent", { type: "3" });
    return { status: "executed", vendorResponse };
  }

  async tap({ deviceAlias, coordinate }) {
    const point = normalizeCoordinates(coordinate);
    // Xiaowei 9.10.113 rejects numeric percentages; the legacy working adapter sends strings.
    const vendorPoint = { x: String(point.x), y: String(point.y) };
    const down = await this.targeted(deviceAlias, "pointerEvent", { type: "0", ...vendorPoint });
    const up = await this.targeted(deviceAlias, "pointerEvent", { type: "1", ...vendorPoint });
    return { status: "executed", vendorResponse: { down, up }, coordinate: point };
  }

  async swipe({ deviceAlias, direction }) {
    if (!(["up", "down"].includes(direction))) invalid("direction must be up or down");
    const vendorResponse = await this.targeted(deviceAlias, "pointerEvent", { type: direction === "up" ? "6" : "7" });
    return { status: "executed", vendorResponse };
  }

  async autoScroll() {
    throw new XiaoweiError(
      "XIAOWEI_CAPABILITY_UNAVAILABLE",
      "automatic scrolling is not documented; pointerEvent 6/7 are one-shot swipes",
    );
  }

  async imeList({ deviceAlias }) {
    return this.targeted(deviceAlias, "imeList");
  }

  async selectIme({ deviceAlias, ime }) {
    const vendorResponse = await this.targeted(deviceAlias, "selectIme", { ime });
    if (typeof this.readCurrentIme !== "function") return { status: "executed", vendorResponse };
    const currentIme = await this.readCurrentIme(deviceAlias);
    if (currentIme !== ime) {
      throw new XiaoweiError("XIAOWEI_POSTCONDITION_FAILED", "selected IME did not match fresh readback", {
        deviceAlias,
        expected: ime,
        actual: currentIme,
      });
    }
    return { status: "verified", vendorResponse, currentIme };
  }

  async inputText({ deviceAlias, content }) {
    const vendorResponse = await this.targeted(deviceAlias, "inputText", { content });
    return { status: "executed", vendorResponse };
  }

  async appList({ deviceAlias }) {
    return this.targeted(deviceAlias, "apkList");
  }

  async startApp({ deviceAlias, apk }) {
    const vendorResponse = await this.targeted(deviceAlias, "startApk", { apk }, 30000);
    return { status: "executed", vendorResponse };
  }

  async stopApp({ deviceAlias, apk }) {
    const vendorResponse = await this.targeted(deviceAlias, "stopApk", { apk }, 30000);
    return { status: "executed", vendorResponse };
  }

  async installApp({ deviceAlias, filePath }) {
    const vendorResponse = await this.targeted(deviceAlias, "installApk", { filePath }, 120000);
    return { status: "executed", vendorResponse };
  }

  async uninstallApp({ deviceAlias, apk }) {
    const vendorResponse = await this.targeted(deviceAlias, "uninstallApk", { apk }, 120000);
    return { status: "executed", vendorResponse };
  }

  async uploadFile({ deviceAlias, localPath, phonePath, fileName, isMedia }) {
    const vendorResponse = await this.targeted(deviceAlias, "uploadFile", {
      localPath,
      phonePath,
      fileName,
      isMedia,
    }, 120000);
    return { status: "executed", vendorResponse };
  }

  async pullFile({ deviceAlias, filePath, savePath, verify = false }) {
    const vendorResponse = await this.targeted(deviceAlias, "pullFile", { filePath, savePath }, 120000);
    if (!verify) return { status: "executed", vendorResponse };
    const verification = await this.verifyFile(savePath);
    return { status: "verified", vendorResponse, verification };
  }

  async tagList({ deviceAlias }) {
    return this.targeted(deviceAlias, "getTags");
  }

  async actionList({ deviceAlias }) {
    return this.targeted(deviceAlias, "actionTasks");
  }

  async automationTaskList({ deviceAlias }) {
    return this.targeted(deviceAlias, "autojsTasks");
  }

  async readClipboard({ deviceAlias }) {
    return this.targeted(deviceAlias, "getClipboard");
  }

  async invoke(capabilityId, { deviceAlias, params = {} } = {}) {
    const capability = getCapability(capabilityId);
    if (!capability?.typedApi) {
      throw new XiaoweiError("XIAOWEI_CAPABILITY_UNAVAILABLE", `typed capability is unavailable: ${capabilityId}`);
    }
    const checked = validateCapabilityParams(capability, params);
    const handlers = {
      "device.list": () => this.deviceList(),
      "screen.capture": () => this.screenCapture({ deviceAlias, ...checked }),
      "input.key.home": () => this.home({ deviceAlias }),
      "input.key.back": () => this.back({ deviceAlias }),
      "input.pointer.tap": () => this.tap({ deviceAlias, ...checked }),
      "input.pointer.swipe": () => this.swipe({ deviceAlias, ...checked }),
      "input.ime.list": () => this.imeList({ deviceAlias }),
      "input.ime.select": () => this.selectIme({ deviceAlias, ...checked }),
      "input.text.input": () => this.inputText({ deviceAlias, ...checked }),
      "app.list": () => this.appList({ deviceAlias }),
      "app.start": () => this.startApp({ deviceAlias, ...checked }),
      "app.stop": () => this.stopApp({ deviceAlias, ...checked }),
      "app.install": () => this.installApp({ deviceAlias, ...checked }),
      "app.uninstall": () => this.uninstallApp({ deviceAlias, ...checked }),
      "file.push": () => this.uploadFile({ deviceAlias, ...checked }),
      "file.pull": () => this.pullFile({ deviceAlias, ...checked }),
      "device.tag.list": () => this.tagList({ deviceAlias }),
      "automation.action.list": () => this.actionList({ deviceAlias }),
      "automation.task.list": () => this.automationTaskList({ deviceAlias }),
      "clipboard.export": () => this.readClipboard({ deviceAlias }),
    };
    if (!handlers[capabilityId]) throw new XiaoweiError("XIAOWEI_CAPABILITY_UNAVAILABLE", `no typed handler: ${capabilityId}`);
    return handlers[capabilityId]();
  }
}
