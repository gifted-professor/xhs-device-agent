import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeXiaoweiResponse, sendXiaoweiRequest } from "./xiaowei-transport.mjs";
import { invokeXiaoweiPrivateCommand } from "./xiaowei-private-api.mjs";
import { createWindowsLocalOcr } from "./local-ocr.mjs";
import {
  DeviceNodeError,
  inferHorizontalOrdinalBounds,
  publicNodeDescription,
  stableNodeBounds,
  validateDeviceNodeSelector,
} from "./device-node-engine.mjs";
import { loadRules, parseUiAutomatorXml } from "./xhs-page-engine.mjs";
import { intersectXhsObservations, observeXhsHierarchy, resolveVisibleXhsNote } from "./xhs-public-observation.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SAFE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const SAFE_MACHINE = /^\d{2}$/u;
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u;
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
    throw new Error("Xiaowei UI response did not contain a complete hierarchy");
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

async function invokeOfficial(action, target, data, options) {
  let raw;
  try {
    raw = await options.sendRequest({ action, devices: target.serial, data }, {
      endpoint: options.endpoint,
      timeoutMs: options.timeoutMs,
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
  const data = await invokeOfficial("adb_shell", target, { command: "uiautomator dump /dev/tty" }, options);
  return extractUiHierarchy(extractSingleDeviceValue(data));
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

export function findSemanticTapPoint(hierarchy, label, displaySize) {
  const document = parseUiAutomatorXml(hierarchy);
  const expected = semanticValue(label);
  const candidates = document.nodes
    .filter((node) => semanticValue(node.text) === expected || semanticValue(node.contentDesc) === expected)
    .map((node) => actionableAncestor(document, node))
    .filter(Boolean);
  if (!candidates.length) throw new Error(`Control ${expected} was not found in the fresh UI hierarchy`);
  const allBounds = document.nodes.map((node) => parseBounds(node.attributes?.bounds)).filter(Boolean);
  const width = displaySize?.width ?? Math.max(0, ...allBounds.map((bounds) => bounds.right));
  const height = displaySize?.height ?? Math.max(0, ...allBounds.map((bounds) => bounds.bottom));
  if (!width || !height) throw new Error("Fresh UI hierarchy did not expose valid display bounds");
  candidates.sort((left, right) =>
    (left.bounds.width * left.bounds.height) - (right.bounds.width * right.bounds.height)
    || right.bounds.top - left.bounds.top
    || left.bounds.left - right.bounds.left);
  const bounds = candidates[0].bounds;
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
  const beforePath = path.join(deviceDirectory, "tap-before.xml");
  const beforePersistence = await writeAtomic(beforePath, before, options);
  const displaySize = await readPhysicalDisplaySize(target, options);
  const point = findSemanticTapPoint(before, request.text, displaySize);
  await invokeOfficial("pointerEvent", target, { type: "10", x: point.x, y: point.y }, options);

  let after = "";
  let verified = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    after = await readUiHierarchy(target, options);
    if (hierarchyMatchesPostcondition(after, request.postcondition)) {
      verified = true;
      break;
    }
    if (attempt < 5) await options.delay(400);
  }
  const afterPath = path.join(deviceDirectory, "tap-after.xml");
  const afterPersistence = await writeAtomic(afterPath, after, options);
  if (!verified) {
    throw new Error("Tap was sent once but the approved postcondition was not verified; the tap will not be replayed");
  }
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

function uniqueSemanticBounds(hierarchy, label, dimensions) {
  const document = parseUiAutomatorXml(hierarchy);
  const expected = semanticValue(label);
  const candidates = document.nodes
    .filter((node) => semanticValue(node.text) === expected || semanticValue(node.contentDesc) === expected)
    .map((node) => actionableAncestor(document, node))
    .filter(Boolean)
    .map(({ bounds }) => bounds)
    .filter((bounds) => bounds.right <= dimensions.width && bounds.bottom <= dimensions.height);
  const unique = [...new Map(candidates.map((bounds) => [
    `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`, bounds,
  ])).values()];
  if (unique.length > 1) throw new DeviceNodeError("NODE_AMBIGUOUS", "Accessibility exposed multiple exact nodes");
  return unique[0] ?? null;
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
  for (const source of request.selector.sources) {
    if (source === "accessibility") {
      const bounds = uniqueSemanticBounds(hierarchy, request.selector.label, dimensions);
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
    } else {
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
    }
  }
  throw new DeviceNodeError(
    ocrMiss ? "OCR_MISS" : "NODE_NOT_FOUND",
    "No configured source resolved one unique node",
  );
}

async function screenshotContainsText(observation, value, options) {
  if (hierarchyMatchesPostcondition(observation.hierarchy, { kind: "text", value })) return true;
  const located = await locateText(
    options, observation.screen.screenshotPath, value, "postcondition", observation.dimensions,
    { allowMissing: true, requireStable: false },
  );
  return Boolean(located);
}

async function resolveDeviceNode(target, request, deviceDirectory, options) {
  const first = await nodeObservation(target, request, deviceDirectory, options, "node-resolve-before");
  await options.delay(250);
  const guard = await nodeObservation(target, request, deviceDirectory, options, "node-resolve-guard");
  if (first.source !== guard.source || !stableNodeBounds(first.bounds, guard.bounds)) {
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
  if (first.source !== guard.source || !stableNodeBounds(first.bounds, guard.bounds)) {
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

function samePublicNoteIdentity(left, right) {
  return left?.title === right?.title && left?.author === right?.author && left?.mediaType === right?.mediaType;
}

async function openVisibleXhsNote(target, request, options) {
  const rules = await loadRules(options.xhsRulesPath);
  const displaySize = await readPhysicalDisplaySize(target, options);
  const firstHierarchy = await readUiHierarchy(target, options);
  const firstObservation = observeXhsHierarchy(firstHierarchy, rules, { targetAlias: target.alias });
  if (firstObservation.page.state !== "HOME_FEED") {
    throw new Error("xhs.open-visible requires the Xiaohongshu home feed");
  }
  const firstTarget = resolveVisibleXhsNote(firstHierarchy, request.ordinal, displaySize);
  await options.delay(250);
  const guardHierarchy = await readUiHierarchy(target, options);
  const guardObservation = observeXhsHierarchy(guardHierarchy, rules, { targetAlias: target.alias });
  const guardTarget = resolveVisibleXhsNote(guardHierarchy, request.ordinal, displaySize);
  if (guardObservation.page.state !== "HOME_FEED" || !samePublicNoteIdentity(firstTarget.note, guardTarget.note)) {
    throw new Error("XHS visible note changed before the single pointer event");
  }

  await invokeOfficial("pointerEvent", target, { type: "10", ...guardTarget.point }, options);
  let detailObservation = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const hierarchy = await readUiHierarchy(target, options);
      const observation = observeXhsHierarchy(hierarchy, rules, { targetAlias: target.alias });
      if (["IMAGE_NOTE", "VIDEO_NOTE"].includes(observation.page.state)) {
        detailObservation = observation;
        break;
      }
    } catch {
      // A page transition can briefly expose an incomplete hierarchy.
    }
    if (attempt < 7) await options.delay(400);
  }
  if (!detailObservation) {
    throw new Error("XHS note was tapped once but a detail page was not verified; the tap will not be replayed");
  }
  await options.delay(300);
  const secondHierarchy = await readUiHierarchy(target, options);
  const secondObservation = observeXhsHierarchy(secondHierarchy, rules, { targetAlias: target.alias });
  const stable = intersectXhsObservations(detailObservation, secondObservation);
  if (!stable.detail) throw new Error("XHS detail metadata was not stable across two fresh UI reads");
  return {
    machine: target.machine,
    selected: {
      ordinal: request.ordinal,
      title: guardTarget.note.title,
      author: guardTarget.note.author,
      mediaType: guardTarget.note.mediaType,
    },
    ...stable,
    verification: "single_pointer_event_then_two_fresh_detail_ui_reads",
    transport: "xiaowei-api",
    localAdbRequired: false,
  };
}

export async function runXiaoweiDeviceRead(request, runtime = {}) {
  if (!plainObject(request) || ![
    "list", "size", "ui", "screen", "open-app", "home", "tap-text", "tap-ocr", "node-resolve", "node-activate",
    "wechat-wallet-balance", "xhs-observe", "xhs-open-visible",
  ].includes(request.action)
      || !Array.isArray(request.targets) || request.targets.length < 1 || request.targets.length > 32
      || typeof request.outputRoot !== "string" || !request.outputRoot) {
    throw new Error("Xiaowei device-read request is invalid");
  }
  const allowedKeys = new Set(["action", "outputRoot", "targets"]);
  if (["list", "size"].includes(request.action)) allowedKeys.add("privateEndpoint");
  else allowedKeys.add("endpoint");
  if (["open-app", "tap-ocr", "node-resolve", "node-activate"].includes(request.action)) allowedKeys.add("package");
  if (["tap-text", "tap-ocr"].includes(request.action)) {
    allowedKeys.add("text");
    allowedKeys.add("postcondition");
  }
  if (["node-resolve", "node-activate"].includes(request.action)) allowedKeys.add("selector");
  if (request.action === "node-activate") allowedKeys.add("postcondition");
  if (request.action === "xhs-open-visible") allowedKeys.add("ordinal");
  exactKeys(request, allowedKeys, `Xiaowei device.${request.action} request`);
  if ((["open-app", "tap-ocr", "node-resolve", "node-activate"].includes(request.action)
      && (typeof request.package !== "string" || request.package.length > 255
      || !SAFE_PACKAGE.test(request.package)))
      || (!["open-app", "tap-ocr", "node-resolve", "node-activate"].includes(request.action) && request.package !== undefined)) {
    throw new Error("Xiaowei device-read package request is invalid");
  }
  if (["tap-text", "tap-ocr"].includes(request.action)) {
    const postcondition = request.postcondition;
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 1024
        || !plainObject(postcondition) || !(request.action === "tap-ocr" ? ["text"] : ["text", "package", "resource-id"]).includes(postcondition.kind)
        || typeof postcondition.value !== "string" || !postcondition.value.trim() || postcondition.value.length > 1024) {
      throw new Error("Xiaowei tap-text request is invalid");
    }
  } else if (request.action === "node-activate") {
    if (!plainObject(request.postcondition) || Object.keys(request.postcondition).length !== 2
        || request.postcondition.kind !== "text" || typeof request.postcondition.value !== "string"
        || !request.postcondition.value.trim() || request.postcondition.value.length > 256
        || /[\u0000-\u001f\u007f]/u.test(request.postcondition.value)) {
      throw new Error("device.node.activate postcondition is invalid");
    }
  } else if (request.text !== undefined || request.postcondition !== undefined) {
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
  } else if (request.ordinal !== undefined) {
    throw new Error("Xiaowei device-read ordinal request is invalid");
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
    delay: runtime.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    localOcr: runtime.localOcr ?? createWindowsLocalOcr(),
    xhsRulesPath: runtime.xhsRulesPath ?? path.join(projectRoot, "config", "xhs-page-rules.json"),
  };
  const results = [];
  if (["node-resolve", "node-activate", "wechat-wallet-balance", "xhs-observe", "xhs-open-visible"].includes(request.action)) {
    const publicCommand = request.action === "wechat-wallet-balance" ? "wechat.wallet-balance"
      : request.action === "xhs-observe" ? "xhs.observe"
        : request.action === "xhs-open-visible" ? "xhs.open-visible"
          : request.action === "node-resolve" ? "device.node.resolve" : "device.node.activate";
    if (targets.length !== 1) throw new Error(`${publicCommand} requires exactly one configured machine`);
    const target = targets[0];
    const deviceDirectory = path.join(outputRoot, target.alias);
    await mkdir(deviceDirectory, { recursive: true });
    const publicResult = request.action === "wechat-wallet-balance"
      ? await readWechatWalletBalance(target, deviceDirectory, options)
      : request.action === "xhs-observe"
        ? await readXhsPublicObservation(target, options)
        : request.action === "xhs-open-visible"
          ? await openVisibleXhsNote(target, request, options)
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
