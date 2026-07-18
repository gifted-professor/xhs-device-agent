import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeXiaoweiResponse, sendXiaoweiRequest } from "./xiaowei-transport.mjs";
import { invokeXiaoweiPrivateCommand } from "./xiaowei-private-api.mjs";
import { createWindowsLocalOcr } from "./local-ocr.mjs";
import { requestCloudVision } from "./cloud-vision.mjs";
import {
  DeviceNodeError,
  inferHorizontalOrdinalBounds,
  parseVisionNodeResponse,
  publicNodeDescription,
  stableNodeBounds,
  validateDeviceNodeSelector,
} from "./device-node-engine.mjs";
import { createNormalizedFingerprint, loadRules, parseUiAutomatorXml } from "./xhs-page-engine.mjs";
import { intersectXhsObservations, observeXhsHierarchy, resolveVisibleXhsNote } from "./xhs-public-observation.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const SAFE_MACHINE = /^\d{2}$/u;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
const SAFE_IME_SERVICE = /^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$/u;
const XHS_PACKAGE = "com.xingin.xhs";
const XHS_FIND_VIDEO_DEFAULT_MAX_SCROLLS = 3;
const XHS_FIND_VIDEO_DEFAULT_MAX_DURATION_MS = 28_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains an unsupported field: ${unknown[0]}`);
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateTarget(target) {
  if (!plainObject(target) || !SAFE_MACHINE.test(String(target.machine ?? ""))
      || !SAFE_ALIAS.test(String(target.alias ?? ""))
      || typeof target.name !== "string" || !target.name.trim() || target.name.length > 80
      || /[\u0000-\u001f\u007f]/u.test(target.name)
      || typeof target.serial !== "string" || !target.serial || target.serial.length > 256
      || /[\u0000-\u001f\u007f]/u.test(target.serial)
      || target.serial === target.alias) {
    throw new Error("Xiaowei device-read target is invalid");
  }
  const acceptedSerial = target.acceptedSerial === undefined ? target.serial
    : typeof target.acceptedSerial === "string" && target.acceptedSerial
      && target.acceptedSerial.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(target.acceptedSerial)
      ? target.acceptedSerial : null;
  return {
    machine: target.machine,
    name: target.name,
    alias: target.alias,
    serial: target.serial,
    acceptedSerial,
  };
}

function privateDeviceRecords(value) {
  let normalized = value;
  if (typeof normalized === "string") {
    if (!normalized || Buffer.byteLength(normalized, "utf8") > 1024 * 1024) {
      throw new Error("Xiaowei device list is empty or too large");
    }
    try { normalized = JSON.parse(normalized); } catch { throw new Error("Xiaowei device list is not valid JSON"); }
  }
  const records = Array.isArray(normalized) ? normalized
    : plainObject(normalized) && Array.isArray(normalized.data) ? normalized.data : null;
  if (!records) throw new Error("Xiaowei device list did not contain one device array");
  return records;
}

function exactRecordSerial(record) {
  if (!plainObject(record)) return null;
  const values = [record.serial, record.onlySerial]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => typeof value === "string" ? value : null);
  if (!values.length || values.some((value) => !value || value.length > 256
      || /[\u0000-\u001f\u007f]/u.test(value))) return null;
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

export function buildPublicDeviceList(value, rawTargets) {
  if (!Array.isArray(rawTargets) || !rawTargets.length) {
    throw new Error("Xiaowei device list requires the configured machine directory");
  }
  const targets = rawTargets.map(validateTarget);
  if (new Set(targets.map((target) => target.machine)).size !== targets.length
      || new Set(targets.map((target) => target.alias)).size !== targets.length
      || new Set(targets.map((target) => target.serial)).size !== targets.length) {
    throw new Error("Xiaowei device list machine bindings must be unique");
  }
  const counts = new Map();
  for (const record of privateDeviceRecords(value)) {
    const serial = exactRecordSerial(record);
    if (serial) counts.set(serial, (counts.get(serial) ?? 0) + 1);
  }
  const acceptedCounts = new Map();
  for (const target of targets) {
    if (typeof target.acceptedSerial === "string") {
      acceptedCounts.set(target.acceptedSerial, (acceptedCounts.get(target.acceptedSerial) ?? 0) + 1);
    }
  }
  return targets
    .map((target) => ({
      machine: target.machine,
      name: target.name,
      online: target.acceptedSerial === target.serial
        && acceptedCounts.get(target.serial) === 1
        && counts.get(target.serial) === 1,
      transport: "xiaowei-private-api",
      localAdbRequired: false,
    }))
    .sort((left, right) => left.machine.localeCompare(right.machine));
}

export function parsePrivateSize(value) {
  if (typeof value !== "string") throw new Error("Xiaowei get_size did not return one size string");
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(value);
  if (!match) throw new Error("Xiaowei get_size returned an invalid size");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error("Xiaowei get_size returned out-of-range dimensions");
  }
  return { width, height };
}

export function extractSingleDeviceValue(data) {
  if (typeof data === "string") return data;
  if (!plainObject(data)) throw new Error("Xiaowei device response did not contain device data");
  const values = Object.values(data);
  if (values.length !== 1 || typeof values[0] !== "string") {
    throw new Error("Xiaowei device response was not a single text result");
  }
  return values[0];
}

export function extractUiHierarchy(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Xiaowei UI hierarchy is missing or too large");
  }
  const hierarchyStart = value.indexOf("<hierarchy");
  const hierarchyEnd = value.indexOf("</hierarchy>", hierarchyStart);
  if (hierarchyStart < 0 || hierarchyEnd < hierarchyStart) {
    const error = new Error([
      "Xiaowei UI response did not contain a complete hierarchy",
      `bytes=${Buffer.byteLength(value, "utf8")}`,
      `hasStart=${hierarchyStart >= 0}`,
      `hasEnd=${value.includes("</hierarchy>")}`,
      `sha256=${createHash("sha256").update(value).digest("hex")}`,
    ].join("; "));
    error.code = "UI_HIERARCHY_INCOMPLETE";
    throw error;
  }
  const declaration = value.lastIndexOf("<?xml", hierarchyStart);
  const start = declaration >= 0 ? declaration : hierarchyStart;
  return `${value.slice(start, hierarchyEnd + "</hierarchy>".length).trim()}\n`;
}

export function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_ARTIFACT_BYTES
      || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Xiaowei screenshot is not a valid PNG artifact");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error("Xiaowei screenshot dimensions are invalid");
  }
  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) throw new Error("Xiaowei screenshot contains a truncated PNG chunk");
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || chunkEnd !== buffer.length) throw new Error("Xiaowei screenshot has an invalid PNG ending");
      sawIend = true;
      break;
    }
    offset = chunkEnd;
  }
  if (!sawIdat || !sawIend) throw new Error("Xiaowei screenshot is missing required PNG chunks");
  return { width, height, bytes: buffer.length };
}

async function invokeOfficial(action, target, data, options, timeoutMs = options.timeoutMs) {
  let raw;
  try {
    raw = await options.sendRequest({ action, devices: target.serial, data }, {
      endpoint: options.endpoint,
      timeoutMs,
      maxResponseBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "TRANSPORT_FAILED";
    throw new Error(`Xiaowei ${action} transport failed (${code})`);
  }
  const response = normalizeXiaoweiResponse(raw);
  if (!response.ok) throw new Error(`Xiaowei ${action} returned vendor code ${response.code}`);
  return response.data;
}

async function writeAtomic(filePath, content, options = {}) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const expected = Buffer.from(content, "utf8");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(expected);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filePath);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const [metadata, actual] = await Promise.all([stat(filePath), readFile(filePath)]);
        if (metadata.isFile() && metadata.size === expected.length && actual.equals(expected)) {
          return {
            bytes: actual.length,
            sha256: createHash("sha256").update(actual).digest("hex"),
            persistenceVerification: "fsync_rename_readback_exact",
          };
        }
      } catch {}
      if (attempt < 5) await (options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(100);
    }
    throw new Error("Xiaowei UI artifact did not remain byte-identical after atomic persistence");
  } finally {
    try { await handle?.close(); } catch {}
    await rm(temporary, { force: true });
  }
}

async function readUi(target, deviceDirectory, options) {
  const hierarchy = await readUiHierarchy(target, options);
  const hierarchyPath = path.join(deviceDirectory, "window.xml");
  const persisted = await writeAtomic(hierarchyPath, hierarchy, options);
  return {
    hierarchyPath,
    ...persisted,
    verification: "complete_xml_artifact",
  };
}

async function readUiHierarchy(target, options) {
  try {
    const data = await invokeOfficial(
      "adb_shell", target, { command: "uiautomator dump /dev/tty" }, options, options.uiDirectTimeoutMs,
    );
    return extractUiHierarchy(extractSingleDeviceValue(data));
  } catch (error) {
    return readUiHierarchyFromFile(target, options, error);
  }
}

async function readUiHierarchyFromFile(target, options, ttyError) {
  const nonce = randomUUID().replaceAll("-", "");
  const remotePath = `/sdcard/xhs-agent-ui-${nonce}.xml`;
  const localPath = path.join(options.uiScratchDirectory, `uiautomator-${nonce}.xml`);
  let remoteCreated = false;
  try {
    await invokeOfficial("adb_shell", target, { command: `uiautomator dump --compressed ${remotePath}` }, options);
    remoteCreated = true;
    let remoteBytes = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const sizeData = await invokeOfficial("adb_shell", target, {
        command: `if [ -s ${remotePath} ]; then wc -c < ${remotePath}; else echo 0; fi`,
      }, options);
      const matches = extractSingleDeviceValue(sizeData).match(/(?:^|\n)\s*(\d+)\s*(?=\n|$)/gu) ?? [];
      remoteBytes = Number(matches.at(-1)?.trim() ?? 0);
      if (Number.isSafeInteger(remoteBytes) && remoteBytes > 0 && remoteBytes <= 4 * 1024 * 1024) break;
      if (attempt < 11) await options.delay(250);
    }
    if (!Number.isSafeInteger(remoteBytes) || remoteBytes < 1 || remoteBytes > 4 * 1024 * 1024) {
      throw new Error("device-side UI dump did not produce a bounded XML artifact");
    }
    await rm(localPath, { force: true });
    await invokeOfficial("pullFile", target, { filePath: remotePath, savePath: localPath }, options);
    let previousSize = -1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const metadata = await stat(localPath);
        if (metadata.isFile() && metadata.size === remoteBytes && metadata.size === previousSize) break;
        previousSize = metadata.size;
      } catch {}
      if (attempt === 11) throw new Error("pulled UI dump did not become a stable local artifact");
      await options.delay(100);
    }
    return extractUiHierarchy(await readFile(localPath, "utf8"));
  } catch (error) {
    throw new Error(`${ttyError.message}; device-file fallback failed: ${error.message}`);
  } finally {
    await rm(localPath, { force: true });
    if (remoteCreated) {
      try { await invokeOfficial("adb_shell", target, { command: `rm -f ${remotePath}` }, options); } catch {}
    }
  }
}

function collectPackageNames(value, packages = new Set()) {
  if (typeof value === "string") {
    if (SAFE_PACKAGE.test(value)) packages.add(value);
    return packages;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectPackageNames(entry, packages);
    return packages;
  }
  if (plainObject(value)) {
    for (const entry of Object.values(value)) collectPackageNames(entry, packages);
  }
  return packages;
}

export function installedPackageNames(value) {
  return [...collectPackageNames(value)].sort((left, right) => left.localeCompare(right));
}

export function packageInventoryContains(value, packageName) {
  return SAFE_PACKAGE.test(packageName) && collectPackageNames(value).has(packageName);
}

export function hierarchyContainsPackage(hierarchy, packageName) {
  if (typeof hierarchy !== "string" || !SAFE_PACKAGE.test(packageName)) return false;
  return hierarchy.includes(`package="${packageName}"`);
}

function parseBounds(value) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(String(value ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function semanticValue(value) {
  return String(value ?? "").normalize("NFKC").trim();
}

function actionableAncestor(document, node) {
  let current = node;
  for (let depth = 0; current && depth <= 8; depth += 1) {
    const bounds = parseBounds(current.attributes?.bounds);
    if (bounds && current.enabled !== false && current.clickable) return { node: current, bounds };
    current = current.parentIndex === null ? null : document.nodes[current.parentIndex];
  }
  const bounds = parseBounds(node.attributes?.bounds);
  return bounds ? { node, bounds } : null;
}

export function findSemanticTapPoint(hierarchy, label, displaySize, {
  packageName, match = "exact", ordinal,
} = {}) {
  const document = parseUiAutomatorXml(hierarchy);
  const expected = semanticValue(label);
  if (!["exact", "suffix"].includes(match)
      || (ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 50))) {
    throw new Error("Semantic text target options are invalid");
  }
  const matchesLabel = (value) => {
    const actual = semanticValue(value);
    if (match === "exact") return actual === expected;
    if (actual.endsWith(expected)) return true;
    // XHS translatable comments pack the reply action into one TextView that
    // ends with 翻译 instead of the bare label ("…回复 翻译"). Tolerate the
    // trailing translate chip so the reply target stays resolvable.
    return actual.replace(/\s*翻译\s*$/u, "").endsWith(expected);
  };
  const candidates = document.nodes
    .filter((node) => (packageName === undefined || node.packageName === packageName)
      && (matchesLabel(node.text) || matchesLabel(node.contentDesc)))
    .map((node) => actionableAncestor(document, node))
    .filter(Boolean);
  if (!candidates.length) throw new Error(`Control ${expected} was not found in the fresh UI hierarchy`);
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [
    `${candidate.bounds.left},${candidate.bounds.top},${candidate.bounds.right},${candidate.bounds.bottom}`, candidate,
  ])).values()];
  if (ordinal === undefined && packageName !== undefined && uniqueCandidates.length !== 1) {
    throw new DeviceNodeError("NODE_AMBIGUOUS", `Control ${expected} was not unique in the expected foreground package`);
  }
  const allBounds = document.nodes.map((node) => parseBounds(node.attributes?.bounds)).filter(Boolean);
  const width = displaySize?.width ?? Math.max(0, ...allBounds.map((bounds) => bounds.right));
  const height = displaySize?.height ?? Math.max(0, ...allBounds.map((bounds) => bounds.bottom));
  if (!width || !height) throw new Error("Fresh UI hierarchy did not expose valid display bounds");
  uniqueCandidates.sort((left, right) => ordinal === undefined
    ? (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height)
      || right.bounds.top - left.bounds.top
      || left.bounds.left - right.bounds.left
    : left.bounds.top - right.bounds.top
      || left.bounds.left - right.bounds.left
      || (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height));
  if (ordinal !== undefined && ordinal > uniqueCandidates.length) {
    throw new Error(`Control ${expected} ordinal ${ordinal} was not visible in the fresh UI hierarchy`);
  }
  const bounds = uniqueCandidates[(ordinal ?? 1) - 1].bounds;
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error("Semantic target bounds fall outside the verified physical display");
  }
  const decimal = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
  return { x: decimal((x / width) * 100), y: decimal((y / height) * 100) };
}

function extractPhysicalDisplaySize(value) {
  const matches = [...String(value ?? "").matchAll(/(?:Physical|Override)\s+size:\s*(\d+)x(\d+)/giu)];
  const match = matches.at(-1);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 16_384 || height > 16_384) {
    throw new Error("Xiaowei could not read the selected machine's physical display size");
  }
  return { width, height };
}

async function readPhysicalDisplaySize(target, options) {
  const data = await invokeOfficial("adb_shell", target, { command: "wm size" }, options);
  return extractPhysicalDisplaySize(extractSingleDeviceValue(data));
}

function hierarchyMatchesPostcondition(hierarchy, postcondition) {
  const document = parseUiAutomatorXml(hierarchy);
  if (postcondition.kind === "package") {
    return document.nodes.some((node) => node.packageName === postcondition.value);
  }
  if (postcondition.kind === "resource-id") {
    return document.nodes.some((node) => node.resourceId === postcondition.value);
  }
  return document.nodes.some((node) =>
    semanticValue(node.text) === semanticValue(postcondition.value)
    || semanticValue(node.contentDesc) === semanticValue(postcondition.value));
}

async function tapText(target, request, deviceDirectory, options) {
  const before = await readUiHierarchy(target, options);
  if (request.package !== undefined && !hierarchyContainsPackage(before, request.package)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "device.tap-text expected foreground package was not verified");
  }
  const beforePath = path.join(deviceDirectory, "tap-before.xml");
  const beforePersistence = await writeAtomic(beforePath, before, options);
  const displaySize = await readPhysicalDisplaySize(target, options);
  const point = findSemanticTapPoint(before, request.text, displaySize, {
    packageName: request.package, match: request.match, ordinal: request.ordinal,
  });
  await invokeOfficial("pointerEvent", target, { type: "10", x: point.x, y: point.y }, options);

  let after = "";
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (request.postcondition.kind === "package") {
      verified = await readFocusedPackage(target, options) === request.postcondition.value;
    } else {
      after = await readUiHierarchy(target, options);
      verified = hierarchyMatchesPostcondition(after, request.postcondition);
    }
    if (verified) {
      verified = true;
      break;
    }
    if (attempt < 5) await options.delay(400);
  }
  if (!verified) {
    throw new Error("Tap was sent once but the approved postcondition was not verified; the tap will not be replayed");
  }
  if (request.postcondition.kind === "package") {
    return {
      executionOutcome: "accepted",
      verificationOutcome: "verified",
      beforeHierarchyPath: beforePath,
      beforeBytes: beforePersistence.bytes,
      beforeSha256: beforePersistence.sha256,
      persistenceVerification: beforePersistence.persistenceVerification,
      verification: "fresh_ui_target_then_single_pointer_event_then_foreground_package",
    };
  }
  const afterPath = path.join(deviceDirectory, "tap-after.xml");
  const afterPersistence = await writeAtomic(afterPath, after, options);
  return {
    executionOutcome: "accepted",
    verificationOutcome: "verified",
    beforeHierarchyPath: beforePath,
    beforeBytes: beforePersistence.bytes,
    beforeSha256: beforePersistence.sha256,
    hierarchyPath: afterPath,
    bytes: afterPersistence.bytes,
    sha256: afterPersistence.sha256,
    persistenceVerification: afterPersistence.persistenceVerification,
    verification: "fresh_ui_postcondition_after_single_pointer_event",
  };
}

function percentageCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a finite percentage from 0 through 100`);
  }
  return value.toFixed(6).replace(/\.?0+$/u, "");
}

async function tapCoordinates(target, request, options) {
  if (await readFocusedPackage(target, options) !== request.package) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "device.tap-coords source package was not verified");
  }
  await options.delay(100);
  if (await readFocusedPackage(target, options) !== request.package) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "device.tap-coords source package changed before the pointer event");
  }
  await invokeOfficial("pointerEvent", target, {
    type: "10",
    x: percentageCoordinate(request.x, "device.tap-coords x"),
    y: percentageCoordinate(request.y, "device.tap-coords y"),
  }, options);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const verified = request.postcondition.kind === "package"
        ? await readFocusedPackage(target, options) === request.postcondition.value
        : hierarchyMatchesPostcondition(await readUiHierarchy(target, options), request.postcondition);
      if (verified) {
        return {
          machine: target.machine,
          status: "verified",
          verification: "source_package_fast_rechecked_then_single_pointer_event_then_fresh_postcondition",
          transport: "xiaowei-api",
          localAdbRequired: false,
        };
      }
    } catch {
      // App transitions can briefly return an incomplete hierarchy.
    }
    if (attempt < 11) await options.delay(300);
  }
  throw new Error("device.tap-coords sent one pointer event but the fresh postcondition was not verified; the event will not be replayed");
}

async function waitForForegroundPackage(target, packageName, deviceDirectory, options, artifactName) {
  let hierarchy = "";
  let verified = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const current = await readUiHierarchy(target, options);
      hierarchy = current;
      if (hierarchyContainsPackage(current, packageName)) {
        verified = true;
        break;
      }
    } catch {
      // App transitions can briefly return a truncated or missing hierarchy.
      // Only a later complete hierarchy can verify the foreground package.
    }
    if (attempt < 4) await options.delay(400);
  }
  if (!hierarchy) {
    throw new Error(`Foreground package verification did not obtain a complete UI hierarchy for ${packageName}`);
  }
  const hierarchyPath = path.join(deviceDirectory, artifactName);
  await writeAtomic(hierarchyPath, hierarchy, options);
  if (!verified) {
    throw new Error(`Foreground package verification failed for approved package ${packageName}; the action will not be replayed`);
  }
  return {
    hierarchyPath,
    hierarchyBytes: Buffer.byteLength(hierarchy, "utf8"),
    verification: "foreground_package_in_fresh_ui",
  };
}

async function openApp(target, packageName, deviceDirectory, options) {
  const inventory = await invokeOfficial("apkList", target, undefined, options);
  if (!packageInventoryContains(inventory, packageName)) {
    throw new Error(`Approved package ${packageName} is not installed on the selected machine`);
  }
  await invokeOfficial("startApk", target, { apk: packageName }, options);
  const verification = await waitForForegroundPackage(
    target, packageName, deviceDirectory, options, "app-open-after.xml",
  );
  return {
    packageInstalled: true,
    executionOutcome: "accepted",
    verificationOutcome: "verified",
    ...verification,
  };
}

async function listApps(target, options) {
  const inventory = await invokeOfficial("apkList", target, undefined, options);
  const packages = installedPackageNames(inventory);
  if (!packages.length || packages.length > 20_000) {
    throw new Error("Xiaowei apkList returned no bounded package inventory");
  }
  return {
    machine: target.machine,
    packages,
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

function extractResolvedPackage(value) {
  const lines = String(value ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+$/u);
    if (match) return match[1];
  }
  throw new Error("Xiaowei could not resolve the selected machine's default HOME package");
}

async function goHome(target, deviceDirectory, options) {
  const resolved = await invokeOfficial("adb_shell", target, {
    command: "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
  }, options);
  const homePackage = extractResolvedPackage(extractSingleDeviceValue(resolved));
  await invokeOfficial("pushEvent", target, { type: "2" }, options);
  const verification = await waitForForegroundPackage(
    target, homePackage, deviceDirectory, options, "home-after.xml",
  );
  return {
    executionOutcome: "accepted",
    verificationOutcome: "verified",
    ...verification,
  };
}

async function goRecent(target, options) {
  const before = await readUiHierarchy(target, options);
  const beforeHash = createNormalizedFingerprint(before).hash;
  await invokeOfficial("pushEvent", target, { type: "1" }, options);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const after = await readUiHierarchy(target, options);
      if (createNormalizedFingerprint(after).hash !== beforeHash) {
        return {
          machine: target.machine,
          status: "verified",
          verification: "single_recent_event_then_fresh_ui_change",
          transport: "xiaowei-api",
          localAdbRequired: false,
        };
      }
    } catch {
      // The task switcher can briefly expose an incomplete hierarchy.
    }
    if (attempt < 11) await options.delay(300);
  }
  throw new Error("device.recent sent one task-switcher event but a fresh UI change was not verified; the event will not be replayed");
}

async function readFocusedWindow(target, options) {
  const output = await readAdbShellText(
    target,
    "dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'",
    options,
  );
  const lines = String(output).split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => /mCurrentFocus|mFocusedApp/u.test(line));
  if (!lines.length) throw new Error("Xiaowei could not read the focused window");
  return lines.join("\n");
}

async function goBack(target, options) {
  const beforeHash = await readScreenFingerprint(target, options);
  let beforeFocus = null;
  try {
    beforeFocus = await readFocusedWindow(target, options);
  } catch {
    // Focused-window lookup is best-effort; the fingerprint path still applies.
  }
  await invokeOfficial("pushEvent", target, { type: "3" }, options);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const afterHash = await readScreenFingerprint(target, options);
    if (afterHash !== beforeHash) {
      // Animated pages change pixels without any navigation. A real BACK moves
      // to a page that settles, or at least moves the focused window; pure
      // animation fails both checks and keeps polling.
      await options.delay(600);
      const settledHash = await readScreenFingerprint(target, options);
      if (settledHash === afterHash) {
        return {
          machine: target.machine,
          status: "verified",
          verification: "single_back_event_then_fresh_screen_change",
          transport: "xiaowei-api",
          localAdbRequired: false,
        };
      }
      if (beforeFocus !== null) {
        try {
          if (await readFocusedWindow(target, options) !== beforeFocus) {
            return {
              machine: target.machine,
              status: "verified",
              verification: "single_back_event_then_focused_window_change",
              transport: "xiaowei-api",
              localAdbRequired: false,
            };
          }
        } catch {
          // Keep polling while the focus reader is unavailable.
        }
      }
    }
    if (attempt < 7) await options.delay(300);
  }
  throw new DeviceNodeError("POSTCONDITION_MISS", "BACK was sent once but a fresh UI change was not verified; BACK will not be replayed");
}

function editorObservation(hierarchy, packageName, {
  expectedText, reference = null, requireFocused = true,
} = {}) {
  const document = parseUiAutomatorXml(hierarchy);
  const editors = document.nodes
    .filter((node) => node.packageName === packageName && /(?:^|\.)EditText$/u.test(node.className))
    .map((node) => ({ node, bounds: parseBounds(node.attributes?.bounds) }))
    .filter(({ node, bounds }) => bounds && (!requireFocused || node.focused === true)
      && (!reference || (node.className === reference.node.className
        && (!reference.node.resourceId || node.resourceId === reference.node.resourceId)
        && stableNodeBounds(bounds, reference.bounds))))
    .filter(({ node }) => expectedText === undefined || semanticValue(node.text) === semanticValue(expectedText));
  if (editors.length !== 1) return null;
  return editors[0];
}

function focusedEditor(hierarchy, packageName, expectedText) {
  return editorObservation(hierarchy, packageName, { expectedText })?.node ?? null;
}

function singleDeviceActionValue(data, action) {
  if (Array.isArray(data) || typeof data === "string") return data;
  if (!plainObject(data)) throw new Error(`Xiaowei ${action} returned invalid device data`);
  const values = Object.values(data);
  if (values.length !== 1) throw new Error(`Xiaowei ${action} did not return one device result`);
  return values[0];
}

function imeServiceFromOutput(value, label) {
  const services = String(value ?? "").split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => SAFE_IME_SERVICE.test(entry));
  if (!services.length) throw new Error(`Xiaowei could not read the ${label} input method`);
  return services.at(-1);
}

async function readAdbShellText(target, command, options) {
  return singleDeviceActionValue(await invokeOfficial("adb_shell", target, { command }, options), "adb_shell");
}

function focusedPackageFromOutput(value) {
  const lines = String(value ?? "").split(/\r?\n/u)
    .filter((line) => /mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity|ResumedActivity/u.test(line));
  for (const line of lines) {
    const match = /\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+/u.exec(line);
    if (match && SAFE_PACKAGE.test(match[1])) return match[1];
  }
  return null;
}

async function readFocusedPackage(target, options) {
  const probes = [
    "dumpsys activity activities | grep -m 1 -E 'topResumedActivity|mResumedActivity|ResumedActivity'",
    "dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp'",
  ];
  for (const command of probes) {
    try {
      const packageName = focusedPackageFromOutput(await readAdbShellText(target, command, options));
      if (packageName) return packageName;
    } catch {
      // Android versions expose different focus markers; use the next bounded probe.
    }
  }
  throw new Error("Xiaowei could not read one current foreground package");
}

async function readScreenFingerprint(target, options) {
  const output = await readAdbShellText(target, "screencap -p | sha256sum", options);
  const match = /(?:^|\s)([a-f0-9]{64})(?=\s|$)/iu.exec(String(output));
  if (!match) throw new Error("Xiaowei could not read a bounded screen fingerprint");
  return match[1].toLowerCase();
}

async function waitForIme(target, expectedIme, options, { binding = false } = {}) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const output = await readAdbShellText(
      target,
      binding ? "dumpsys input_method" : "settings get secure default_input_method",
      options,
    );
    if (binding ? String(output).includes(expectedIme) : imeServiceFromOutput(output, "default") === expectedIme) return true;
    if (attempt < 9) await options.delay(250);
  }
  return false;
}

async function waitForFocusedEditor(target, packageName, expectedText, options, reference = null, attempts = 8) {
  let hierarchy = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    hierarchy = await readUiHierarchy(target, options);
    if (editorObservation(hierarchy, packageName, { expectedText, reference })) return hierarchy;
    if (attempt < attempts - 1) await options.delay(250);
  }
  return hierarchy;
}

function percentagePoint(bounds, dimensions) {
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  const decimal = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
  return {
    x: decimal((x / dimensions.width) * 100),
    y: decimal((y / dimensions.height) * 100),
  };
}

async function restoreEditorFocus(target, packageName, reference, options, { reopenEditor } = {}) {
  const firstHierarchy = await readUiHierarchy(target, options);
  if (editorObservation(firstHierarchy, packageName, { reference })) return firstHierarchy;
  let previous = editorObservation(firstHierarchy, packageName, { requireFocused: false });
  let guardHierarchy = firstHierarchy;
  let guard = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await options.delay(300);
    guardHierarchy = await readUiHierarchy(target, options);
    guard = editorObservation(guardHierarchy, packageName, { requireFocused: false });
    if (previous && guard && previous.node.className === guard.node.className
        && previous.node.resourceId === guard.node.resourceId
        && stableNodeBounds(previous.bounds, guard.bounds)) break;
    previous = guard;
    guard = null;
  }
  if (!guard) {
    if (reopenEditor) {
      const recoveredHierarchy = await reopenEditor();
      if (editorObservation(recoveredHierarchy, packageName)) return recoveredHierarchy;
    }
    throw new Error("The input editor could not be safely re-resolved after input-method selection");
  }
  if (guard.node.focused === true) return guardHierarchy;
  const dimensions = await readPhysicalDisplaySize(target, options);
  await invokeOfficial("pointerEvent", target, { type: "10", ...percentagePoint(guard.bounds, dimensions) }, options);
  const refocused = await waitForFocusedEditor(target, packageName, undefined, options, guard, 24);
  if (!editorObservation(refocused, packageName, { reference: guard })) {
    throw new Error("The input editor was tapped once but focus was not restored; the tap will not be replayed");
  }
  return refocused;
}

async function inputDeviceText(target, request, deviceDirectory, options, { reopenEditor } = {}) {
  const before = await readUiHierarchy(target, options);
  let initialEditor = editorObservation(before, request.package);
  if (!initialEditor) {
    const unfocusedEditor = editorObservation(before, request.package, { requireFocused: false });
    if (unfocusedEditor) {
      const focusedHierarchy = await restoreEditorFocus(target, request.package, unfocusedEditor, options);
      initialEditor = editorObservation(focusedHierarchy, request.package);
    }
  }
  if (!initialEditor) {
    throw new Error("device.input requires exactly one resolvable EditText in the expected foreground package");
  }
  await writeAtomic(path.join(deviceDirectory, "input-before.xml"), before, options);

  const priorIme = imeServiceFromOutput(
    await readAdbShellText(target, "settings get secure default_input_method", options),
    "current",
  );
  const installedRaw = singleDeviceActionValue(await invokeOfficial("imeList", target, undefined, options), "imeList");
  const installed = Array.isArray(installedRaw) ? installedRaw.map(String) : [];
  if (!installed.includes(request.imeService)) {
    throw new Error("The approved bridge input method is not installed on the selected machine");
  }
  const enabledRaw = await readAdbShellText(target, "ime list -s", options);
  const enabled = new Set(String(enabledRaw).split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => SAFE_IME_SERVICE.test(entry)));
  let enabledByAdapter = false;
  let operationError = null;
  let verification = null;

  try {
    if (!enabled.has(request.imeService)) {
      if (!request.allowTemporaryEnable) {
        throw new Error("The approved bridge input method is installed but not enabled");
      }
      await readAdbShellText(target, `ime enable ${request.imeService}`, options);
      const afterEnable = String(await readAdbShellText(target, "ime list -s", options));
      if (!afterEnable.split(/\r?\n/u).map((entry) => entry.trim()).includes(request.imeService)) {
        throw new Error("The approved bridge input method could not be enabled");
      }
      enabledByAdapter = true;
    }

    await invokeOfficial("selectIme", target, { ime: request.imeService }, options);
    if (!await waitForIme(target, request.imeService, options)
        || !await waitForIme(target, request.imeService, options, { binding: true })) {
      throw new Error("The approved bridge input method could not be selected and bound");
    }
    const activeHierarchy = await restoreEditorFocus(target, request.package, initialEditor, options, { reopenEditor });
    const activeEditor = editorObservation(activeHierarchy, request.package);
    if (!activeEditor) throw new Error("The input editor was not uniquely focused after input-method selection");

    const backwardDeletes = Array(256).fill("KEYCODE_DEL").join(" ");
    const forwardDeletes = Array(256).fill("KEYCODE_FORWARD_DEL").join(" ");
    await readAdbShellText(target, `input keyevent KEYCODE_MOVE_END ${backwardDeletes}`, options);
    await readAdbShellText(target, `input keyevent KEYCODE_MOVE_HOME ${forwardDeletes}`, options);
    if (request.echoVerification === "ui_text") {
      const semanticEmpty = request.semanticEmpty === "xhs-comment";
      const cleared = await waitForFocusedEditor(
        target, request.package, semanticEmpty ? undefined : "", options, activeEditor,
      );
      const clearedEditor = editorObservation(cleared, request.package, { reference: activeEditor });
      if (!clearedEditor || (semanticEmpty ? !xhsEditorIsEmpty(clearedEditor)
        : semanticValue(clearedEditor.node.text) !== "")) {
        throw new Error("The focused editor could not be verified empty");
      }
    }

    await invokeOfficial("inputText", target, { content: request.text }, options);
    if (request.echoVerification === "ui_text") {
      const after = await waitForFocusedEditor(target, request.package, request.text, options, activeEditor);
      if (!editorObservation(after, request.package, { expectedText: request.text, reference: activeEditor })) {
        throw new Error("device.input was accepted once but exact focused-editor echo was not verified");
      }
      await writeAtomic(path.join(deviceDirectory, "input-after.xml"), after, options);
      verification = "exact_focused_editor_ui_echo_after_ime_restore";
    } else {
      const exactUi = await waitForFocusedEditor(target, request.package, request.text, options, activeEditor);
      if (editorObservation(exactUi, request.package, { expectedText: request.text, reference: activeEditor })) {
        await writeAtomic(path.join(deviceDirectory, "input-after.xml"), exactUi, options);
        verification = "exact_focused_editor_ui_echo_after_ime_restore";
      } else {
        const afterHierarchy = await waitForFocusedEditor(target, request.package, undefined, options, activeEditor);
        if (!editorObservation(afterHierarchy, request.package, { reference: activeEditor })) {
          throw new Error("The focused editor was lost after device.input");
        }
        const screen = await readScreen(target, deviceDirectory, options, "input-after.png");
        await locateText(options, screen.screenshotPath, request.text, "input echo", screen, { requireStable: true });
        verification = "exact_local_ocr_echo_after_ime_restore";
      }
    }
  } catch (error) {
    operationError = error;
  }

  const restorationErrors = [];
  try {
    await invokeOfficial("selectIme", target, { ime: priorIme }, options);
    if (!await waitForIme(target, priorIme, options)) throw new Error("The prior input method could not be restored");
  } catch (error) {
    restorationErrors.push(error.message);
  }
  if (enabledByAdapter) {
    try {
      await readAdbShellText(target, `ime disable ${request.imeService}`, options);
      const afterDisable = String(await readAdbShellText(target, "ime list -s", options));
      if (afterDisable.split(/\r?\n/u).map((entry) => entry.trim()).includes(request.imeService)) {
        throw new Error("The bridge input method enabled state could not be restored");
      }
    } catch (error) {
      restorationErrors.push(error.message);
    }
  }
  if (restorationErrors.length) {
    throw new Error(`device.input stopped because input-method restoration failed: ${restorationErrors.join("; ")}`);
  }
  if (operationError) throw operationError;
  return {
    machine: target.machine,
    status: "verified",
    verification,
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function waitForRemoteScreenshot(target, remotePath, options) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await invokeOfficial("adb_shell", target, {
      command: `if [ -s ${remotePath} ]; then wc -c < ${remotePath}; else echo 0; fi`,
    }, options);
    let size = 0;
    try {
      const matches = extractSingleDeviceValue(data).match(/(?:^|\n)\s*(\d+)\s*(?=\n|$)/gu) ?? [];
      size = Number(matches.at(-1)?.trim() ?? 0);
    } catch {}
    if (Number.isSafeInteger(size) && size >= 24 && size <= MAX_ARTIFACT_BYTES) return size;
    if (attempt < 19) await options.delay(250);
  }
  throw new Error("Xiaowei screencap did not produce a stable phone artifact");
}

async function waitForLocalScreenshot(screenshotPath, options) {
  let previousSize = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const metadata = await stat(screenshotPath);
      if (metadata.isFile() && metadata.size >= 24 && metadata.size <= MAX_ARTIFACT_BYTES) {
        if (metadata.size === previousSize) return metadata;
        previousSize = metadata.size;
      }
    } catch {}
    if (attempt < 19) await options.delay(250);
  }
  throw new Error("Xiaowei pullFile returned success but did not create a stable local artifact");
}

async function readScreen(target, deviceDirectory, options, artifactName = "screen.png") {
  const nonce = randomUUID().replaceAll("-", "");
  const remotePath = `/sdcard/Download/xhs-agent-screen-${nonce}.png`;
  if (!/^[A-Za-z0-9._-]{1,96}\.png$/u.test(artifactName)) {
    throw new Error("Xiaowei screenshot artifact name is invalid");
  }
  const screenshotPath = path.join(deviceDirectory, artifactName);
  await rm(screenshotPath, { force: true });
  let cleanup = "not_needed";
  let artifact;
  try {
    await invokeOfficial("adb_shell", target, { command: `screencap -p ${remotePath}` }, options);
    cleanup = "pending";
    await waitForRemoteScreenshot(target, remotePath, options);
    await invokeOfficial("pullFile", target, { filePath: remotePath, savePath: screenshotPath }, options);
    await waitForLocalScreenshot(screenshotPath, options);
    const dimensions = inspectPng(await readFile(screenshotPath));
    artifact = {
      screenshotPath,
      ...dimensions,
      verification: "decoded_png_artifact",
    };
  } catch (error) {
    await rm(screenshotPath, { force: true });
    throw error;
  } finally {
    if (cleanup === "pending") {
      try {
        await invokeOfficial("adb_shell", target, { command: `rm -f ${remotePath}` }, options);
        cleanup = "completed";
      } catch {
        cleanup = "failed";
      }
    }
  }
  if (cleanup === "failed") {
    throw new Error("Xiaowei screenshot was verified but phone artifact cleanup failed");
  }
  return { ...artifact, cleanup };
}

function validateOcrBounds(bounds, dimensions, label) {
  if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger)
      || bounds.left < 0 || bounds.top < 0 || bounds.right <= bounds.left || bounds.bottom <= bounds.top
      || bounds.right > dimensions.width || bounds.bottom > dimensions.height) {
    throw new Error(`Local OCR returned invalid ${label} bounds`);
  }
  const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
  if (area > dimensions.width * dimensions.height * 0.25) {
    throw new Error(`Local OCR ${label} bounds are too large for controlled clicking`);
  }
  return bounds;
}

function stableOcrTarget(reference, current) {
  const center = (bounds) => ({
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  });
  const left = center(reference);
  const right = center(current);
  return Math.abs(left.x - right.x) <= 24 && Math.abs(left.y - right.y) <= 24
    && Math.abs(left.width - right.width) <= Math.max(8, left.width * 0.2)
    && Math.abs(left.height - right.height) <= Math.max(8, left.height * 0.2);
}

export function inferWechatMeBounds(contactsBounds, discoverBounds, dimensions) {
  return inferHorizontalOrdinalBounds([contactsBounds, discoverBounds], {
    algorithm: "horizontal_equal_spacing",
    region: "bottom_navigation",
    anchors: [
      { label: "contacts", ordinal: 2 },
      { label: "discover", ordinal: 3 },
    ],
    targetOrdinal: 4,
  }, dimensions);
}

async function locateText(options, imagePath, expectedText, label, dimensions, {
  allowMissing = false, requireStable = true,
} = {}) {
  let accepted = null;
  let hits = 0;
  const attempts = requireStable ? 3 : 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observation = await options.localOcr({ mode: "locate_text", imagePath, expectedText });
    if (!observation || observation.ocrAvailable !== true || !Array.isArray(observation.matches)) {
      throw new Error(`Local OCR was unavailable while locating ${label}`);
    }
    if (observation.matches.length > 1) {
      throw new Error(`Local OCR found multiple separated ${label} matches`);
    }
    if (observation.matches.length === 1) {
      const current = validateOcrBounds(observation.matches[0], dimensions, label);
      if (accepted && !stableOcrTarget(accepted, current)) {
        throw new Error(`Local OCR ${label} location was not stable`);
      }
      accepted = accepted ?? current;
      hits += 1;
      if (!requireStable || hits >= 2) return accepted;
    }
  }
  if (allowMissing) return null;
  throw new Error(`Local OCR did not produce two stable unique ${label} matches`);
}

function isDescendantOf(document, node, ancestor) {
  let current = node;
  while (current?.parentIndex !== null) {
    if (current.parentIndex === ancestor.nodeIndex) return true;
    current = document.nodes[current.parentIndex];
  }
  return false;
}

function hasRelativePosition(nodeBounds, anchorBounds, position) {
  if (!position) return true;
  const nodeCenterX = (nodeBounds.left + nodeBounds.right) / 2;
  const nodeCenterY = (nodeBounds.top + nodeBounds.bottom) / 2;
  const anchorCenterX = (anchorBounds.left + anchorBounds.right) / 2;
  const anchorCenterY = (anchorBounds.top + anchorBounds.bottom) / 2;
  if (position === "right") return nodeCenterX > anchorCenterX;
  if (position === "left") return nodeCenterX < anchorCenterX;
  if (position === "above") return nodeCenterY < anchorCenterY;
  return nodeCenterY > anchorCenterY;
}

function sharesBoundedAncestor(document, node, anchors, dimensions, position, maximumDepth = 2) {
  const nodeBounds = parseBounds(node.attributes?.bounds);
  if (!nodeBounds) return false;
  let current = node;
  for (let depth = 0; current && depth <= maximumDepth; depth += 1) {
    const bounds = parseBounds(current.attributes?.bounds);
    const localContainer = bounds
      && bounds.width * bounds.height <= dimensions.width * dimensions.height * 0.5;
    const relatedAnchors = localContainer ? anchors.filter((anchor) =>
      anchor.nodeIndex === current.nodeIndex || isDescendantOf(document, anchor, current)) : [];
    if (relatedAnchors.some((anchor) => {
      const anchorBounds = parseBounds(anchor.attributes?.bounds);
      return anchorBounds && hasRelativePosition(nodeBounds, anchorBounds, position);
    })) {
      return true;
    }
    current = current.parentIndex === null ? null : document.nodes[current.parentIndex];
  }
  return false;
}

function matchesAccessibilityAttributes(node, selector) {
  const filters = [
    ["text", node.text],
    ["contentDesc", node.contentDesc],
    ["className", node.className],
    ["resourceId", node.resourceId],
  ];
  for (const [field, actual] of filters) {
    if (selector[field] !== undefined && semanticValue(actual) !== semanticValue(selector[field])) return false;
  }
  if (selector.clickable !== undefined && node.clickable !== selector.clickable) return false;
  return true;
}

function boundsInScreenRegion(bounds, region, dimensions) {
  if (!region) return true;
  const x = (bounds.left + bounds.right) / 2;
  const y = (bounds.top + bounds.bottom) / 2;
  if (region === "top_left") return x < dimensions.width / 2 && y < dimensions.height * 0.25;
  if (region === "top_right") return x >= dimensions.width / 2 && y < dimensions.height * 0.25;
  if (region === "bottom_left") return x < dimensions.width / 2 && y >= dimensions.height * 0.75;
  if (region === "bottom_right") return x >= dimensions.width / 2 && y >= dimensions.height * 0.75;
  if (region === "bottom_navigation") return y >= dimensions.height * 0.85;
  return x >= dimensions.width * 0.75;
}

export function uniqueAccessibilityBounds(hierarchy, selector, dimensions) {
  const document = parseUiAutomatorXml(hierarchy);
  const attributeFields = ["text", "contentDesc", "className", "resourceId", "clickable"];
  const hasAttributeFilter = attributeFields.some((field) => selector[field] !== undefined);
  const expected = semanticValue(selector.label);
  const anchors = selector.nearText === undefined ? [] : document.nodes.filter((node) =>
    semanticValue(node.text) === semanticValue(selector.nearText)
    || semanticValue(node.contentDesc) === semanticValue(selector.nearText));
  if (selector.nearText !== undefined && !anchors.length) return null;
  let candidates = document.nodes
    .filter((node) => hasAttributeFilter
      ? matchesAccessibilityAttributes(node, selector)
      : semanticValue(node.text) === expected || semanticValue(node.contentDesc) === expected)
    .filter((node) => !anchors.length || sharesBoundedAncestor(
      document, node, anchors, dimensions, selector.nearTextPosition,
    ))
    .map((node) => actionableAncestor(document, node))
    .filter(Boolean)
    .map(({ bounds }) => bounds)
    .filter((bounds) => bounds.right <= dimensions.width && bounds.bottom <= dimensions.height)
    .filter((bounds) => boundsInScreenRegion(bounds, selector.screenRegion, dimensions));
  let unique = [...new Map(candidates.map((bounds) => [
    `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`, bounds,
  ])).values()];
  unique.sort((left, right) => left.top - right.top || left.left - right.left
    || left.width * left.height - right.width * right.height);
  if (selector.regionOrdinal !== undefined) unique = unique.slice(selector.regionOrdinal - 1, selector.regionOrdinal);
  if (unique.length > 1) throw new DeviceNodeError("NODE_AMBIGUOUS", "Accessibility exposed multiple matching nodes");
  return unique[0] ?? null;
}

const VISION_NODE_SYSTEM_PROMPT = [
  "Locate visible device-screen nodes and return JSON only.",
  "The response must have exactly this shape:",
  '{"matches":[{"left":100,"top":100,"right":102,"bottom":102}]}',
  "For each candidate, return a 2x2 pixel marker centered on the safest activation point.",
  "The marker must satisfy right=left+2 and bottom=top+2 in the supplied screenshot coordinate space.",
  "Do not return the visual extent of the icon, text, button, or navigation cell.",
  "Return every visible match. Return an empty matches array when there is no match.",
  "Do not include explanations or additional fields.",
].join("\n");

async function locateVisionNode(options, imagePath, selector, dimensions) {
  let response;
  try {
    response = await options.cloudVision({
      imagePath,
      promptText: VISION_NODE_SYSTEM_PROMPT,
      instruction: [
        `Display: ${dimensions.width}x${dimensions.height}.`,
        `Target label: ${JSON.stringify(selector.label)}.`,
        `Target role: ${JSON.stringify(selector.role)}.`,
        `Visual description: ${JSON.stringify(selector.visionPrompt)}.`,
        "Locate all visible candidates matching this target.",
      ].join("\n"),
    });
  } catch (error) {
    const message = String(error?.message ?? "");
    if (/VISION_(?:API_URL|API_KEY|MODEL)|AI_(?:API_URL|API_KEY|MODEL)|设置|configured|configuration/iu.test(message)) {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Vision service is not configured");
    }
    if (/JSON|choices\[0\]|content|返回|response|shape/iu.test(message)) {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Vision service returned an invalid observation");
    }
    throw new DeviceNodeError("TRANSPORT_FAILED", "Vision service request failed");
  }
  const bounds = parseVisionNodeResponse(response?.content ?? response, dimensions);
  if (!bounds) return null;
  const centerX = Math.min(dimensions.width - 1, Math.max(1, Math.round((bounds.left + bounds.right) / 2)));
  const centerY = Math.min(dimensions.height - 1, Math.max(1, Math.round((bounds.top + bounds.bottom) / 2)));
  return { left: centerX - 1, top: centerY - 1, right: centerX + 1, bottom: centerY + 1 };
}

async function nodeObservation(target, request, deviceDirectory, options, artifactPrefix) {
  const hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, request.package)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "Expected foreground package was not verified");
  }
  const dimensions = await readPhysicalDisplaySize(target, options);
  const screen = await readScreen(target, deviceDirectory, options, `${artifactPrefix}.png`);
  if (screen.width !== dimensions.width || screen.height !== dimensions.height) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Screenshot and physical display dimensions differ");
  }
  let ocrMiss = false;
  let visionMiss = false;
  for (const source of request.selector.sources) {
    if (source === "accessibility") {
      const bounds = uniqueAccessibilityBounds(hierarchy, request.selector, dimensions);
      if (bounds) return { hierarchy, screen, dimensions, bounds, source };
    } else if (source === "ocr") {
      try {
        const bounds = await locateText(
          options, screen.screenshotPath, request.selector.label, "node", dimensions,
          { allowMissing: true, requireStable: true },
        );
        if (bounds) return { hierarchy, screen, dimensions, bounds, source };
        ocrMiss = true;
      } catch (error) {
        if (/multiple separated/u.test(error.message)) {
          throw new DeviceNodeError("OCR_AMBIGUOUS", "OCR exposed multiple exact nodes");
        }
        if (/unavailable/u.test(error.message)) {
          throw new DeviceNodeError("CAPABILITY_MISSING", "Local OCR is unavailable");
        }
        throw error;
      }
    } else if (source === "vision") {
      const bounds = await locateVisionNode(
        options, screen.screenshotPath, request.selector, dimensions,
      );
      if (bounds) return { hierarchy, screen, dimensions, bounds, source };
      visionMiss = true;
    } else if (source === "relation") {
      const anchors = [];
      for (const anchor of request.selector.relation.anchors) {
        try {
          const bounds = await locateText(
            options, screen.screenshotPath, anchor.label, "relation anchor", dimensions,
            { allowMissing: true, requireStable: true },
          );
          if (!bounds) {
            throw new DeviceNodeError("NODE_NOT_FOUND", "A required relation anchor was not found");
          }
          anchors.push(bounds);
        } catch (error) {
          if (error instanceof DeviceNodeError) throw error;
          if (/multiple separated/u.test(error.message)) {
            throw new DeviceNodeError("OCR_AMBIGUOUS", "A relation anchor was ambiguous");
          }
          if (/unavailable/u.test(error.message)) {
            throw new DeviceNodeError("CAPABILITY_MISSING", "Local OCR is unavailable");
          }
          throw error;
        }
      }
      return {
        hierarchy,
        screen,
        dimensions,
        bounds: inferHorizontalOrdinalBounds(anchors, request.selector.relation, dimensions),
        source,
      };
    } else {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Configured node source is unavailable");
    }
  }
  throw new DeviceNodeError(
    ocrMiss && !visionMiss ? "OCR_MISS" : "NODE_NOT_FOUND",
    "No configured source resolved one unique node",
  );
}

async function screenshotContainsText(observation, value, options) {
  if (hierarchyMatchesPostcondition(observation.hierarchy, { kind: "text", value })) return true;
  try {
    const located = await locateText(
      options, observation.screen.screenshotPath, value, "postcondition", observation.dimensions,
      { allowMissing: true, requireStable: false },
    );
    return Boolean(located);
  } catch (error) {
    if (/unavailable/u.test(String(error?.message ?? ""))) return false;
    throw error;
  }
}

// LLM vision returns approximate boxes; two independent observations of the
// same stable target routinely differ by tens of pixels, which is normal for
// the model but far beyond the accessibility-grade 24px tolerance. Compare
// vision observations with a screen-relative point tolerance instead; a real
// page change still moves the target by hundreds of pixels and stays blocked.
function visionPointsAgree(first, second, dimensions) {
  const distance = Math.hypot(
    ((first.left + first.right) - (second.left + second.right)) / 2,
    ((first.top + first.bottom) - (second.top + second.bottom)) / 2,
  );
  return distance <= Math.max(64, dimensions.width * 0.08);
}

function observationsAgree(first, guard) {
  if (first.source !== guard.source) return false;
  if (first.source === "vision") return visionPointsAgree(first.bounds, guard.bounds, first.dimensions);
  return stableNodeBounds(first.bounds, guard.bounds);
}

async function resolveDeviceNode(target, request, deviceDirectory, options) {
  const first = await nodeObservation(target, request, deviceDirectory, options, "node-resolve-before");
  await options.delay(250);
  const guard = await nodeObservation(target, request, deviceDirectory, options, "node-resolve-guard");
  if (!observationsAgree(first, guard)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Node changed between two fresh observations");
  }
  return {
    machine: target.machine,
    status: "resolved",
    node: publicNodeDescription(request.selector, guard.source),
    evidence: {
      foregroundPackageVerified: true,
      freshObservations: 2,
      coordinateExposed: false,
    },
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function activateDeviceNode(target, request, deviceDirectory, options) {
  const first = await nodeObservation(target, request, deviceDirectory, options, "node-activate-before");
  if (await screenshotContainsText(first, request.postcondition.value, options)) {
    throw new DeviceNodeError("POSTCONDITION_MISS", "Postcondition was already visible before activation");
  }
  await options.delay(250);
  const guard = await nodeObservation(target, request, deviceDirectory, options, "node-activate-guard");
  if (await screenshotContainsText(guard, request.postcondition.value, options)) {
    throw new DeviceNodeError("POSTCONDITION_MISS", "Postcondition appeared before activation");
  }
  if (!observationsAgree(first, guard)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Node changed before activation; no event was sent");
  }
  const x = (guard.bounds.left + guard.bounds.right) / 2;
  const y = (guard.bounds.top + guard.bounds.bottom) / 2;
  const decimal = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
  await invokeOfficial("pointerEvent", target, {
    type: "10",
    x: decimal((x / guard.dimensions.width) * 100),
    y: decimal((y / guard.dimensions.height) * 100),
  }, options);

  let verified = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const after = await nodeObservationForPostcondition(
      target, request, deviceDirectory, options, `node-activate-after-${attempt + 1}`,
    );
    if (await screenshotContainsText(after, request.postcondition.value, options)) {
      verified = true;
      break;
    }
    if (attempt < 5) await options.delay(400);
  }
  if (!verified) {
    throw new DeviceNodeError("POSTCONDITION_MISS", "One event was sent but the fresh postcondition was not verified; it will not be replayed");
  }
  return {
    machine: target.machine,
    status: "verified",
    node: publicNodeDescription(request.selector, guard.source),
    verification: "node_rechecked_then_single_pointer_event_then_fresh_postcondition",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function nodeObservationForPostcondition(target, request, deviceDirectory, options, artifactPrefix) {
  const hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, request.package)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "Foreground changed after the single event");
  }
  const dimensions = await readPhysicalDisplaySize(target, options);
  const screen = await readScreen(target, deviceDirectory, options, `${artifactPrefix}.png`);
  if (screen.width !== dimensions.width || screen.height !== dimensions.height) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Display dimensions changed after the single event");
  }
  return { hierarchy, screen, dimensions };
}

async function locateTapTarget(options, imagePath, request, dimensions, label) {
  const direct = await locateText(options, imagePath, request.text, label, dimensions, {
    allowMissing: true,
    requireStable: true,
  });
  if (direct) return { bounds: direct, strategy: "exact_text" };
  const wechatMeFallback = request.package === "com.tencent.mm"
    && semanticValue(request.text) === "我"
    && request.postcondition.kind === "text"
    && semanticValue(request.postcondition.value) === "服务";
  if (!wechatMeFallback) throw new Error(`Local OCR did not produce two stable unique ${label} matches`);
  const contacts = await locateText(options, imagePath, "通讯录", "WeChat contacts-tab anchor", dimensions);
  const discover = await locateText(options, imagePath, "发现", "WeChat discover-tab anchor", dimensions);
  return {
    bounds: inferWechatMeBounds(contacts, discover, dimensions),
    strategy: "wechat_bottom_navigation_anchor_inference",
  };
}

async function tapOcr(target, request, deviceDirectory, options) {
  const beforeHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(beforeHierarchy, request.package)) {
    throw new Error("OCR tap refused because the expected foreground package was not verified");
  }
  const before = await readScreen(target, deviceDirectory, options, "tap-ocr-before.png");
  const resolvedTarget = await locateTapTarget(options, before.screenshotPath, request, before, "target");
  const preexistingPostcondition = await locateText(
    options, before.screenshotPath, request.postcondition.value, "postcondition", before,
    { allowMissing: true, requireStable: false },
  );
  if (preexistingPostcondition) {
    throw new Error("OCR tap postcondition was already visible before the action");
  }

  const guard = await readScreen(target, deviceDirectory, options, "tap-ocr-guard.png");
  if (guard.width !== before.width || guard.height !== before.height) {
    throw new Error("OCR tap display dimensions changed before the action");
  }
  const guardTarget = await locateTapTarget(options, guard.screenshotPath, request, guard, "guard target");
  const guardPostcondition = await locateText(
    options, guard.screenshotPath, request.postcondition.value, "guard postcondition", guard,
    { allowMissing: true, requireStable: false },
  );
  if (guardPostcondition || resolvedTarget.strategy !== guardTarget.strategy
      || !stableOcrTarget(resolvedTarget.bounds, guardTarget.bounds)) {
    throw new Error("OCR tap target changed before the action; no click was sent");
  }
  const guardHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(guardHierarchy, request.package)) {
    throw new Error("OCR tap foreground package changed before the action; no click was sent");
  }

  const x = (guardTarget.bounds.left + guardTarget.bounds.right) / 2;
  const y = (guardTarget.bounds.top + guardTarget.bounds.bottom) / 2;
  const decimal = (value) => value.toFixed(6).replace(/\.?0+$/u, "");
  await invokeOfficial("pointerEvent", target, {
    type: "10",
    x: decimal((x / guard.width) * 100),
    y: decimal((y / guard.height) * 100),
  }, options);

  let after = null;
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    after = await readScreen(target, deviceDirectory, options, `tap-ocr-after-${attempt + 1}.png`);
    const afterHierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(afterHierarchy, request.package)) {
      throw new Error("OCR tap was sent once but the foreground package drifted; the tap will not be replayed");
    }
    const postcondition = await locateText(
      options, after.screenshotPath, request.postcondition.value, "postcondition", after,
      { allowMissing: true, requireStable: true },
    );
    if (postcondition) {
      verified = true;
      break;
    }
    if (attempt < 5) await options.delay(400);
  }
  if (!verified) {
    throw new Error("OCR tap was sent once but the screenshot postcondition was not verified; the tap will not be replayed");
  }
  return {
    executionOutcome: "accepted",
    verificationOutcome: "verified",
    beforeScreenshotPath: before.screenshotPath,
    beforeWidth: before.width,
    beforeHeight: before.height,
    screenshotPath: after.screenshotPath,
    width: after.width,
    height: after.height,
    verification: resolvedTarget.strategy === "exact_text"
      ? "unique_local_ocr_target_rechecked_then_single_pointer_event_then_fresh_ocr_postcondition"
      : "wechat_navigation_anchors_rechecked_then_single_pointer_event_then_fresh_ocr_postcondition",
  };
}

async function verifyWechatChangePage(imagePath, dimensions, options) {
  for (const label of ["零钱", "充值", "提现"]) {
    await locateText(options, imagePath, label, "WeChat change-page marker", dimensions, {
      allowMissing: false,
      requireStable: false,
    });
  }
}

async function readStableCurrencyAmount(imagePath, options) {
  let accepted = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observation = await options.localOcr({ mode: "currency_amount", imagePath });
    if (!observation || observation.ocrAvailable !== true || !Array.isArray(observation.currencyAmounts)
        || observation.currencyAmounts.length !== 1) {
      throw new Error("WeChat wallet balance requires exactly one local OCR currency amount");
    }
    const current = observation.currencyAmounts[0];
    if (!plainObject(current) || current.currency !== "CNY" || !Number.isSafeInteger(current.amountMinor)
        || current.amountMinor < 0 || current.amountMinor > 99_999_999_999_999) {
      throw new Error("WeChat wallet balance OCR returned an invalid amount");
    }
    if (accepted && (accepted.currency !== current.currency || accepted.amountMinor !== current.amountMinor)) {
      throw new Error("WeChat wallet balance OCR was not stable on one screenshot");
    }
    accepted = current;
  }
  return accepted;
}

function formatMinorAmount(amountMinor) {
  const whole = Math.floor(amountMinor / 100);
  const fraction = String(amountMinor % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

async function readWechatWalletBalance(target, deviceDirectory, options) {
  const packageName = "com.tencent.mm";
  const firstHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(firstHierarchy, packageName)) {
    throw new Error("WeChat wallet balance requires WeChat in the foreground");
  }
  const first = await readScreen(target, deviceDirectory, options, "wechat-wallet-balance-before.png");
  await verifyWechatChangePage(first.screenshotPath, first, options);
  const firstAmount = await readStableCurrencyAmount(first.screenshotPath, options);

  await options.delay(350);
  const secondHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(secondHierarchy, packageName)) {
    throw new Error("WeChat foreground changed during wallet balance verification");
  }
  const second = await readScreen(target, deviceDirectory, options, "wechat-wallet-balance-after.png");
  if (second.width !== first.width || second.height !== first.height) {
    throw new Error("WeChat wallet display dimensions changed during balance verification");
  }
  await verifyWechatChangePage(second.screenshotPath, second, options);
  const secondAmount = await readStableCurrencyAmount(second.screenshotPath, options);
  if (firstAmount.currency !== secondAmount.currency || firstAmount.amountMinor !== secondAmount.amountMinor) {
    throw new Error("WeChat wallet balance changed between fresh screenshots");
  }
  return {
    machine: target.machine,
    currency: firstAmount.currency,
    balance: formatMinorAmount(firstAmount.amountMinor),
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function readXhsPublicObservation(target, options) {
  const rules = await loadRules(options.xhsRulesPath);
  const firstHierarchy = await readUiHierarchy(target, options);
  const first = observeXhsHierarchy(firstHierarchy, rules, { targetAlias: target.alias });
  if (first.page.state === "VIDEO_NOTE") {
    return {
      machine: target.machine,
      ...first,
      stability: "single_fresh_video_detail_ui",
      transport: "xiaowei-api",
      localAdbRequired: false,
    };
  }
  await options.delay(300);
  const secondHierarchy = await readUiHierarchy(target, options);
  const second = observeXhsHierarchy(secondHierarchy, rules, { targetAlias: target.alias });
  const observation = intersectXhsObservations(first, second);
  return {
    machine: target.machine,
    ...observation,
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

function xhsFindVideoResult(target, observation, note, scrolls, startedAt, options) {
  return {
    machine: target.machine,
    status: note ? "found" : "not_found",
    page: observation.page,
    note,
    ordinal: note?.ordinal ?? null,
    scrolls,
    elapsedMs: Math.max(0, options.now() - startedAt),
    verification: "fresh_home_feed_ui_after_each_scroll",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function findVisibleXhsVideo(target, request, options) {
  const rules = await loadRules(options.xhsRulesPath);
  const startedAt = options.now();
  let hierarchy = await readUiHierarchy(target, options);
  let observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
  hierarchy = await recoverXhsHomeFeed(target, hierarchy, observation, rules, options);
  observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
  let scrolls = 0;
  while (true) {
    if (observation.page.state !== "HOME_FEED") {
      throw new Error("xhs.find-video requires a freshly verified Xiaohongshu home feed");
    }
    const video = observation.notes.find((note) => note.mediaType === "video") ?? null;
    if (video) return xhsFindVideoResult(target, observation, video, scrolls, startedAt, options);
    if (scrolls >= request.maxScrolls || options.now() - startedAt >= request.maxDurationMs) {
      return xhsFindVideoResult(target, observation, null, scrolls, startedAt, options);
    }

    const beforeTarget = scrollableContainer(hierarchy, XHS_PACKAGE);
    const beforeHash = createNormalizedFingerprint(hierarchy).hash;
    await invokeOfficial("pointerEvent", target, { type: "6" }, options);
    let changedHierarchy = null;
    let changedObservation = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const candidateHierarchy = await readUiHierarchy(target, options);
        const candidateObservation = observeXhsHierarchy(candidateHierarchy, rules, { targetAlias: target.alias });
        const candidateTarget = scrollableContainer(candidateHierarchy, XHS_PACKAGE);
        if (candidateObservation.page.state === "HOME_FEED"
            && sameScrollableContainer(beforeTarget, candidateTarget)
            && createNormalizedFingerprint(candidateHierarchy).hash !== beforeHash) {
          changedHierarchy = candidateHierarchy;
          changedObservation = candidateObservation;
          break;
        }
      } catch {
        // Feed scrolling can briefly expose an incomplete hierarchy.
      }
      if (attempt < 9 && options.now() - startedAt < request.maxDurationMs) await options.delay(300);
    }
    if (!changedHierarchy || !changedObservation) {
      throw new Error("xhs.find-video sent one scroll event but a fresh home-feed change was not verified; the event will not be replayed");
    }
    hierarchy = changedHierarchy;
    observation = changedObservation;
    scrolls += 1;
  }
}

function samePublicNoteIdentity(left, right) {
  return left?.title === right?.title && left?.author === right?.author && left?.mediaType === right?.mediaType;
}

async function recoverXhsHomeFeed(target, hierarchy, observation, rules, options) {
  if (observation.page.state === "HOME_FEED") return hierarchy;
  for (let stage = 0; stage < 2; stage += 1) {
    const priorState = observation.page.state;
    if (!["COMMENT_PANEL", "IMAGE_NOTE", "VIDEO_NOTE"].includes(priorState)) {
      throw new Error(`xhs.open-visible cannot recover the home feed from ${priorState}`);
    }
    await invokeOfficial("pushEvent", target, { type: "3" }, options);
    let transitioned = false;
    for (let attempt = 0; attempt < 28; attempt += 1) {
      try {
        hierarchy = await readUiHierarchy(target, options);
        observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
        if (observation.page.state === "HOME_FEED") return hierarchy;
        if (priorState === "COMMENT_PANEL" && ["IMAGE_NOTE", "VIDEO_NOTE"].includes(observation.page.state)) {
          transitioned = true;
          break;
        }
      } catch {
        // Back transitions may briefly expose an incomplete hierarchy.
      }
      if (attempt < 27) await options.delay(400);
    }
    if (!transitioned) {
      throw new Error("xhs.open-visible sent BACK once but the expected feed transition was not verified; BACK will not be replayed");
    }
  }
  throw new Error("xhs.open-visible could not recover the Xiaohongshu home feed");
}

async function openVisibleXhsNote(target, request, options) {
  const rules = await loadRules(options.xhsRulesPath);
  const displaySize = await readPhysicalDisplaySize(target, options);
  let firstHierarchy = await readUiHierarchy(target, options);
  const initialObservation = observeXhsHierarchy(firstHierarchy, rules, { targetAlias: target.alias });
  firstHierarchy = await recoverXhsHomeFeed(target, firstHierarchy, initialObservation, rules, options);
  const firstTarget = resolveVisibleXhsNote(firstHierarchy, request.ordinal, displaySize);
  if (await readFocusedPackage(target, options) !== XHS_PACKAGE) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS left the foreground before opening the visible note");
  }

  await invokeOfficial("pointerEvent", target, { type: "10", ...firstTarget.point }, options);
  let detailObservation = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const hierarchy = await readUiHierarchy(target, options);
      const observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
      if (["IMAGE_NOTE", "VIDEO_NOTE"].includes(observation.page.state)
          && samePublicNoteIdentity(xhsObservationTarget(observation), firstTarget.note)) {
        detailObservation = observation;
        break;
      }
    } catch {
      // A page transition can briefly expose an incomplete hierarchy.
    }
    if (attempt < 7) await options.delay(400);
  }
  if (!detailObservation) {
    throw new Error("XHS note was tapped once but its matching detail page was not verified; the tap will not be replayed");
  }
  return {
    machine: target.machine,
    selected: {
      ordinal: request.ordinal,
      title: firstTarget.note.title,
      author: firstTarget.note.author,
      mediaType: firstTarget.note.mediaType,
    },
    ...detailObservation,
    stability: "single_fresh_matching_detail_ui",
    verification: "single_pointer_event_then_fresh_matching_detail_ui",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

function uniqueXhsControlBounds(hierarchy, label, { optional = false } = {}) {
  const document = parseUiAutomatorXml(hierarchy);
  const expected = semanticValue(label);
  const candidates = document.nodes
    .filter((node) => node.packageName === XHS_PACKAGE
      && (semanticValue(node.text) === expected || semanticValue(node.contentDesc) === expected))
    .map((node) => actionableAncestor(document, node))
    .filter(Boolean);
  const unique = [...new Map(candidates.map(({ bounds }) => [
    `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`, bounds,
  ])).values()];
  if (unique.length > 1) throw new DeviceNodeError("NODE_AMBIGUOUS", `XHS control ${label} was not unique`);
  if (!unique.length && !optional) throw new DeviceNodeError("NODE_NOT_FOUND", `XHS control ${label} was not found`);
  return unique[0] ?? null;
}

function xhsDraftEditor(hierarchy, expectedEmoji) {
  const document = parseUiAutomatorXml(hierarchy);
  // Both sides must be NFKC-normalized: the accessibility layer may expose
  // full-width characters (e.g. U+FF01) in compatibility form (U+0021), and
  // comparing a normalized node value against a raw request silently missed
  // exact drafts containing full-width punctuation (machine-independent).
  const expected = expectedEmoji === undefined ? undefined : semanticValue(expectedEmoji);
  const candidates = document.nodes
    .filter((node) => node.packageName === XHS_PACKAGE && /(?:^|\.)EditText$/u.test(node.className))
    .map((node) => ({ node, bounds: parseBounds(node.attributes?.bounds) }))
    .filter(({ node, bounds }) => bounds && (expected === undefined
      || semanticValue(node.text).includes(expected)
      || semanticValue(node.contentDesc).includes(expected)));
  if (candidates.length > 1) throw new DeviceNodeError("NODE_AMBIGUOUS", "XHS exposed multiple comment editors");
  return candidates[0] ?? null;
}

function exactXhsCommentCount(hierarchy) {
  const document = parseUiAutomatorXml(hierarchy);
  const semanticCounts = [];
  const resourceCounts = [];
  for (const node of document.nodes) {
    if (node.packageName !== XHS_PACKAGE) continue;
    for (const value of [node.text, node.contentDesc]) {
      const normalized = semanticValue(value).replace(/,/gu, "");
      const semanticMatch = /^(?:评论\s*|共\s*)(\d{1,9})(?:\s*条评论)?$/u.exec(normalized);
      if (semanticMatch) semanticCounts.push(Number(semanticMatch[1]));
      if (/comment[_-]?(?:count|entry)/iu.test(node.resourceId)) {
        const resourceMatch = /^(\d{1,9})$/u.exec(normalized);
        if (resourceMatch) resourceCounts.push(Number(resourceMatch[1]));
      }
    }
  }
  const unique = [...new Set(semanticCounts.length ? semanticCounts : resourceCounts)];
  if (unique.length !== 1 || !Number.isSafeInteger(unique[0])) {
    throw new Error("XHS comment action requires one exact visible comment count");
  }
  return unique[0];
}

async function invokePointerBounds(target, bounds, dimensions, options) {
  await invokeOfficial("pointerEvent", target, {
    type: "10",
    ...percentagePoint(bounds, dimensions),
  }, options);
}

function xhsDraftMatches(editor, expectedDraft, expectedEmptyEditorStateHash = null) {
  if (!editor) return false;
  const expected = semanticValue(expectedDraft);
  const text = semanticValue(editor.node.text);
  const contentDescription = semanticValue(editor.node.contentDesc);
  if (text === expected || (!text && contentDescription === expected)) return true;
  if (typeof expectedEmptyEditorStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedEmptyEditorStateHash)) {
    return false;
  }
  const matchesBoundReply = (value, field) => {
    const match = /^(回复\s*@.{1,128}[：:]\s*)(.*)$/u.exec(value);
    if (!match || semanticValue(match[2]) !== expected) return false;
    const baselineText = field === "text" ? semanticValue(match[1]) : text;
    const baselineDescription = field === "contentDesc" ? semanticValue(match[1]) : contentDescription;
    const baselineState = `${baselineText}\u0000${baselineDescription}`;
    const baselineHash = createHash("sha256")
      .update(`xhs-comment-editor/v1\u0000${baselineState}`, "utf8").digest("hex");
    return baselineHash === expectedEmptyEditorStateHash;
  };
  return matchesBoundReply(text, "text") || matchesBoundReply(contentDescription, "contentDesc");
}

function xhsEditorToken(editor) {
  if (!editor) return null;
  const state = `${semanticValue(editor.node.text)}\u0000${semanticValue(editor.node.contentDesc)}`;
  return createHash("sha256").update(`xhs-comment-editor/v1\u0000${state}`, "utf8").digest("hex");
}

function xhsEditorIsEmpty(editor) {
  if (!editor) return false;
  const placeholders = new Set([
    "让大家听到你的声音",
    "留下你的想法吧",
    "说点什么...",
    "说点什么…",
    "友善评论，文明发言",
    "写评论...",
    "写评论…",
  ]);
  const text = semanticValue(editor.node.text);
  const contentDescription = semanticValue(editor.node.contentDesc);
  const replyPlaceholder = /^回复\s*@.{1,128}[：:]\s*$/u;
  return (!text || placeholders.has(text) || replyPlaceholder.test(text))
    && (!contentDescription || placeholders.has(contentDescription) || replyPlaceholder.test(contentDescription));
}

function xhsDmEditor(hierarchy, expectedDraft) {
  const document = parseUiAutomatorXml(hierarchy);
  const editors = document.nodes
    .filter((node) => node.packageName === XHS_PACKAGE && /(?:^|\.)EditText$/u.test(node.className))
    .map((node) => ({ node, bounds: parseBounds(node.attributes?.bounds) }))
    .filter(({ node, bounds }) => bounds && (expectedDraft === undefined
      || semanticValue(node.text) === semanticValue(expectedDraft)));
  if (editors.length !== 1) return null;
  return { document, ...editors[0] };
}

function xhsDmEditorIsEmpty(editor) {
  if (!editor) return false;
  const placeholders = new Set(["请友善发言...", "请友善发言…"]);
  const text = semanticValue(editor.node.text);
  const contentDescription = semanticValue(editor.node.contentDesc);
  return (!text || placeholders.has(text)) && (!contentDescription || placeholders.has(contentDescription));
}

function xhsDmSendBounds(state) {
  if (!state) return null;
  const editorCenterY = (state.bounds.top + state.bounds.bottom) / 2;
  const candidates = state.document.nodes
    .filter((node) => node.packageName === XHS_PACKAGE && node.enabled !== false && node.clickable
      && (semanticValue(node.text) === "发送" || semanticValue(node.contentDesc) === "发送"))
    .map((node) => parseBounds(node.attributes?.bounds))
    .filter((bounds) => bounds && bounds.left >= state.bounds.right
      && editorCenterY >= bounds.top - 24 && editorCenterY <= bounds.bottom + 24);
  return candidates.length === 1 ? candidates[0] : null;
}

function xhsDmContainsSentBubble(state, expectedDraft) {
  if (!state) return false;
  const expected = semanticValue(expectedDraft);
  return state.document.nodes.some((node) => node.packageName === XHS_PACKAGE
    && !/(?:^|\.)EditText$/u.test(node.className)
    && (semanticValue(node.text) === expected || semanticValue(node.contentDesc) === expected));
}

async function sendXhsDmDraft(target, request, options) {
  let hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "xhs.dm.send requires Xiaohongshu in the foreground");
  }
  const first = xhsDmEditor(hierarchy, request.expectedDraft);
  const firstSend = xhsDmSendBounds(first);
  if (!first || !firstSend) {
    throw new Error("xhs.dm.send requires one exact draft and one send control aligned with its editor");
  }
  await options.delay(300);
  hierarchy = await readUiHierarchy(target, options);
  const guard = xhsDmEditor(hierarchy, request.expectedDraft);
  const guardSend = xhsDmSendBounds(guard);
  if (!guard || !guardSend || !stableNodeBounds(first.bounds, guard.bounds)
      || !stableNodeBounds(firstSend, guardSend)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS private-message draft or send control changed before submission");
  }
  const dimensions = await readPhysicalDisplaySize(target, options);
  await invokePointerBounds(target, guardSend, dimensions, options);
  // Slow devices can take a long time to expose the sent bubble in the UI
  // hierarchy even though the editor clears right away. Treat editor clearing
  // as a strong send signal and degrade to "mitigated" instead of burning
  // the whole budget when the bubble stays unreadable (hermes P1 gap).
  const verifyBudgetMs = options.dmVerifyBudgetMs ?? 90_000;
  const degradedEchoBudgetMs = options.dmDegradedEchoBudgetMs ?? 20_000;
  const verifyStartedAt = options.now();
  let editorCleared = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const after = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(after, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after private-message submission");
    }
    const afterEditor = xhsDmEditor(after);
    if (xhsDmEditorIsEmpty(afterEditor) && xhsDmContainsSentBubble(afterEditor, request.expectedDraft)) {
      return {
        machine: target.machine,
        status: "verified",
        draftLength: [...request.expectedDraft].length,
        verification: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_and_message_echo",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (xhsDmEditorIsEmpty(afterEditor)) editorCleared = true;
    if (editorCleared && options.now() - verifyStartedAt >= degradedEchoBudgetMs) {
      return {
        machine: target.machine,
        status: "mitigated",
        draftLength: [...request.expectedDraft].length,
        verification: "expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_without_message_echo",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (options.now() - verifyStartedAt >= verifyBudgetMs) break;
    if (attempt < 14) await options.delay(400);
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "XHS private-message send was tapped once but editor clearing plus message echo was not verified; send will not be replayed",
  );
}

async function openXhsCommentComposer(target, options) {
  const dimensions = await readPhysicalDisplaySize(target, options);
  let hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "xhs.comment.open requires Xiaohongshu in the foreground");
  }
  const rules = await loadRules(options.xhsRulesPath);
  const observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
  if (!["IMAGE_NOTE", "VIDEO_NOTE"].includes(observation.page.state) || !observation.detail) {
    throw new Error("xhs.comment.open requires a classified XHS note detail");
  }
  const targetBinding = {
    title: observation.detail.title,
    author: observation.detail.author,
    mediaType: observation.detail.media.type,
  };
  const commentCount = exactXhsCommentCount(hierarchy);
  if (xhsDraftEditor(hierarchy)) {
    throw new Error("xhs.comment.open requires the comment composer to be closed before starting a new draft transaction");
  }

  const firstBox = uniqueXhsControlBounds(hierarchy, "评论框");
  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  const guardBox = uniqueXhsControlBounds(guardHierarchy, "评论框");
  if (!stableNodeBounds(firstBox, guardBox) || exactXhsCommentCount(guardHierarchy) !== commentCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS comment box changed before activation");
  }
  await invokePointerBounds(target, guardBox, dimensions, options);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    hierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after opening the comment composer");
    }
    const openedEditor = xhsDraftEditor(hierarchy);
    if (openedEditor) {
      return {
        machine: target.machine,
        status: "verified",
        commentCount,
        target: targetBinding,
        editorStateHash: xhsEditorToken(openedEditor),
        verification: "comment_box_rechecked_then_single_activation_then_editor_verified",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (attempt < 7) await options.delay(300);
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "The comment box was activated once but the editor was not verified; activation will not be replayed",
  );
}

function samePercentagePoint(left, right) {
  return left?.x === right?.x && left?.y === right?.y;
}

async function openXhsReplyEditor(target, replyOrdinal, options, {
  expectedDraft, expectedEditorStateHash,
} = {}) {
  const dimensions = await readPhysicalDisplaySize(target, options);
  const firstHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(firstHierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS reply input requires Xiaohongshu in the foreground");
  }
  if (xhsDraftEditor(firstHierarchy)) {
    throw new Error("XHS reply input requires the reply editor to be closed before selecting a reply target");
  }
  const commentCount = exactXhsCommentCount(firstHierarchy);
  const firstPoint = findSemanticTapPoint(firstHierarchy, "回复", dimensions, {
    packageName: XHS_PACKAGE,
    match: "suffix",
    ordinal: replyOrdinal,
  });
  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  const guardPoint = findSemanticTapPoint(guardHierarchy, "回复", dimensions, {
    packageName: XHS_PACKAGE,
    match: "suffix",
    ordinal: replyOrdinal,
  });
  if (!samePercentagePoint(firstPoint, guardPoint) || exactXhsCommentCount(guardHierarchy) !== commentCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS reply target changed before activation");
  }
  await invokeOfficial("pointerEvent", target, { type: "10", ...guardPoint }, options);
  let previousEditor = null;
  let focusTapped = false;
  // Slow machines (e.g. machine 01) can need >78s before the reply editor
  // becomes stable and focused. Use a real time budget instead of an attempt
  // count: faster UI reads must not shrink the wall-clock window, and calmer
  // polling disturbs the device's own settle less. All checks are unchanged.
  const openBudgetMs = options.replyOpenBudgetMs ?? 150_000;
  const openStartedAt = options.now();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const hierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after opening the reply editor");
    }
    const editor = xhsDraftEditor(hierarchy);
    const editorLabel = semanticValue(editor?.node.text || editor?.node.contentDesc);
    const draftBound = editor && (expectedDraft === undefined ? /^回复\s*@/u.test(editorLabel)
      : xhsDraftMatches(editor, expectedDraft, expectedEditorStateHash));
    const stableFocused = draftBound && editor.node.focused === true && previousEditor
      && editor.node.className === previousEditor.node.className
      && editor.node.resourceId === previousEditor.node.resourceId
      && stableNodeBounds(editor.bounds, previousEditor.bounds);
    if (stableFocused) {
      return { hierarchy, editor, commentCount };
    }
    if (options.now() - openStartedAt >= openBudgetMs) break;
    if (draftBound && editor.node.focused !== true && !focusTapped) {
      await invokePointerBounds(target, editor.bounds, dimensions, options);
      focusTapped = true;
    }
    previousEditor = draftBound ? editor : null;
    await options.delay(1_000);
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "The selected reply target was activated once but its editor was not verified; activation will not be replayed",
  );
}

async function inputXhsReplyDraft(target, request, deviceDirectory, options) {
  const opened = await openXhsReplyEditor(target, request.replyOrdinal, options);
  const editorStateHash = xhsEditorToken(opened.editor);
  const input = await inputXhsCommentDraft(target, {
    ...request,
    expectedEditorStateHash: editorStateHash,
  }, deviceDirectory, options);
  return {
    ...input,
    commentCount: opened.commentCount,
    editorStateHash,
    replyOrdinal: request.replyOrdinal,
    verification: "reply_target_rechecked_then_editor_recovered_after_ime_then_bound_draft_echo",
  };
}

async function inputXhsCommentDraft(target, request, deviceDirectory, options) {
  let hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "xhs.comment.input requires Xiaohongshu in the foreground");
  }
  const initialEditor = xhsDraftEditor(hierarchy);
  if (!initialEditor || xhsEditorToken(initialEditor) !== request.expectedEditorStateHash) {
    throw new Error("xhs.comment.input editor state did not match the open transaction token");
  }

  let inputMethod = "ime";
  const shortcutLabel = /^\[[^\]\r\n]{1,60}R\]$/u.test(request.text);
  const firstShortcut = shortcutLabel ? uniqueXhsControlBounds(hierarchy, request.text, { optional: true }) : null;
  if (firstShortcut) {
    inputMethod = "shortcut";
    const dimensions = await readPhysicalDisplaySize(target, options);
    await options.delay(250);
    const guardHierarchy = await readUiHierarchy(target, options);
    const guardEditor = xhsDraftEditor(guardHierarchy);
    const guardShortcut = uniqueXhsControlBounds(guardHierarchy, request.text);
    if (!guardEditor || xhsEditorToken(guardEditor) !== request.expectedEditorStateHash
        || !stableNodeBounds(initialEditor.bounds, guardEditor.bounds)
        || !stableNodeBounds(firstShortcut, guardShortcut)) {
      throw new DeviceNodeError("LAYOUT_DRIFT", "XHS comment editor or shortcut changed before draft input");
    }
    await invokePointerBounds(target, guardShortcut, dimensions, options);
  } else {
    await inputDeviceText(target, {
      ...request,
      package: XHS_PACKAGE,
      semanticEmpty: "xhs-comment",
      echoVerification: "ui_text",
    }, deviceDirectory, options, {
      reopenEditor: request.replyOrdinal === undefined
        ? undefined
        : async () => (await openXhsReplyEditor(target, request.replyOrdinal, options)).hierarchy,
    });
  }

  let reopenedAfterImeRestore = false;
  // On slow machines the draft echo only re-appears tens of seconds after the
  // IME-restore storm, and dense UI polling delays that settle further. Give
  // the device a short undisturbed grace window, then verify with a real time
  // budget and calmer polling; exact-match semantics stay unchanged.
  await options.delay(6_000);
  const verifyBudgetMs = options.commentDraftVerifyBudgetMs ?? 150_000;
  const verifyStartedAt = options.now();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    hierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after comment draft input");
    }
    const draftedEditor = xhsDraftEditor(hierarchy, request.text);
    if (xhsDraftMatches(draftedEditor, request.text, request.expectedEditorStateHash)) {
      return {
        machine: target.machine,
        status: "verified",
        inputMethod,
        draftLength: [...request.text].length,
        verification: "xhs_comment_draft_exact_ui_echo",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (options.now() - verifyStartedAt >= verifyBudgetMs) break;
    if (inputMethod === "ime" && !reopenedAfterImeRestore && !xhsDraftEditor(hierarchy)) {
      if (request.replyOrdinal !== undefined) {
        hierarchy = (await openXhsReplyEditor(target, request.replyOrdinal, options, {
          expectedDraft: request.text,
          expectedEditorStateHash: request.expectedEditorStateHash,
        })).hierarchy;
        reopenedAfterImeRestore = true;
        continue;
      }
      const firstBox = uniqueXhsControlBounds(hierarchy, "评论框", { optional: true });
      if (firstBox) {
        const dimensions = await readPhysicalDisplaySize(target, options);
        await options.delay(250);
        const guardHierarchy = await readUiHierarchy(target, options);
        const guardBox = uniqueXhsControlBounds(guardHierarchy, "评论框");
        if (!stableNodeBounds(firstBox, guardBox)) {
          throw new DeviceNodeError("LAYOUT_DRIFT", "XHS comment box changed while restoring the verified text draft");
        }
        await invokePointerBounds(target, guardBox, dimensions, options);
        reopenedAfterImeRestore = true;
        continue;
      }
    }
    await options.delay(2_500);
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "Comment input was sent once but the exact draft was not verified; input will not be replayed",
  );
}

function xhsObservationTarget(observation) {
  if (!observation?.detail) return null;
  return {
    title: observation.detail.title,
    author: observation.detail.author,
    mediaType: observation.detail.media?.type
      ?? (observation.page?.state === "VIDEO_NOTE" ? "video"
        : observation.page?.state === "IMAGE_NOTE" ? "image" : null),
  };
}

async function reopenExpectedXhsTarget(target, expectedTarget, dimensions, options) {
  const rules = await loadRules(options.xhsRulesPath);
  const firstHierarchy = await readUiHierarchy(target, options);
  const firstObservation = observeXhsHierarchy(firstHierarchy, rules, { targetAlias: target.alias });
  if (firstObservation.page.state !== "HOME_FEED") {
    throw new DeviceNodeError("POSTCONDITION_MISS", "Submitted comment count stayed hidden and the expected feed was not available");
  }
  const matches = firstObservation.notes
    .map((note, index) => ({ note, ordinal: index + 1 }))
    .filter(({ note }) => samePublicNoteIdentity(note, expectedTarget));
  if (matches.length !== 1) {
    throw new DeviceNodeError("NODE_AMBIGUOUS", "Expected commented note was not uniquely visible after submission");
  }
  const firstTarget = resolveVisibleXhsNote(firstHierarchy, matches[0].ordinal, dimensions);
  if (!samePublicNoteIdentity(firstTarget.note, expectedTarget)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Expected commented note did not match its visible feed target");
  }
  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  const guardObservation = observeXhsHierarchy(guardHierarchy, rules, { targetAlias: target.alias });
  const guardTarget = resolveVisibleXhsNote(guardHierarchy, matches[0].ordinal, dimensions);
  if (guardObservation.page.state !== "HOME_FEED"
      || !samePublicNoteIdentity(guardTarget.note, expectedTarget)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Expected commented note changed before count verification");
  }
  await invokeOfficial("pointerEvent", target, { type: "10", ...guardTarget.point }, options);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const detailHierarchy = await readUiHierarchy(target, options);
    const detailObservation = observeXhsHierarchy(detailHierarchy, rules, { targetAlias: target.alias });
    if (["IMAGE_NOTE", "VIDEO_NOTE"].includes(detailObservation.page.state)
        && samePublicNoteIdentity(xhsObservationTarget(detailObservation), expectedTarget)) {
      return detailHierarchy;
    }
    if (attempt < 7) await options.delay(350);
  }
  throw new DeviceNodeError("POSTCONDITION_MISS", "Expected commented note was opened once but its detail was not verified");
}

async function sendXhsCommentDraft(target, request, options) {
  const dimensions = await readPhysicalDisplaySize(target, options);
  const firstHierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(firstHierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "xhs.comment.send requires Xiaohongshu in the foreground");
  }
  const beforeCount = request.expectedBeforeCount;
  let visibleBeforeCount = null;
  try { visibleBeforeCount = exactXhsCommentCount(firstHierarchy); } catch {}
  if (visibleBeforeCount !== null && visibleBeforeCount !== beforeCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Visible XHS comment count did not match expectedBeforeCount");
  }
  const firstEditor = xhsDraftEditor(firstHierarchy, request.expectedDraft);
  const firstSend = uniqueXhsControlBounds(firstHierarchy, "发送");
  if (!xhsDraftMatches(firstEditor, request.expectedDraft, request.expectedEmptyEditorStateHash)) {
    throw new Error("xhs.comment.send refused a draft that did not exactly match expectedDraft");
  }

  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  const guardEditor = xhsDraftEditor(guardHierarchy, request.expectedDraft);
  const guardSend = uniqueXhsControlBounds(guardHierarchy, "发送");
  if (!xhsDraftMatches(guardEditor, request.expectedDraft, request.expectedEmptyEditorStateHash)
      || !stableNodeBounds(firstEditor.bounds, guardEditor.bounds)
      || !stableNodeBounds(firstSend, guardSend)) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS send control or expected draft changed before submission");
  }
  let visibleGuardCount = null;
  try { visibleGuardCount = exactXhsCommentCount(guardHierarchy); } catch {}
  if (visibleGuardCount !== null && visibleGuardCount !== beforeCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS comment count changed before submission");
  }
  await invokePointerBounds(target, guardSend, dimensions, options);

  let clearedHierarchy = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const afterHierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(afterHierarchy, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after comment submission");
    }
    let afterCount = null;
    try { afterCount = exactXhsCommentCount(afterHierarchy); } catch {}
    const afterEditor = xhsDraftEditor(afterHierarchy);
    const draftCleared = !afterEditor || xhsEditorToken(afterEditor) === request.expectedEmptyEditorStateHash;
    if (draftCleared) clearedHierarchy = afterHierarchy;
    if (afterCount !== null && afterCount > beforeCount && draftCleared) {
      return {
        machine: target.machine,
        status: "verified",
        beforeCount,
        afterCount,
        verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (draftCleared) break;
    if (attempt < 11) await options.delay(400);
  }
  if (clearedHierarchy) {
    await invokeOfficial("pushEvent", target, { type: "3" }, options);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const afterBackHierarchy = await readUiHierarchy(target, options);
      if (!hierarchyContainsPackage(afterBackHierarchy, XHS_PACKAGE)) {
        throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed while revealing the submitted comment count");
      }
      let afterCount = null;
      try { afterCount = exactXhsCommentCount(afterBackHierarchy); } catch {}
      if (afterCount !== null && afterCount > beforeCount) {
        return {
          machine: target.machine,
          status: "verified",
          beforeCount,
          afterCount,
          verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
          transport: "xiaowei-api",
          localAdbRequired: false,
        };
      }
      try {
        const rules = await loadRules(options.xhsRulesPath);
        const afterBackObservation = observeXhsHierarchy(afterBackHierarchy, rules, { targetAlias: target.alias });
        if (afterBackObservation.page.state === "HOME_FEED") {
          const reopenedHierarchy = await reopenExpectedXhsTarget(target, request.expectedTarget, dimensions, options);
          const reopenedCount = exactXhsCommentCount(reopenedHierarchy);
          if (reopenedCount > beforeCount) {
            return {
              machine: target.machine,
              status: "verified",
              beforeCount,
              afterCount: reopenedCount,
              verification: "expected_draft_and_send_rechecked_then_count_increment_and_draft_clear",
              transport: "xiaowei-api",
              localAdbRequired: false,
            };
          }
          throw new DeviceNodeError("POSTCONDITION_MISS", "Reopened XHS note did not show the expected comment count increment");
        }
      } catch (error) {
        if (error instanceof DeviceNodeError) throw error;
      }
      if (attempt < 7) await options.delay(300);
    }
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "The expected comment was submitted once but count increment and draft clearing were not both verified; submission will not be replayed",
  );
}

async function submitXhsEmojiComment(target, request, options) {
  const dimensions = await readPhysicalDisplaySize(target, options);
  let hierarchy = await readUiHierarchy(target, options);
  if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "xhs.comment-emoji requires Xiaohongshu in the foreground");
  }
  const beforeCount = exactXhsCommentCount(hierarchy);
  let emojiBounds = uniqueXhsControlBounds(hierarchy, request.emoji, { optional: true });

  if (!emojiBounds) {
    const firstBox = uniqueXhsControlBounds(hierarchy, "评论框");
    await options.delay(250);
    const guardHierarchy = await readUiHierarchy(target, options);
    const guardBox = uniqueXhsControlBounds(guardHierarchy, "评论框");
    if (!stableNodeBounds(firstBox, guardBox) || exactXhsCommentCount(guardHierarchy) !== beforeCount) {
      throw new DeviceNodeError("LAYOUT_DRIFT", "XHS comment box changed before activation");
    }
    await invokePointerBounds(target, guardBox, dimensions, options);
    let opened = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      hierarchy = await readUiHierarchy(target, options);
      if (!hierarchyContainsPackage(hierarchy, XHS_PACKAGE)) {
        throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after opening the comment composer");
      }
      emojiBounds = uniqueXhsControlBounds(hierarchy, request.emoji, { optional: true });
      if (emojiBounds && xhsDraftEditor(hierarchy)) {
        opened = true;
        break;
      }
      if (attempt < 7) await options.delay(300);
    }
    if (!opened) {
      throw new DeviceNodeError("POSTCONDITION_MISS", "The comment box was activated once but the emoji composer was not verified");
    }
  }

  const initialEditor = xhsDraftEditor(hierarchy);
  if (!xhsEditorIsEmpty(initialEditor)) {
    throw new Error("xhs.comment-emoji requires one empty comment editor before emoji selection");
  }
  await options.delay(250);
  const emojiGuardHierarchy = await readUiHierarchy(target, options);
  const emojiGuard = uniqueXhsControlBounds(emojiGuardHierarchy, request.emoji);
  const guardEditor = xhsDraftEditor(emojiGuardHierarchy);
  if (!xhsEditorIsEmpty(guardEditor)
      || !stableNodeBounds(emojiBounds, emojiGuard)
      || !stableNodeBounds(initialEditor.bounds, guardEditor.bounds)
      || exactXhsCommentCount(emojiGuardHierarchy) !== beforeCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS emoji composer changed before selection");
  }
  await invokePointerBounds(target, emojiGuard, dimensions, options);

  let draftedHierarchy = "";
  let draftedEditor = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    draftedHierarchy = await readUiHierarchy(target, options);
    draftedEditor = xhsDraftEditor(draftedHierarchy, request.emoji);
    if (draftedEditor) break;
    if (attempt < 7) await options.delay(300);
  }
  if (!draftedEditor) {
    throw new DeviceNodeError("POSTCONDITION_MISS", "The emoji was activated once but the comment draft was not verified");
  }
  const firstSend = uniqueXhsControlBounds(draftedHierarchy, "发送");
  await options.delay(250);
  const sendGuardHierarchy = await readUiHierarchy(target, options);
  const sendGuardEditor = xhsDraftEditor(sendGuardHierarchy, request.emoji);
  const sendGuard = uniqueXhsControlBounds(sendGuardHierarchy, "发送");
  if (!sendGuardEditor || !stableNodeBounds(draftedEditor.bounds, sendGuardEditor.bounds)
      || !stableNodeBounds(firstSend, sendGuard)
      || exactXhsCommentCount(sendGuardHierarchy) !== beforeCount) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "XHS send control or prepared draft changed before submission");
  }
  await invokePointerBounds(target, sendGuard, dimensions, options);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const afterHierarchy = await readUiHierarchy(target, options);
    if (!hierarchyContainsPackage(afterHierarchy, XHS_PACKAGE)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "XHS foreground changed after comment submission");
    }
    let afterCount = null;
    try { afterCount = exactXhsCommentCount(afterHierarchy); } catch {}
    const afterEditor = xhsDraftEditor(afterHierarchy);
    const draftCleared = !afterEditor || xhsEditorIsEmpty(afterEditor)
      || (!semanticValue(afterEditor.node.text).includes(request.emoji)
        && !semanticValue(afterEditor.node.contentDesc).includes(request.emoji));
    if (afterCount !== null && afterCount > beforeCount && draftCleared) {
      return {
        machine: target.machine,
        status: "verified",
        beforeCount,
        afterCount,
        verification: "emoji_selected_then_package_bound_send_then_comment_count_increment_and_draft_clear",
        transport: "xiaowei-api",
        localAdbRequired: false,
      };
    }
    if (attempt < 11) await options.delay(400);
  }
  throw new DeviceNodeError(
    "POSTCONDITION_MISS",
    "The comment was submitted once but count increment and draft clearing were not both verified; submission will not be replayed",
  );
}

function scrollableContainer(hierarchy, expectedPackage) {
  const document = parseUiAutomatorXml(hierarchy);
  const candidates = document.nodes
    .filter((node) => node.scrollable && SAFE_PACKAGE.test(node.packageName)
      && (expectedPackage === undefined || node.packageName === expectedPackage))
    .map((node) => ({ node, bounds: parseBounds(node.attributes?.bounds) }))
    .filter(({ bounds }) => bounds);
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [
    [
      candidate.node.packageName,
      candidate.node.className,
      candidate.node.resourceId || "",
      candidate.bounds.left,
      candidate.bounds.top,
      candidate.bounds.right,
      candidate.bounds.bottom,
    ].join("\u0000"),
    candidate,
  ])).values()]
    .sort((left, right) => right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height
      || left.bounds.top - right.bounds.top || left.bounds.left - right.bounds.left);
  if (!uniqueCandidates.length) throw new Error("device.scroll could not find a scrollable container in the foreground package");
  const largestArea = uniqueCandidates[0].bounds.width * uniqueCandidates[0].bounds.height;
  const tied = uniqueCandidates.filter(({ bounds }) => bounds.width * bounds.height === largestArea);
  if (tied.length > 1) {
    throw new DeviceNodeError("NODE_AMBIGUOUS", "device.scroll found multiple distinct equally sized scrollable containers");
  }
  return uniqueCandidates[0];
}

function sameScrollableContainer(left, right) {
  const sameStableIdentity = left.node.packageName === right.node.packageName
    && left.node.className === right.node.className
    && (left.node.resourceId || "") === (right.node.resourceId || "");
  return sameStableIdentity && stableNodeBounds(left.bounds, right.bounds);
}

function foregroundPackageForPageGesture(hierarchy, expectedPackage) {
  const packages = [...new Set(parseUiAutomatorXml(hierarchy).nodes
    .map((node) => node.packageName)
    .filter((packageName) => SAFE_PACKAGE.test(packageName)))];
  if (expectedPackage !== undefined) {
    if (!packages.includes(expectedPackage)) {
      throw new DeviceNodeError("FOREGROUND_DRIFT", "device.scroll expected foreground package was not verified");
    }
    return expectedPackage;
  }
  if (packages.length !== 1) {
    throw new DeviceNodeError("NODE_AMBIGUOUS", "device.scroll could not derive one foreground package for a horizontal page gesture");
  }
  return packages[0];
}

async function horizontalPageScroll(target, request, deviceDirectory, options) {
  const beforeHierarchy = await readUiHierarchy(target, options);
  const sourcePackage = foregroundPackageForPageGesture(beforeHierarchy, request.package);
  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  if (foregroundPackageForPageGesture(guardHierarchy, sourcePackage) !== sourcePackage) {
    throw new DeviceNodeError("FOREGROUND_DRIFT", "device.scroll foreground package changed before the page gesture");
  }
  const firstScreen = await readScreen(target, deviceDirectory, options, "scroll-horizontal-before-1.png");
  const firstHash = createHash("sha256").update(await readFile(firstScreen.screenshotPath)).digest("hex");
  await options.delay(250);
  let beforeScreen = await readScreen(target, deviceDirectory, options, "scroll-horizontal-before-2.png");
  let beforeHash = createHash("sha256").update(await readFile(beforeScreen.screenshotPath)).digest("hex");
  if (beforeHash !== firstHash) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "device.scroll horizontal source screen changed before the page gesture");
  }
  const eventType = request.direction === "right" ? "8" : "9";
  for (let step = 0; step < request.steps; step += 1) {
    await invokeOfficial("pointerEvent", target, { type: eventType }, options);
    let verified = false;
    let afterScreen;
    let afterHash = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const afterHierarchy = await readUiHierarchy(target, options);
        foregroundPackageForPageGesture(afterHierarchy, sourcePackage);
        afterScreen = await readScreen(target, deviceDirectory, options, `scroll-horizontal-after-${step + 1}-${attempt + 1}.png`);
        afterHash = createHash("sha256").update(await readFile(afterScreen.screenshotPath)).digest("hex");
        if (afterHash !== beforeHash) {
          verified = true;
          break;
        }
      } catch {
        // Horizontal page transitions can briefly expose incomplete UI or screenshots.
      }
      if (attempt < 3) await options.delay(350);
    }
    if (!verified) {
      throw new Error("device.scroll sent one horizontal page event but a fresh screen change was not verified; the event will not be replayed");
    }
    beforeScreen = afterScreen;
    beforeHash = afterHash;
  }
  return {
    machine: target.machine,
    status: "verified",
    direction: request.direction,
    steps: request.steps,
    verification: "foreground_rechecked_then_horizontal_events_then_fresh_screen_change",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

async function scrollDevice(target, request, deviceDirectory, options) {
  if (["left", "right"].includes(request.direction)) {
    return horizontalPageScroll(target, request, deviceDirectory, options);
  }
  let beforeHierarchy = await readUiHierarchy(target, options);
  let beforeTarget = scrollableContainer(beforeHierarchy, request.package);
  await options.delay(250);
  let guardHierarchy = await readUiHierarchy(target, options);
  let guardTarget = scrollableContainer(guardHierarchy, request.package ?? beforeTarget.node.packageName);
  if (!sameScrollableContainer(beforeTarget, guardTarget)) {
    throw new Error("device.scroll target changed between fresh observations");
  }
  const eventType = request.direction === "down" ? "6" : "7";
  for (let step = 0; step < request.steps; step += 1) {
    await invokeOfficial("pointerEvent", target, { type: eventType }, options);
    let changed = false;
    let afterHierarchy = "";
    let afterTarget = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        afterHierarchy = await readUiHierarchy(target, options);
        afterTarget = scrollableContainer(afterHierarchy, guardTarget.node.packageName);
        if (sameScrollableContainer(guardTarget, afterTarget)
            && createNormalizedFingerprint(afterHierarchy).hash !== createNormalizedFingerprint(guardHierarchy).hash) {
          changed = true;
          break;
        }
      } catch {
        // A directional scroll can briefly expose an incomplete hierarchy.
      }
      if (attempt < 9) await options.delay(300);
    }
    if (!changed) {
      throw new Error("device.scroll sent one directional event but a fresh UI change was not verified; the event will not be replayed");
    }
    guardHierarchy = afterHierarchy;
    guardTarget = afterTarget;
  }
  return {
    machine: target.machine,
    status: "verified",
    direction: request.direction,
    steps: request.steps,
    verification: "scrollable_container_rechecked_then_directional_events_then_fresh_ui_change",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

export async function runXiaoweiDeviceRead(request, runtime = {}) {
  if (!plainObject(request) || ![
    "list", "size", "app-list", "ui", "screen", "open-app", "home", "recent", "back", "tap-text", "tap-coords", "tap-ocr", "input", "node-resolve", "node-activate",
    "scroll", "wechat-wallet-balance", "xhs-observe", "xhs-find-video", "xhs-open-visible", "xhs-comment-open", "xhs-comment-input", "xhs-comment-reply-input",
    "xhs-comment-send", "xhs-comment-emoji", "xhs-dm-send",
  ].includes(request.action)
      || !Array.isArray(request.targets) || request.targets.length < 1 || request.targets.length > 32
      || typeof request.outputRoot !== "string" || !request.outputRoot) {
    throw new Error("Xiaowei device-read request is invalid");
  }
  if (request.action === "xhs-find-video") {
    request = {
      ...request,
      maxScrolls: request.maxScrolls ?? XHS_FIND_VIDEO_DEFAULT_MAX_SCROLLS,
      maxDurationMs: request.maxDurationMs ?? XHS_FIND_VIDEO_DEFAULT_MAX_DURATION_MS,
    };
  }
  const allowedKeys = new Set(["action", "outputRoot", "targets"]);
  if (["list", "size"].includes(request.action)) allowedKeys.add("privateEndpoint");
  else allowedKeys.add("endpoint");
  if (["open-app", "tap-text", "tap-coords", "tap-ocr", "input", "node-resolve", "node-activate", "scroll"].includes(request.action)) allowedKeys.add("package");
  if (["tap-text", "tap-ocr"].includes(request.action)) {
    allowedKeys.add("text");
    allowedKeys.add("postcondition");
  }
  if (request.action === "tap-text") {
    allowedKeys.add("match");
    allowedKeys.add("ordinal");
  }
  if (request.action === "tap-coords") {
    allowedKeys.add("x");
    allowedKeys.add("y");
    allowedKeys.add("postcondition");
  }
  if (["node-resolve", "node-activate"].includes(request.action)) allowedKeys.add("selector");
  if (request.action === "node-activate") allowedKeys.add("postcondition");
  if (["input", "xhs-comment-input", "xhs-comment-reply-input"].includes(request.action)) {
    for (const key of ["text", "imeService", "allowTemporaryEnable", "echoVerification"]) allowedKeys.add(key);
  }
  if (request.action === "xhs-comment-input") allowedKeys.add("expectedEditorStateHash");
  if (request.action === "xhs-comment-reply-input") allowedKeys.add("replyOrdinal");
  if (request.action === "xhs-open-visible") allowedKeys.add("ordinal");
  if (request.action === "xhs-find-video") {
    allowedKeys.add("maxScrolls");
    allowedKeys.add("maxDurationMs");
  }
  if (request.action === "xhs-comment-emoji") allowedKeys.add("emoji");
  if (request.action === "xhs-comment-send") {
    allowedKeys.add("expectedDraft");
    allowedKeys.add("expectedBeforeCount");
    allowedKeys.add("expectedTarget");
    allowedKeys.add("expectedEmptyEditorStateHash");
  }
  if (request.action === "xhs-dm-send") allowedKeys.add("expectedDraft");
  if (request.action === "scroll") {
    allowedKeys.add("direction");
    allowedKeys.add("steps");
  }
  exactKeys(request, allowedKeys, `Xiaowei device.${request.action} request`);
  const packageRequiredActions = ["open-app", "tap-coords", "tap-ocr", "input", "node-resolve", "node-activate"];
  if ((packageRequiredActions.includes(request.action)
      && (typeof request.package !== "string" || request.package.length > 255
      || !SAFE_PACKAGE.test(request.package)))
      || (request.action === "scroll" && request.package !== undefined
        && (typeof request.package !== "string" || request.package.length > 255 || !SAFE_PACKAGE.test(request.package)))
      || (request.action === "tap-text" && request.package !== undefined
        && (typeof request.package !== "string" || request.package.length > 255 || !SAFE_PACKAGE.test(request.package)))
      || (![...packageRequiredActions, "scroll", "tap-text"].includes(request.action) && request.package !== undefined)) {
    throw new Error("Xiaowei device-read package request is invalid");
  }
  if (["input", "xhs-comment-input", "xhs-comment-reply-input"].includes(request.action)) {
    if (typeof request.text !== "string" || !request.text || [...request.text].length > 256
        || /[\u0000\r\n]/u.test(request.text) || !SAFE_IME_SERVICE.test(request.imeService)
        || typeof request.allowTemporaryEnable !== "boolean"
        || !["ui_text", "local_ocr"].includes(request.echoVerification)
        || (request.action === "xhs-comment-input"
          && (typeof request.expectedEditorStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(request.expectedEditorStateHash)))) {
      throw new Error(`${request.action === "input" ? "device.input" : request.action === "xhs-comment-input" ? "xhs.comment.input" : "xhs.comment.reply-input"} request is invalid`);
    }
    if (request.action === "xhs-comment-reply-input"
        && (!Number.isSafeInteger(request.replyOrdinal) || request.replyOrdinal < 1 || request.replyOrdinal > 50)) {
      throw new Error("xhs.comment.reply-input request is invalid");
    }
  } else if (request.action === "xhs-dm-send") {
    if (typeof request.expectedDraft !== "string" || !request.expectedDraft
        || [...request.expectedDraft].length > 256 || /[\u0000\r\n]/u.test(request.expectedDraft)) {
      throw new Error("xhs.dm.send request is invalid");
    }
  } else if (["tap-text", "tap-ocr"].includes(request.action)) {
    const postcondition = request.postcondition;
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 1024
        || !plainObject(postcondition) || !(request.action === "tap-ocr" ? ["text"] : ["text", "package", "resource-id"]).includes(postcondition.kind)
        || typeof postcondition.value !== "string" || !postcondition.value.trim() || postcondition.value.length > 1024
        || (request.action === "tap-text" && request.match !== undefined && !["exact", "suffix"].includes(request.match))
        || (request.action === "tap-text" && request.ordinal !== undefined
          && (!Number.isSafeInteger(request.ordinal) || request.ordinal < 1 || request.ordinal > 50))
        || (request.action === "tap-text" && request.match === "suffix" && request.ordinal === undefined)) {
      throw new Error("Xiaowei tap-text request is invalid");
    }
  } else if (request.action === "tap-coords") {
    const postcondition = request.postcondition;
    if (![request.x, request.y].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
        || !plainObject(postcondition) || !["text", "package", "resource-id"].includes(postcondition.kind)
        || typeof postcondition.value !== "string" || !postcondition.value.trim() || postcondition.value.length > 1024
        || /[\u0000-\u001f\u007f]/u.test(postcondition.value)) {
      throw new Error("device.tap-coords request is invalid");
    }
  } else if (request.action === "node-activate") {
    if (!plainObject(request.postcondition) || Object.keys(request.postcondition).length !== 2
        || request.postcondition.kind !== "text" || typeof request.postcondition.value !== "string"
        || !request.postcondition.value.trim() || request.postcondition.value.length > 256
        || /[\u0000-\u001f\u007f]/u.test(request.postcondition.value)) {
      throw new Error("device.node.activate postcondition is invalid");
    }
  } else if (request.text !== undefined || request.postcondition !== undefined || request.expectedEditorStateHash !== undefined) {
    throw new Error("Xiaowei device-read text request is invalid");
  }
  if (["node-resolve", "node-activate"].includes(request.action)) {
    request = { ...request, selector: validateDeviceNodeSelector(request.selector) };
  } else if (request.selector !== undefined) {
    throw new Error("Xiaowei device-read selector request is invalid");
  }
  if (request.action === "xhs-open-visible") {
    if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 1 || request.ordinal > 20) {
      throw new Error("xhs.open-visible ordinal is invalid");
    }
  } else if (request.action !== "tap-text" && request.ordinal !== undefined) {
    throw new Error("Xiaowei device-read ordinal request is invalid");
  }
  if (request.action === "xhs-find-video") {
    if (!Number.isSafeInteger(request.maxScrolls) || request.maxScrolls < 0 || request.maxScrolls > 10
        || !Number.isSafeInteger(request.maxDurationMs) || request.maxDurationMs < 5_000 || request.maxDurationMs > 60_000) {
      throw new Error("xhs.find-video request is invalid");
    }
  }
  if (request.action === "xhs-comment-emoji") {
    if (typeof request.emoji !== "string" || !request.emoji.trim() || [...request.emoji].length > 64
        || /[\u0000-\u001f\u007f]/u.test(request.emoji)) {
      throw new Error("xhs.comment-emoji emoji is invalid");
    }
    request = { ...request, emoji: request.emoji.normalize("NFKC").trim() };
  } else if (request.emoji !== undefined) {
    throw new Error("Xiaowei device-read emoji request is invalid");
  }
  if (request.action === "xhs-comment-send") {
    if (typeof request.expectedDraft !== "string" || !request.expectedDraft
        || [...request.expectedDraft].length > 256 || /[\u0000\r\n]/u.test(request.expectedDraft)
        || !Number.isSafeInteger(request.expectedBeforeCount) || request.expectedBeforeCount < 0
        || request.expectedBeforeCount > 999_999_999
        || typeof request.expectedEmptyEditorStateHash !== "string" || !/^[a-f0-9]{64}$/u.test(request.expectedEmptyEditorStateHash)
        || !plainObject(request.expectedTarget)
        || Object.keys(request.expectedTarget).length !== 3
        || typeof request.expectedTarget.title !== "string" || !request.expectedTarget.title.trim()
        || request.expectedTarget.title.length > 512
        || typeof request.expectedTarget.author !== "string" || !request.expectedTarget.author.trim()
        || request.expectedTarget.author.length > 256
        || !["image", "video"].includes(request.expectedTarget.mediaType)
        || /[\u0000-\u001f\u007f]/u.test(`${request.expectedTarget.title}${request.expectedTarget.author}`)) {
      throw new Error("xhs.comment.send expectedDraft is invalid");
    }
    request = {
      ...request,
      expectedDraft: request.expectedDraft.normalize("NFKC"),
      expectedTarget: {
        title: request.expectedTarget.title.normalize("NFKC").trim(),
        author: request.expectedTarget.author.normalize("NFKC").trim(),
        mediaType: request.expectedTarget.mediaType,
      },
    };
  } else if (request.action === "xhs-dm-send") {
    request = { ...request, expectedDraft: request.expectedDraft.normalize("NFKC") };
  } else if (request.expectedDraft !== undefined || request.expectedBeforeCount !== undefined
      || request.expectedTarget !== undefined || request.expectedEmptyEditorStateHash !== undefined) {
    throw new Error("Xiaowei device-read comment-send binding is invalid");
  }
  if (request.action === "scroll") {
    if (!["down", "up", "left", "right"].includes(request.direction)
        || !Number.isSafeInteger(request.steps) || request.steps < 1 || request.steps > 5) {
      throw new Error("device.scroll request is invalid");
    }
  } else if (request.direction !== undefined || request.steps !== undefined) {
    throw new Error("Xiaowei device-read scroll request is invalid");
  }
  const projectRoot = path.resolve(runtime.projectRoot ?? PROJECT_ROOT);
  const approvedRoot = path.join(projectRoot, "data", "matrix", "runs");
  const outputRoot = path.resolve(request.outputRoot);
  if (!pathInside(approvedRoot, outputRoot)) {
    throw new Error("Xiaowei device-read output must stay under data/matrix/runs");
  }
  const targets = request.targets.map(validateTarget);
  if (new Set(targets.map((target) => target.machine)).size !== targets.length
      || new Set(targets.map((target) => target.alias)).size !== targets.length
      || new Set(targets.map((target) => target.serial)).size !== targets.length) {
    throw new Error("Xiaowei device-read targets must be unique");
  }
  if (request.action === "list") {
    const invokePrivate = runtime.invokePrivateCommand ?? invokeXiaoweiPrivateCommand;
    const response = await invokePrivate("get_device_list", {}, {
      endpoint: request.privateEndpoint,
      ...(runtime.privateOptions ?? {}),
    });
    return buildPublicDeviceList(response.value, targets);
  }
  if (request.action === "size") {
    if (targets.length !== 1) throw new Error("device.size requires exactly one configured machine");
    const target = targets[0];
    if (target.acceptedSerial !== target.serial) {
      throw new Error("Xiaowei device identity acceptance is missing or stale");
    }
    const invokePrivate = runtime.invokePrivateCommand ?? invokeXiaoweiPrivateCommand;
    const response = await invokePrivate("get_size", { serial: target.serial }, {
      endpoint: request.privateEndpoint,
      ...(runtime.privateOptions ?? {}),
    });
    const dimensions = parsePrivateSize(response.value);
    return {
      machine: target.machine,
      ...dimensions,
      transport: "xiaowei-private-api",
      localAdbRequired: false,
    };
  }
  await mkdir(outputRoot, { recursive: true });
  const options = {
    endpoint: request.endpoint,
    sendRequest: runtime.sendRequest ?? sendXiaoweiRequest,
    timeoutMs: runtime.timeoutMs ?? 15_000,
    uiDirectTimeoutMs: runtime.uiDirectTimeoutMs ?? 5_000,
    delay: runtime.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: runtime.now ?? Date.now,
    localOcr: runtime.localOcr ?? createWindowsLocalOcr(),
    cloudVision: runtime.cloudVision ?? requestCloudVision,
    xhsRulesPath: runtime.xhsRulesPath ?? path.join(projectRoot, "config", "xhs-page-rules.json"),
    uiScratchDirectory: outputRoot,
    replyOpenBudgetMs: runtime.replyOpenBudgetMs,
    commentDraftVerifyBudgetMs: runtime.commentDraftVerifyBudgetMs,
    dmVerifyBudgetMs: runtime.dmVerifyBudgetMs,
    dmDegradedEchoBudgetMs: runtime.dmDegradedEchoBudgetMs,
  };
  const results = [];
  if ([
    "app-list", "recent", "back", "tap-coords", "input", "node-resolve", "node-activate", "scroll", "wechat-wallet-balance", "xhs-observe", "xhs-find-video", "xhs-open-visible",
    "xhs-comment-open", "xhs-comment-input", "xhs-comment-reply-input", "xhs-comment-send", "xhs-comment-emoji", "xhs-dm-send",
  ].includes(request.action)) {
    const publicCommand = request.action === "app-list" ? "app.list"
      : request.action === "recent" ? "device.recent"
      : request.action === "back" ? "device.back"
      : request.action === "wechat-wallet-balance" ? "wechat.wallet-balance"
      : request.action === "xhs-observe" ? "xhs.observe"
        : request.action === "xhs-find-video" ? "xhs.find-video"
          : request.action === "xhs-open-visible" ? "xhs.open-visible"
          : request.action === "xhs-comment-emoji" ? "xhs.comment-emoji"
          : request.action === "xhs-comment-open" ? "xhs.comment.open"
          : request.action === "xhs-comment-input" ? "xhs.comment.input"
          : request.action === "xhs-comment-reply-input" ? "xhs.comment.reply-input"
          : request.action === "xhs-comment-send" ? "xhs.comment.send"
          : request.action === "xhs-dm-send" ? "xhs.dm.send"
          : request.action === "tap-coords" ? "device.tap-coords"
          : request.action === "input" ? "device.input"
            : request.action === "scroll" ? "device.scroll"
            : request.action === "node-resolve" ? "device.node.resolve" : "device.node.activate";
    if (targets.length !== 1) throw new Error(`${publicCommand} requires exactly one configured machine`);
    const target = targets[0];
    const deviceDirectory = path.join(outputRoot, target.alias);
    await mkdir(deviceDirectory, { recursive: true });
    const publicResult = request.action === "app-list"
      ? await listApps(target, options)
      : request.action === "recent"
        ? await goRecent(target, options)
      : request.action === "back"
      ? await goBack(target, options)
      : request.action === "tap-coords"
        ? await tapCoordinates(target, request, options)
      : request.action === "input"
      ? await inputDeviceText(target, request, deviceDirectory, options)
      : request.action === "xhs-comment-open"
        ? await openXhsCommentComposer(target, options)
      : request.action === "xhs-comment-input"
        ? await inputXhsCommentDraft(target, request, deviceDirectory, options)
      : request.action === "xhs-comment-reply-input"
        ? await inputXhsReplyDraft(target, request, deviceDirectory, options)
      : request.action === "xhs-comment-send"
        ? await sendXhsCommentDraft(target, request, options)
      : request.action === "xhs-dm-send"
        ? await sendXhsDmDraft(target, request, options)
      : request.action === "scroll"
        ? await scrollDevice(target, request, deviceDirectory, options)
      : request.action === "wechat-wallet-balance"
      ? await readWechatWalletBalance(target, deviceDirectory, options)
      : request.action === "xhs-observe"
        ? await readXhsPublicObservation(target, options)
        : request.action === "xhs-find-video"
          ? await findVisibleXhsVideo(target, request, options)
          : request.action === "xhs-open-visible"
          ? await openVisibleXhsNote(target, request, options)
          : request.action === "xhs-comment-emoji"
            ? await submitXhsEmojiComment(target, request, options)
          : request.action === "node-resolve"
            ? await resolveDeviceNode(target, request, deviceDirectory, options)
            : await activateDeviceNode(target, request, deviceDirectory, options);
    await writeFile(path.join(outputRoot, "result.json"), `${JSON.stringify(publicResult, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return publicResult;
  }
  for (const target of targets) {
    const deviceDirectory = path.join(outputRoot, target.alias);
    await mkdir(deviceDirectory, { recursive: true });
    const publicAction = request.action === "open-app" ? "app.open" : `device.${request.action}`;
    const result = {
      machine: target.machine,
      name: target.name,
      action: publicAction,
      transport: "xiaowei-api",
      localAdbRequired: false,
      status: "success",
    };
    try {
      if (request.action === "ui") Object.assign(result, await readUi(target, deviceDirectory, options));
      if (request.action === "screen") Object.assign(result, await readScreen(target, deviceDirectory, options));
      if (request.action === "open-app") {
        Object.assign(result, await openApp(target, request.package, deviceDirectory, options));
      }
      if (request.action === "home") Object.assign(result, await goHome(target, deviceDirectory, options));
      if (request.action === "tap-text") Object.assign(result, await tapText(target, request, deviceDirectory, options));
      if (request.action === "tap-ocr") Object.assign(result, await tapOcr(target, request, deviceDirectory, options));
    } catch (error) {
      result.status = "failed";
      result.error = String(error?.message ?? "Xiaowei device read failed");
    }
    results.push(result);
  }
  results.sort((left, right) => left.machine.localeCompare(right.machine));
  const summary = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    action: request.action === "open-app" ? "app.open" : `device.${request.action}`,
    transport: "xiaowei-api",
    strategy: request.action === "ui" ? "adb_shell_uiautomator"
      : request.action === "screen" ? "adb_shell_screencap_then_pullFile"
        : request.action === "open-app" ? "apkList_then_startApk_then_ui_verify"
          : request.action === "home" ? "resolve_home_then_pushEvent_then_ui_verify"
            : request.action === "tap-ocr" ? "fresh_screenshot_local_ocr_unique_target_recheck_then_pointerEvent_then_fresh_ocr_verify"
              : "fresh_ui_semantic_target_then_pointerEvent_then_fresh_ui_verify",
    localAdbRequired: false,
    success: results.filter((result) => result.status === "success").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
  await writeFile(path.join(outputRoot, "result.json"), `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return summary;
}

async function readCliRequest(argv) {
  if (argv.length !== 2 || argv[0] !== "--request-file") {
    throw new Error("Usage: node xiaowei-device-read.mjs --request-file <file>");
  }
  const source = await readFile(argv[1]);
  if (source.length > 256 * 1024) throw new Error("Xiaowei device-read request is too large");
  try { return JSON.parse(source.toString("utf8")); } catch { throw new Error("Xiaowei device-read request is not valid JSON"); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readCliRequest(process.argv.slice(2))
    .then((request) => runXiaoweiDeviceRead(request))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.failed) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ error: { message: error.message } })}\n`);
      process.exitCode = 1;
    });
}
