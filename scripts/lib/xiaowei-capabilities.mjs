import { readFileSync } from "node:fs";

const inventoryUrl = new URL("../../docs/xiaowei/capability-inventory.json", import.meta.url);

export const INVENTORY = Object.freeze(JSON.parse(readFileSync(inventoryUrl, "utf8")));
export const CAPABILITIES = Object.freeze(
  INVENTORY.capabilities.map((capability) => Object.freeze(capability)),
);

export function getCapability(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}

export function summarizeCapabilities() {
  const summary = {
    total: CAPABILITIES.length,
    typed: 0,
    rawLab: 0,
    byMaturity: {},
    byTestOrder: {},
    byAvailability: {},
  };

  for (const capability of CAPABILITIES) {
    if (capability.typedApi) summary.typed += 1;
    if (capability.rawLabApi) summary.rawLab += 1;
    summary.byMaturity[capability.maturity] = (summary.byMaturity[capability.maturity] || 0) + 1;
    summary.byTestOrder[capability.testOrder] = (summary.byTestOrder[capability.testOrder] || 0) + 1;
    summary.byAvailability[capability.availability] = (summary.byAvailability[capability.availability] || 0) + 1;
  }

  return summary;
}
