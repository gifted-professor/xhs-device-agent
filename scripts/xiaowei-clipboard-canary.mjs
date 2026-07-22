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
  candidateFields = ["content", "text", "data"],
} = {}) {
  const originalResponse = await service.invokeRaw({ deviceAlias, action: "getClipboard" });
  const original = extractClipboard(originalResponse);
  if (typeof original !== "string") throw new Error("clipboard canary requires a restorable string baseline");

  for (const field of candidateFields) {
    const write = await service.invokeRaw({ deviceAlias, action: "writeClipboard", data: { [field]: probe } });
    const writeAccepted = write.vendorResponse?.code === 10000;
    const verify = extractClipboard(await service.invokeRaw({ deviceAlias, action: "getClipboard" }));
    if (writeAccepted) {
      await service.invokeRaw({ deviceAlias, action: "writeClipboard", data: { [field]: original } });
    }
    const restored = extractClipboard(await service.invokeRaw({ deviceAlias, action: "getClipboard" }));
    if (restored !== original) {
      throw new Error(`clipboard restoration failed while probing field ${field}`);
    }
    if (verify === probe) {
      return { ok: true, field, writeVerified: true, restorationVerified: true };
    }
  }
  throw new Error("writeClipboard accepted all candidate fields but none changed readback");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runClipboardCanary()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
