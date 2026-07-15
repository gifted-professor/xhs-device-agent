import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CROP_SCRIPT = fileURLToPath(new URL("./Crop-ImageArtifact.ps1", import.meta.url));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateBounds(bounds) {
  invariant(bounds && typeof bounds === "object" && !Array.isArray(bounds), "valid crop bounds are required");
  const values = [bounds.left, bounds.top, bounds.right, bounds.bottom];
  invariant(values.every(Number.isSafeInteger) && bounds.left >= 0 && bounds.top >= 0 && bounds.right > bounds.left && bounds.bottom > bounds.top, "valid crop bounds are required");
}

function runCropper({ imagePath, bounds }) {
  const outputPath = path.join(os.tmpdir(), `xhs-cpa-crop-${randomUUID()}.png`);
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CROP_SCRIPT,
      "-ImagePath", imagePath, "-OutputPath", outputPath,
      "-CropX", String(bounds.left), "-CropY", String(bounds.top),
      "-CropWidth", String(bounds.right - bounds.left), "-CropHeight", String(bounds.bottom - bounds.top),
    ], { windowsHide: true, timeout: 20_000, encoding: "utf8" }, (error) => {
      if (error) reject(new Error("image crop failed"));
      else resolve(outputPath);
    });
  });
}

function imageMetadata(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    return { mediaType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { mediaType: "image/jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  throw new Error("unsupported or invalid image artifact");
}

export async function createImageArtifact({
  imagePath,
  bounds,
  cropper = runCropper,
  allowFullScreenshot = false,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  invariant(typeof imagePath === "string" && imagePath.length > 0, "image path is required");
  invariant(Number.isSafeInteger(maxImageBytes) && maxImageBytes > 0 && maxImageBytes <= 20 * 1024 * 1024, "image byte limit is invalid");
  let artifactPath = imagePath;
  let temporary = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (temporary) await rm(artifactPath, { force: true });
  };
  try {
    if (bounds !== undefined) {
      validateBounds(bounds);
      artifactPath = await cropper({ imagePath, bounds: structuredClone(bounds) });
      invariant(typeof artifactPath === "string" && artifactPath.length > 0 && path.resolve(artifactPath) !== path.resolve(imagePath), "cropper returned an invalid artifact path");
      temporary = true;
    } else {
      invariant(allowFullScreenshot === true, "valid crop bounds are required before full screenshot fallback");
    }
    const bytes = await readFile(artifactPath);
    invariant(bytes.length > 0 && bytes.length <= maxImageBytes, "image artifact exceeds byte limit");
    const metadata = imageMetadata(bytes);
    invariant(Number.isSafeInteger(metadata.width) && Number.isSafeInteger(metadata.height) && metadata.width > 0 && metadata.height > 0 && metadata.width <= 10000 && metadata.height <= 10000, "image dimensions exceed limits");
    invariant(metadata.width * metadata.height <= 20_000_000, "image dimensions exceed pixel limit");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      artifactId: `artifact-${sha256.slice(0, 16)}`,
      mediaType: metadata.mediaType,
      sha256,
      byteLength: bytes.length,
      width: metadata.width,
      height: metadata.height,
      regionKind: "comment_counter",
      base64: bytes.toString("base64"),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
