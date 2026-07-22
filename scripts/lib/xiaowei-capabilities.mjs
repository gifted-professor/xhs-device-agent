import { readFileSync } from "node:fs";

const inventoryUrl = new URL("../../docs/xiaowei/capability-inventory.json", import.meta.url);

const REQUIRED_CAPABILITY_FIELDS = [
  "id", "domain", "uiLabels", "vendorActions", "sources", "availability", "maturity",
  "testOrder", "typedApi", "rawLabApi", "requestSchema", "responseSchema", "verification",
  "restoration", "timeoutMs", "versionRange",
];
const MATURITY = new Set(["D0", "D1", "D2", "D3", "D4", "D5"]);
const TEST_ORDER = new Set(["S0", "S1", "S2", "S3", "S4"]);
const SCHEMA_FIELDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum", "minimum",
  "maximum", "minLength", "maxLength", "description", "default", "nullable",
]);

function assertSchema(schema, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`${path} must be an object`);
  }
  for (const field of Object.keys(schema)) {
    if (!SCHEMA_FIELDS.has(field)) throw new TypeError(`${path} unknown schema field: ${field}`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      throw new TypeError(`${path}.properties must be an object`);
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      assertSchema(child, `${path}.properties.${name}`);
    }
  }
  if (schema.items !== undefined) assertSchema(schema.items, `${path}.items`);
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new TypeError(`${path}.required must be an array`);
  }
}

export function validateInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.capabilities)) {
    throw new TypeError("inventory.capabilities must be an array");
  }

  const ids = new Set();
  for (const capability of inventory.capabilities) {
    for (const field of REQUIRED_CAPABILITY_FIELDS) {
      if (!Object.hasOwn(capability, field)) throw new TypeError(`${capability.id || "<missing-id>"} missing ${field}`);
    }
    if (typeof capability.id !== "string" || capability.id.length === 0) throw new TypeError("capability id is required");
    if (ids.has(capability.id)) throw new TypeError(`duplicate capability ID: ${capability.id}`);
    ids.add(capability.id);
    if (!MATURITY.has(capability.maturity)) throw new TypeError(`${capability.id} invalid maturity`);
    if (!TEST_ORDER.has(capability.testOrder)) throw new TypeError(`${capability.id} invalid testOrder`);
    if (!Array.isArray(capability.vendorActions)) throw new TypeError(`${capability.id} vendorActions must be an array`);
    const actions = new Set();
    for (const action of capability.vendorActions) {
      if (actions.has(action)) throw new TypeError(`${capability.id} duplicate vendor action: ${action}`);
      actions.add(action);
    }
    if (typeof capability.verification !== "string" || capability.verification.length === 0) {
      throw new TypeError(`${capability.id} verification is required`);
    }
    if (typeof capability.restoration !== "string" || capability.restoration.length === 0) {
      throw new TypeError(`${capability.id} restoration is required`);
    }
    assertSchema(capability.requestSchema, `${capability.id}.requestSchema`);
    assertSchema(capability.responseSchema, `${capability.id}.responseSchema`);
  }
  return inventory;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildCapabilityRegistry(inventory) {
  validateInventory(inventory);
  return deepFreeze(inventory.capabilities.map((capability) => structuredClone(capability)));
}

export const INVENTORY = deepFreeze(JSON.parse(readFileSync(inventoryUrl, "utf8")));
export const CAPABILITIES = buildCapabilityRegistry(INVENTORY);

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

export function createPublicManifest(inventory = INVENTORY) {
  const capabilities = buildCapabilityRegistry(inventory).map((capability) => ({
    id: capability.id,
    domain: capability.domain,
    uiLabels: capability.uiLabels,
    availability: capability.availability,
    maturity: capability.maturity,
    testOrder: capability.testOrder,
    typedApi: capability.typedApi,
    rawLabApi: capability.rawLabApi,
    requestSchema: capability.requestSchema,
    responseSchema: capability.responseSchema,
    timeoutMs: capability.timeoutMs,
    risk: capability.risk || capability.testOrder,
    requirements: capability.requirements || [],
    verification: capability.verification,
    restoration: capability.restoration,
    examples: capability.examples || [],
  }));

  return {
    version: inventory.schemaVersion,
    product: {
      name: inventory.product.name,
      observedVersion: inventory.product.observedVersion,
    },
    capabilities,
  };
}
