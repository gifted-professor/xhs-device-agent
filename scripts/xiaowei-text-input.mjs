import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createXiaoweiClient } from "./xiaowei-client.mjs";
import { validateXiaoweiEndpoint } from "./xiaowei-transport.mjs";

const execFileAsync = promisify(execFile);
const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const SAFE_IME_SERVICE = /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/u;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const XIAOWEI_BRIDGE_IME = /^(?:com\.xiaowei\.assistant\/.+|com\.android\.xwkeyboard\/.+|com\.xueren\/.+|com\.truedian\.dragon\/.+)$/iu;
const REQUIRED_ACTIONS = Object.freeze(["imeList", "selectIme", "inputText"]);
const ECHO_VERIFICATION_MODES = new Set(["ui_text", "local_ocr"]);

function approvedBridgeService(value) {
  return typeof value === "string" && SAFE_IME_SERVICE.test(value) && XIAOWEI_BRIDGE_IME.test(value);
}

function hasTextActionGate(api, aliases = []) {
  const baseAccepted = api && api.enabled === true
    && typeof api.acceptedXiaoweiVersion === "string" && api.acceptedXiaoweiVersion.length > 0
    && api.acceptedXiaoweiVersion === api.currentXiaoweiVersion
    && Array.isArray(api.acceptedActions)
    && REQUIRED_ACTIONS.every((action) => api.acceptedActions.includes(action));
  if (!baseAccepted || !api.acceptedActionsByAlias || typeof api.acceptedActionsByAlias !== "object" || Array.isArray(api.acceptedActionsByAlias)
      || !api.acceptedDeviceSerialsByAlias || typeof api.acceptedDeviceSerialsByAlias !== "object"
      || Array.isArray(api.acceptedDeviceSerialsByAlias)) return false;
  return aliases.every((alias) => Array.isArray(api.acceptedActionsByAlias[alias])
    && REQUIRED_ACTIONS.every((action) => api.acceptedActionsByAlias[alias].includes(action))
    && typeof api.acceptedDeviceSerialsByAlias[alias] === "string"
    && api.acceptedDeviceSerialsByAlias[alias].length > 0);
}

function apiDeviceIds(value) {
  if (!Array.isArray(value)) throw new Error("Xiaowei list returned an invalid device inventory");
  return [...new Set(value
    .map((device) => String(device?.serial ?? device?.onlySerial ?? "").trim())
    .filter(Boolean))].sort();
}

function restorationFailure(cause, audit) {
  const error = new Error("Xiaowei text input stopped because the prior input method could not be restored");
  error.name = "XiaoweiTextInputError";
  error.code = "RESTORE_FAILED";
  error.action = "selectIme";
  error.outcome = cause?.outcome ?? "failed";
  error.inputMethodAudit = { ...audit };
  error.cause = cause;
  return error;
}

function stagedInputFailure(cause, audit, action, code, message) {
  if (cause && typeof cause === "object"
      && (cause.name === "XiaoweiClientError" || cause.name === "ProviderStop")) {
    cause.inputMethodAudit = { ...audit };
    return cause;
  }
  const error = new Error(message);
  error.name = "XiaoweiTextInputError";
  error.code = code;
  error.action = action;
  error.outcome = cause?.outcome ?? "failed";
  error.inputMethodAudit = { ...audit };
  error.cause = cause;
  return error;
}

async function defaultCommandRunner(adbPath, serial, args) {
  const { stdout } = await execFileAsync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout ?? "").trim();
}

async function expectedPackageIsFocused(commandRunner, config, record, expectedPackage) {
  const probes = [
    ["shell", "dumpsys", "window", "windows"],
    ["shell", "dumpsys", "window"],
    ["shell", "dumpsys", "activity", "activities"],
  ];
  const focusMarker = /mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity|ResumedActivity/iu;
  for (const args of probes) {
    try {
      const output = await commandRunner(config.adbPath, record.serial, args);
      const focusedLines = String(output).split(/\r?\n/u).filter((line) => focusMarker.test(line));
      if (focusedLines.some((line) => line.includes(expectedPackage))) return true;
    } catch {
      // Some Android/MIUI builds omit or reject individual dumpsys sections.
      // Continue to the next read-only focus source and require one positive
      // current/resumed marker before allowing device-local IME changes.
    }
  }
  return false;
}

async function waitForDefaultIme(commandRunner, sleep, config, record, expectedIme) {
  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await commandRunner(config.adbPath, record.serial, ["shell", "settings", "get", "secure", "default_input_method"]);
    if (current === expectedIme) return true;
    if (attempt < attempts - 1) await sleep(250);
  }
  return false;
}

async function enabledImeServices(commandRunner, config, record) {
  const output = await commandRunner(config.adbPath, record.serial, ["shell", "ime", "list", "-s"]);
  return new Set(String(output).split(/\r?\n/u).map((value) => value.trim()).filter((value) => SAFE_IME_SERVICE.test(value)));
}

async function waitForInputMethodBinding(commandRunner, sleep, config, record, expectedIme) {
  const attempts = 12;
  const currentMethodMarker = /mCurMethodId|mSelectedMethodId|mCurrentMethodId|mCurId|mCurMethod/iu;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = await commandRunner(config.adbPath, record.serial, ["shell", "dumpsys", "input_method"]);
    const currentLines = String(output).split(/\r?\n/u).filter((line) => currentMethodMarker.test(line));
    if (currentLines.some((line) => line.includes(expectedIme))) return true;
    if (attempt < attempts - 1) await sleep(250);
  }
  return false;
}

export function validateXiaoweiTextInputConfig(config, knownAliases = new Set()) {
  if (config === undefined) return;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Xiaowei text input config must be an object");
  }
  validateXiaoweiEndpoint(config.endpoint);
  const input = config.textInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Xiaowei text input settings must be an object");
  }
  const aliases = Array.isArray(input.approvedAliases) ? input.approvedAliases : [];
  const services = Array.isArray(input.preferredImeServices) ? input.preferredImeServices : [];
  const perDevice = input.perDevice ?? {};
  if (aliases.some((alias) => !SAFE_ALIAS.test(String(alias)) || !knownAliases.has(alias)) || new Set(aliases).size !== aliases.length) {
    throw new Error("Xiaowei text input aliases must be unique mapped aliases");
  }
  if (services.some((service) => !approvedBridgeService(service)) || new Set(services).size !== services.length) {
    throw new Error("Xiaowei text input services must be unique approved bridge IMEs");
  }
  if (!perDevice || typeof perDevice !== "object" || Array.isArray(perDevice)) {
    throw new Error("Xiaowei per-device text input profiles must be an object");
  }
  for (const [alias, profile] of Object.entries(perDevice)) {
    if (!aliases.includes(alias) || !profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("Xiaowei per-device text input profile is invalid");
    }
    if (!approvedBridgeService(profile.preferredImeService) || !services.includes(profile.preferredImeService)) {
      throw new Error("Xiaowei per-device preferred IME must be an approved bridge service");
    }
    if (typeof profile.allowTemporaryEnable !== "boolean") {
      throw new Error("Xiaowei per-device temporary IME enable approval must be boolean");
    }
    if (!ECHO_VERIFICATION_MODES.has(profile.echoVerification)) {
      throw new Error("Xiaowei per-device echo verification must be ui_text or local_ocr");
    }
  }
  if (input.enabled === true && (input.humanApproved !== true || aliases.length === 0 || services.length === 0)) {
    throw new Error("Enabled Xiaowei text input requires human approval, aliases, and bridge IME services");
  }
  if (input.enabled === true && aliases.some((alias) => !Object.hasOwn(perDevice, alias))) {
    throw new Error("Enabled Xiaowei text input requires one explicit profile per approved device alias");
  }
  if (input.enabled === true && !hasTextActionGate(config.api, aliases)) {
    throw new Error("Enabled Xiaowei text input requires the exact Xiaowei version and accepted imeList/selectIme/inputText actions");
  }
}

export function createXiaoweiTextInputAdapter(config, options = {}) {
  if (!hasTextActionGate(config.api, config.approvedAliases ?? [])) {
    throw new Error("Xiaowei text input action gate is not accepted for this exact version");
  }
  const records = new Map((config.devices ?? []).map((device) => [device.alias, device]));
  const approvedAliases = new Set(config.approvedAliases ?? []);
  const preferredImeServices = [...(config.preferredImeServices ?? [])];
  const perDevice = config.perDevice ?? {};
  for (const alias of approvedAliases) {
    const profile = perDevice[alias];
    if (!profile || !approvedBridgeService(profile.preferredImeService)
        || !preferredImeServices.includes(profile.preferredImeService)
        || typeof profile.allowTemporaryEnable !== "boolean"
        || !ECHO_VERIFICATION_MODES.has(profile.echoVerification)) {
      throw new Error("Xiaowei text input requires a complete approved per-device profile");
    }
    if (config.api.acceptedDeviceSerialsByAlias?.[alias] !== records.get(alias)?.serial) {
      throw new Error("Xiaowei text input acceptance is not bound to this physical device");
    }
  }
  const expectedOnlineSerials = [...new Set(config.expectedOnlineSerials ?? [])].map(String).sort();
  if (expectedOnlineSerials.length === 0) {
    throw new Error("Xiaowei text input requires the independently inventoried online device set");
  }
  const client = options.client ?? createXiaoweiClient({
    endpoint: config.endpoint,
    acceptedActions: config.api.acceptedActions,
  }, { sendRequest: options.sendRequest });
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const expectedPackage = typeof config.expectedPackage === "string" && SAFE_PACKAGE.test(config.expectedPackage)
    ? config.expectedPackage
    : null;

  async function verifyIdentity(deviceAlias) {
    const record = records.get(deviceAlias);
    if (!record || !approvedAliases.has(deviceAlias) || !expectedOnlineSerials.includes(record.serial)) {
      const error = new Error("Selected Xiaowei and ADB device identities differ");
      error.code = "XIAOWEI_IDENTITY_MISMATCH";
      throw error;
    }
    const probe = await client.probe();
    const currentApiIds = apiDeviceIds(probe.data);
    if (!currentApiIds.includes(record.serial)) {
      const error = new Error("Selected Xiaowei and ADB device identities differ");
      error.code = "XIAOWEI_IDENTITY_MISMATCH";
      throw error;
    }
    return true;
  }

  const xiaoweiTextInput = async function xiaoweiTextInput({ deviceAlias, text, verifyFocusedEditor, verifyCleared }) {
    const record = records.get(deviceAlias);
    if (!record || !approvedAliases.has(deviceAlias)) throw new Error("Xiaowei text input is not approved for this device alias");
    const profile = perDevice[deviceAlias];
    if (!profile || !approvedBridgeService(profile.preferredImeService) || !preferredImeServices.includes(profile.preferredImeService)) {
      throw new Error("Xiaowei text input requires an explicit approved profile for this device alias");
    }
    if (typeof verifyFocusedEditor !== "function" || typeof verifyCleared !== "function") {
      throw new Error("Xiaowei text input requires focused-editor and cleared-editor verification callbacks");
    }
    const value = String(text ?? "");
    if (!value || [...value].length > 256 || /[\u0000\r\n]/u.test(value)) {
      throw new Error("Xiaowei text input requires a bounded single-line value");
    }
    const audit = {
      adapter: "xiaowei_api",
      apiIdentityVerified: false,
      bridgeSelectionVerified: false,
      focusedEditorVerified: false,
      clearVerified: false,
      apiAccepted: false,
      echoVerified: false,
      restoreAttempted: false,
      restoreVerified: false,
    };

    try {
      await verifyFocusedEditor();
      audit.focusedEditorVerified = true;
    } catch (error) {
      throw stagedInputFailure(error, audit, "focus", "FOCUS_VERIFICATION_FAILED", "Xiaowei input stopped because the editor focus could not be verified");
    }

    try {
      await verifyIdentity(deviceAlias);
      audit.apiIdentityVerified = true;
    } catch (error) {
      throw stagedInputFailure(error, audit, "identity", "IDENTITY_MISMATCH", "Xiaowei input stopped because API and ADB device identities could not be verified");
    }

    if (expectedPackage) {
      try {
        if (!await expectedPackageIsFocused(commandRunner, config, record, expectedPackage)) {
          throw new Error("The expected application was not focused");
        }
      } catch (error) {
        throw stagedInputFailure(error, audit, "app_focus", "APP_FOCUS_MISMATCH", "Xiaowei input stopped because the expected application focus could not be verified");
      }
    }

    let priorIme;
    try {
      priorIme = await commandRunner(config.adbPath, record.serial, ["shell", "settings", "get", "secure", "default_input_method"]);
      if (!SAFE_IME_SERVICE.test(priorIme)) throw new Error("The current default input method was invalid");
    } catch (error) {
      throw stagedInputFailure(error, audit, "current_ime", "CURRENT_IME_INVALID", "Xiaowei input stopped because the current input method could not be read");
    }
    const profileAuthorization = (capability) => ({
      mode: "approved_device_profile",
      capability,
      deviceAlias,
    });
    const bridgeIme = profile.preferredImeService;
    const deferClearVerification = profile.echoVerification === "local_ocr";
    try {
      const inventory = await client.invoke("imeList", { devices: record.serial });
      const installed = Array.isArray(inventory.data?.[record.serial]) ? inventory.data[record.serial] : [];
      if (!installed.includes(bridgeIme)) throw new Error("The approved bridge input method was absent from the device inventory");
    } catch (error) {
      throw stagedInputFailure(error, audit, "ime_list", "BRIDGE_IME_MISSING", "Xiaowei input stopped because the approved bridge input method could not be verified");
    }

    let stage = "enable_bridge";
    let bridgeEnabledByAdapter = false;
    const restoreInputState = async () => {
      audit.restoreAttempted = true;
      await client.invoke("selectIme", { devices: record.serial, data: { ime: priorIme } }, {
        authorization: profileAuthorization("selectIme"),
      });
      if (!await waitForDefaultIme(commandRunner, sleep, config, record, priorIme)) {
        throw new Error("Default input method restoration could not be verified");
      }
      if (bridgeEnabledByAdapter) {
        await commandRunner(config.adbPath, record.serial, ["shell", "ime", "disable", bridgeIme]);
        const enabledAfterRestore = await enabledImeServices(commandRunner, config, record);
        if (enabledAfterRestore.has(bridgeIme)) throw new Error("Bridge input method enabled state could not be restored");
      }
      audit.restoreVerified = true;
    };
    try {
      const enabledBeforeSelection = await enabledImeServices(commandRunner, config, record);
      if (!enabledBeforeSelection.has(bridgeIme)) {
        if (profile.allowTemporaryEnable !== true) {
          throw new Error("The approved bridge input method is installed but not enabled for this device profile");
        }
        bridgeEnabledByAdapter = true;
        await commandRunner(config.adbPath, record.serial, ["shell", "ime", "enable", bridgeIme]);
        const enabledAfterSelection = await enabledImeServices(commandRunner, config, record);
        if (!enabledAfterSelection.has(bridgeIme)) throw new Error("The approved bridge input method could not be enabled");
      }
      stage = "select_ime";
      await client.invoke("selectIme", { devices: record.serial, data: { ime: bridgeIme } }, {
        authorization: profileAuthorization("selectIme"),
      });
      if (!await waitForDefaultIme(commandRunner, sleep, config, record, bridgeIme)) {
        throw new Error("Xiaowei bridge input method selection could not be verified");
      }
      audit.bridgeSelectionVerified = true;
      stage = "ime_ready";
      if (!await waitForInputMethodBinding(commandRunner, sleep, config, record, bridgeIme)) {
        throw new Error("Xiaowei bridge input method binding could not be verified");
      }
      await sleep(bridgeEnabledByAdapter ? 750 : 300);
      await verifyFocusedEditor();
      // Clear by bounded backward deletion after the bridge IME is active.
      // This avoids relying on Ctrl+A, which does not select all on some MIUI
      // search editors and previously caused stale text to be appended.
      await commandRunner(config.adbPath, record.serial, [
        "shell", "input", "keyevent", "KEYCODE_MOVE_END", ...Array(256).fill("KEYCODE_DEL"),
      ]);
      await commandRunner(config.adbPath, record.serial, [
        "shell", "input", "keyevent", "KEYCODE_MOVE_HOME", ...Array(256).fill("KEYCODE_FORWARD_DEL"),
      ]);
      await sleep(150);
      stage = "clear";
      if (!deferClearVerification) {
        await verifyCleared();
        audit.clearVerified = true;
      }
      stage = "input_text";
      await client.invoke("inputText", { devices: record.serial, data: { content: value } }, {
        authorization: profileAuthorization("inputText"),
      });
      audit.apiAccepted = true;
      if (deferClearVerification) {
        // This build hides the real EditText value from UI automation. Move
        // the caret away from the first glyph before local OCR so a blinking
        // caret cannot change that glyph's recognition.
        await commandRunner(config.adbPath, record.serial, ["shell", "input", "keyevent", "KEYCODE_MOVE_END"]);
        await sleep(150);
      }
    } catch (error) {
      try {
        await restoreInputState();
      } catch (restoreError) {
        throw restorationFailure(restoreError, audit);
      }
      const stageDetails = stage === "select_ime"
        ? ["select_ime", "SELECT_IME_UNVERIFIED", "Xiaowei input stopped because the bridge input method could not be selected"]
        : stage === "ime_ready"
          ? ["ime_ready", "IME_BINDING_UNVERIFIED", "Xiaowei input stopped because the bridge input method was not bound to the focused editor"]
        : stage === "enable_bridge"
          ? ["ime_enable", "BRIDGE_IME_ENABLE_FAILED", "Xiaowei input stopped because the bridge input method could not be temporarily enabled"]
        : stage === "clear"
          ? ["clear", "CLEAR_UNVERIFIED", "Xiaowei input stopped because the editor could not be verified empty"]
          : ["input_text", "INPUT_TEXT_FAILED", "Xiaowei input stopped because inputText was not accepted"];
      throw stagedInputFailure(error, audit, ...stageDetails);
    }

    let restored = false;
    return {
      audit,
      async restore() {
        if (restored) return;
        audit.restoreAttempted = true;
        try {
          await restoreInputState();
          restored = true;
        } catch (error) {
          throw restorationFailure(error, audit);
        }
      },
    };
  };

  xiaoweiTextInput.verifyIdentity = verifyIdentity;
  return xiaoweiTextInput;
}
