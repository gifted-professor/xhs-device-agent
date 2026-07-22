import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { XiaoweiRawService } from "./lib/xiaowei-raw-service.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";

function extractClipboard(response) {
  const entries = Object.values(response?.vendorResponse?.data || {});
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object") {
    throw new Error("unexpected getClipboard response shape");
  }
  return entries[0].data;
}

export async function runClipboardCanary({
  service = new XiaoweiRawService({ transport: new XiaoweiTransport() }),
  deviceAlias = "01",
  probe = `codex-xiaowei-probe-${randomUUID()}`,
} = {}) {
  const originalResponse = await service.invokeRaw({ deviceAlias, action: "getClipboard" });
  const original = extractClipboard(originalResponse);
  if (typeof original !== "string") throw new Error("clipboard canary requires a restorable string baseline");

  let writeAccepted = false;
  try {
    const write = await service.invokeRaw({ deviceAlias, action: "writeClipboard", data: { data: probe } });
    writeAccepted = write.vendorResponse?.code === 10000;
    const verify = extractClipboard(await service.invokeRaw({ deviceAlias, action: "getClipboard" }));
    if (verify !== probe) throw new Error("writeClipboard was accepted but clipboard readback did not match");
  } finally {
    if (writeAccepted) {
      await service.invokeRaw({ deviceAlias, action: "writeClipboard", data: { data: original } });
    }
  }

  const restored = extractClipboard(await service.invokeRaw({ deviceAlias, action: "getClipboard" }));
  if (restored !== original) throw new Error("clipboard restoration readback did not match baseline");
  return { ok: true, field: "data", writeVerified: true, restorationVerified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClipboardCanary()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
