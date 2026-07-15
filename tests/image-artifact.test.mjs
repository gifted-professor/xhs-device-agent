import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImageArtifact } from "../scripts/image-artifact.mjs";

function png(width, height, extraBytes = 0) {
  const value = Buffer.alloc(24 + extraBytes);
  Buffer.from("89504e470d0a1a0a", "hex").copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

async function temporaryFile(name, bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-artifact-"));
  const file = path.join(root, name);
  await writeFile(file, bytes);
  return { root, file };
}

test("bounded PNG becomes a strict hash-bound artifact without exposing its path", async () => {
  const source = await temporaryFile("screen.png", png(320, 80));
  const value = await createImageArtifact({ imagePath: source.file, allowFullScreenshot: true });
  assert.equal(value.mediaType, "image/png");
  assert.equal(value.width, 320);
  assert.equal(value.height, 80);
  assert.equal(value.byteLength, 24);
  assert.match(value.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(value.artifactId, `artifact-${value.sha256.slice(0, 16)}`);
  assert.equal(JSON.stringify(value).includes(source.file), false);
  assert.deepEqual(Buffer.from(value.base64, "base64"), await readFile(source.file));
  await value.cleanup();
});

test("crop is the default and temporary artifacts are cleaned on success", async () => {
  const source = await temporaryFile("screen.png", png(1080, 2400));
  const crop = path.join(source.root, "crop.png");
  let calls = 0;
  const value = await createImageArtifact({
    imagePath: source.file,
    bounds: { left: 10, top: 20, right: 210, bottom: 100 },
    cropper: async (request) => {
      calls += 1;
      assert.deepEqual(request.bounds, { left: 10, top: 20, right: 210, bottom: 100 });
      await writeFile(crop, png(200, 80));
      return crop;
    },
  });
  assert.equal(calls, 1);
  assert.equal(value.width, 200);
  assert.equal(value.height, 80);
  await value.cleanup();
  await assert.rejects(() => readFile(crop), /ENOENT/u);
});

test("full screenshot fallback is explicit and invalid crop requests fail closed", async () => {
  const source = await temporaryFile("screen.png", png(100, 100));
  await assert.rejects(() => createImageArtifact({ imagePath: source.file }), /crop bounds/u);
  await assert.rejects(() => createImageArtifact({ imagePath: source.file, bounds: { left: 1, top: 1, right: 1, bottom: 2 } }), /crop bounds/u);
});

test("bad magic, excessive dimensions, and image byte overflow are rejected", async () => {
  const invalid = await temporaryFile("bad.png", Buffer.from("not-an-image"));
  const dimensions = await temporaryFile("huge.png", png(10001, 10));
  const bytes = await temporaryFile("bytes.png", png(10, 10, 64));
  await assert.rejects(() => createImageArtifact({ imagePath: invalid.file, allowFullScreenshot: true }), /image/u);
  await assert.rejects(() => createImageArtifact({ imagePath: dimensions.file, allowFullScreenshot: true }), /dimensions/u);
  await assert.rejects(() => createImageArtifact({ imagePath: bytes.file, allowFullScreenshot: true, maxImageBytes: 24 }), /byte limit/u);
});

test("crop output is cleaned when validation fails", async () => {
  const source = await temporaryFile("screen.png", png(100, 100));
  const crop = path.join(source.root, "bad-crop.png");
  await assert.rejects(() => createImageArtifact({
    imagePath: source.file,
    bounds: { left: 0, top: 0, right: 20, bottom: 20 },
    cropper: async () => { await writeFile(crop, Buffer.from("bad")); return crop; },
  }), /image/u);
  await assert.rejects(() => readFile(crop), /ENOENT/u);
});
