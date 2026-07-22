import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

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
