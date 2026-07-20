function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function typeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

export function schemaErrors(schema, value, location = "$") {
  const errors = [];
  const visit = (currentSchema, currentValue, currentLocation) => {
    const declaredTypes = currentSchema.type === undefined
      ? null
      : Array.isArray(currentSchema.type) ? currentSchema.type : [currentSchema.type];
    if (declaredTypes && !declaredTypes.some((type) => typeMatches(type, currentValue))) {
      errors.push(`${currentLocation}: expected ${declaredTypes.join(" or ")}`);
      return;
    }

    if (Object.hasOwn(currentSchema, "const") && !Object.is(currentValue, currentSchema.const)) {
      errors.push(`${currentLocation}: does not equal const`);
    }
    if (currentSchema.enum && !currentSchema.enum.some((candidate) => Object.is(candidate, currentValue))) {
      errors.push(`${currentLocation}: not in enum`);
    }

    if (typeof currentValue === "string") {
      if (currentSchema.minLength !== undefined && [...currentValue].length < currentSchema.minLength) {
        errors.push(`${currentLocation}: shorter than minLength`);
      }
      if (currentSchema.maxLength !== undefined && [...currentValue].length > currentSchema.maxLength) {
        errors.push(`${currentLocation}: longer than maxLength`);
      }
      if (currentSchema.pattern !== undefined && !(new RegExp(currentSchema.pattern, "u")).test(currentValue)) {
        errors.push(`${currentLocation}: does not match pattern`);
      }
    }

    if (typeof currentValue === "number") {
      if (currentSchema.minimum !== undefined && currentValue < currentSchema.minimum) {
        errors.push(`${currentLocation}: below minimum`);
      }
      if (currentSchema.maximum !== undefined && currentValue > currentSchema.maximum) {
        errors.push(`${currentLocation}: above maximum`);
      }
    }

    if (Array.isArray(currentValue)) {
      if (currentSchema.minItems !== undefined && currentValue.length < currentSchema.minItems) {
        errors.push(`${currentLocation}: fewer than minItems`);
      }
      if (currentSchema.maxItems !== undefined && currentValue.length > currentSchema.maxItems) {
        errors.push(`${currentLocation}: more than maxItems`);
      }
      if (currentSchema.uniqueItems) {
        const normalized = currentValue.map(stableValue);
        if (new Set(normalized).size !== normalized.length) errors.push(`${currentLocation}: items are not unique`);
      }
      if (currentSchema.items) {
        currentValue.forEach((item, index) => visit(currentSchema.items, item, `${currentLocation}[${index}]`));
      }
    }

    if (currentValue !== null && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      for (const required of currentSchema.required ?? []) {
        if (!Object.hasOwn(currentValue, required)) errors.push(`${currentLocation}.${required}: required`);
      }
      const properties = currentSchema.properties ?? {};
      if (currentSchema.additionalProperties === false) {
        for (const key of Object.keys(currentValue)) {
          if (!Object.hasOwn(properties, key)) errors.push(`${currentLocation}.${key}: additional property`);
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (Object.hasOwn(currentValue, key)) visit(propertySchema, currentValue[key], `${currentLocation}.${key}`);
      }
    }
  };

  visit(schema, value, location);
  return errors;
}

export function assertSchemaValid(assert, schema, value, message = "value must match schema") {
  const errors = schemaErrors(schema, value);
  assert.deepEqual(errors, [], `${message}:\n${errors.join("\n")}`);
}
