import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyStableFile(path, { settleMs = 250 } = {}) {
  const first = await stat(path);
  if (!first.isFile() || first.size <= 0) throw new Error("screen capture is missing or empty");
  await wait(settleMs);
  const second = await stat(path);
  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) throw new Error("screen capture file is still changing");
  const bytes = await readFile(path);
  return {
    status: "verified",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function snapshotCaptureTarget(path) {
  try {
    const current = await stat(path);
    if (!current.isDirectory()) return { kind: "file" };
    return { kind: "directory", names: new Set(await readdir(path)) };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

export async function verifyCaptureOutput(path, before, { settleMs = 250 } = {}) {
  const current = await stat(path);
  if (current.isFile()) return verifyStableFile(path, { settleMs });
  if (!current.isDirectory()) throw new Error("screen capture target is neither a file nor directory");

  const previous = before?.kind === "directory" ? before.names : new Set();
  const candidates = [];
  for (const name of await readdir(path)) {
    if (previous.has(name)) continue;
    const candidatePath = `${path.replace(/[\\/]$/, "")}/${name}`;
    const candidate = await stat(candidatePath);
    if (candidate.isFile() && candidate.size > 0) candidates.push({ path: candidatePath, mtimeMs: candidate.mtimeMs });
  }
  if (candidates.length === 0) throw new Error("screen capture did not create a new file");
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return verifyStableFile(candidates[0].path, { settleMs });
}
