import { pathToFileURL } from "node:url";

import { XiaoweiRawService } from "./lib/xiaowei-raw-service.mjs";
import { XiaoweiTransport } from "./lib/xiaowei-transport.mjs";

export const DEFAULT_READ_ONLY_CANDIDATES = Object.freeze([
  "apkList",
  "imeList",
  "actionTask.list",
  "autojsTask.list",
]);

export function summarizeProbeData(data) {
  const ownKeys = data && typeof data === "object" ? Object.keys(data) : [];
  return {
    dataType: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
    itemCount: Array.isArray(data) ? data.length : null,
    topLevelKeyCount: ownKeys.length,
    nestedArrayCounts: ownKeys
      .slice(0, 16)
      .map((key) => Array.isArray(data[key]) ? data[key].length : null)
      .filter(Number.isInteger),
  };
}

export async function probeReadOnlyCandidates({
  service = new XiaoweiRawService({ transport: new XiaoweiTransport() }),
  deviceAlias = "01",
  actions = DEFAULT_READ_ONLY_CANDIDATES,
} = {}) {
  const results = [];
  for (const action of actions) {
    try {
      const result = await service.invokeRaw({ deviceAlias, action });
      results.push({
        action,
        ok: true,
        vendorCode: result.vendorResponse?.code ?? null,
        ...summarizeProbeData(result.vendorResponse?.data),
      });
    } catch (error) {
      results.push({
        action,
        ok: false,
        errorCode: error?.code || error?.name || "Error",
        vendorCode: error?.details?.response?.code ?? null,
        vendorMessage: error?.details?.response?.message ?? null,
      });
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeReadOnlyCandidates()
    .then((results) => console.log(JSON.stringify(results, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
