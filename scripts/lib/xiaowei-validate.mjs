import { XiaoweiError } from "./xiaowei-errors.mjs";

function fail(message, details = {}) {
  throw new XiaoweiError("XIAOWEI_INVALID_PARAMETERS", message, details);
}

function validateValue(value, schema, path) {
  if (value === null && schema.nullable) return value;
  if (schema.enum && !schema.enum.includes(value)) fail(`${path} must be one of: ${schema.enum.join(", ")}`, { path });

  if (schema.type === "string") {
    if (typeof value !== "string") fail(`${path} must be a string`, { path });
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`${path} is too short`, { path });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`${path} is too long`, { path });
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) fail(`${path} must be an integer`, { path });
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} must be >= ${schema.minimum}`, { path });
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} must be <= ${schema.maximum}`, { path });
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`, { path });
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${path} must be >= ${schema.minimum}`, { path });
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${path} must be <= ${schema.maximum}`, { path });
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(`${path} must be a boolean`, { path });
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail(`${path} must be an array`, { path });
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`));
  } else if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`, { path });
    validateObject(value, schema, path);
  }
  return value;
}

function validateObject(value, schema, path) {
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) fail(`missing required parameter: ${path === "params" ? key : `${path}.${key}`}`, { path: key });
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) fail(`unknown parameter: ${path === "params" ? key : `${path}.${key}`}`, { path: key });
    validateValue(item, properties[key], path === "params" ? key : `${path}.${key}`);
  }
  return value;
}

export function validateCapabilityParams(capability, params = {}) {
  if (!capability || typeof capability !== "object") fail("capability is required");
  if (!params || typeof params !== "object" || Array.isArray(params)) fail("params must be an object");
  const schema = capability.requestSchema || { type: "object", properties: {} };
  if (schema.type !== "object") fail("capability request schema must be an object");
  validateObject(params, schema, "params");
  return structuredClone(params);
}
