const SAFE_ROLES = new Set(["control", "tab", "button", "item"]);
const SAFE_SOURCES = new Set(["accessibility", "ocr", "relation", "vision"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains an unsupported field: ${unknown[0]}`);
}

function cleanText(value, label, maximum = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.normalize("NFKC").trim();
}

function ordinal(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 12) throw new Error(`${label} is invalid`);
  return value;
}

export class DeviceNodeError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "DeviceNodeError";
    this.code = code;
  }
}

export function validateDeviceNodeSelector(value) {
  exactKeys(value, new Set(["label", "role", "sources", "relation", "visionPrompt"]), "selector");
  const label = cleanText(value.label, "selector.label");
  if (!SAFE_ROLES.has(value.role)) throw new Error("selector.role is invalid");
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > SAFE_SOURCES.size
      || value.sources.some((source) => !SAFE_SOURCES.has(source))
      || new Set(value.sources).size !== value.sources.length) {
    throw new Error("selector.sources is invalid");
  }

  let relation;
  if (value.sources.includes("relation")) {
    exactKeys(value.relation, new Set(["algorithm", "region", "anchors", "targetOrdinal"]), "selector.relation");
    if (value.relation.algorithm !== "horizontal_equal_spacing"
        || value.relation.region !== "bottom_navigation"
        || !Array.isArray(value.relation.anchors) || value.relation.anchors.length !== 2) {
      throw new Error("selector.relation is invalid");
    }
    const anchors = value.relation.anchors.map((anchor, index) => {
      exactKeys(anchor, new Set(["label", "ordinal"]), `selector.relation.anchors[${index}]`);
      return {
        label: cleanText(anchor.label, `selector.relation.anchors[${index}].label`),
        ordinal: ordinal(anchor.ordinal, `selector.relation.anchors[${index}].ordinal`),
      };
    });
    if (anchors[0].label === anchors[1].label || anchors[0].ordinal === anchors[1].ordinal) {
      throw new Error("selector.relation anchors must be distinct");
    }
    anchors.sort((left, right) => left.ordinal - right.ordinal);
    relation = {
      algorithm: "horizontal_equal_spacing",
      region: "bottom_navigation",
      anchors,
      targetOrdinal: ordinal(value.relation.targetOrdinal, "selector.relation.targetOrdinal"),
    };
  } else if (value.relation !== undefined) {
    throw new Error("selector.relation requires the relation source");
  }

  let visionPrompt;
  if (value.sources.includes("vision")) {
    visionPrompt = cleanText(value.visionPrompt ?? label, "selector.visionPrompt", 4096);
  } else if (value.visionPrompt !== undefined) {
    throw new Error("selector.visionPrompt requires the vision source");
  }

  return {
    label,
    role: value.role,
    sources: [...value.sources],
    ...(relation ? { relation } : {}),
    ...(visionPrompt ? { visionPrompt } : {}),
  };
}

export function parseVisionNodeResponse(value, dimensions) {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Vision returned invalid JSON");
    }
  }
  try {
    exactKeys(parsed, new Set(["matches"]), "vision observation");
  } catch {
    throw new DeviceNodeError("CAPABILITY_MISSING", "Vision returned an invalid observation shape");
  }
  if (!Array.isArray(parsed.matches) || parsed.matches.length > 12
      || !Number.isSafeInteger(dimensions?.width) || !Number.isSafeInteger(dimensions?.height)
      || dimensions.width < 1 || dimensions.height < 1) {
    throw new DeviceNodeError("CAPABILITY_MISSING", "Vision returned an invalid observation shape");
  }
  const matches = parsed.matches.map((match) => {
    try {
      exactKeys(match, new Set(["left", "top", "right", "bottom"]), "vision match");
    } catch {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Vision returned an invalid node match");
    }
    if (!validBounds(match) || match.right > dimensions.width || match.bottom > dimensions.height) {
      throw new DeviceNodeError("CAPABILITY_MISSING", "Vision returned node bounds outside the display");
    }
    return { left: match.left, top: match.top, right: match.right, bottom: match.bottom };
  });
  if (matches.length > 1) {
    throw new DeviceNodeError("NODE_AMBIGUOUS", "Vision exposed multiple matching nodes");
  }
  return matches[0] ?? null;
}

function validBounds(value) {
  return value && [value.left, value.top, value.right, value.bottom].every(Number.isSafeInteger)
    && value.left >= 0 && value.top >= 0 && value.right > value.left && value.bottom > value.top;
}

export function inferHorizontalOrdinalBounds(anchorBounds, relation, dimensions) {
  if (!Array.isArray(anchorBounds) || anchorBounds.length !== 2
      || !anchorBounds.every(validBounds)
      || !Number.isSafeInteger(dimensions?.width) || !Number.isSafeInteger(dimensions?.height)
      || dimensions.width < 1 || dimensions.height < 1) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Relational node evidence is invalid");
  }
  const normalized = validateDeviceNodeSelector({
    label: "target",
    role: "tab",
    sources: ["relation"],
    relation,
  }).relation;
  const observations = normalized.anchors.map((anchor, index) => {
    const bounds = anchorBounds[index];
    if (bounds.right > dimensions.width || bounds.bottom > dimensions.height) {
      throw new DeviceNodeError("LAYOUT_DRIFT", "Relation anchor falls outside the display");
    }
    return {
      ...anchor,
      bounds,
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom) / 2,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
    };
  });
  const ordinalDelta = observations[1].ordinal - observations[0].ordinal;
  const spacing = (observations[1].x - observations[0].x) / ordinalDelta;
  if (spacing <= dimensions.width * 0.08 || spacing >= dimensions.width * 0.45
      || Math.abs(observations[1].y - observations[0].y) > dimensions.height * 0.025
      || Math.min(observations[0].y, observations[1].y) < dimensions.height * 0.85) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Anchors do not form one verified bottom navigation row");
  }
  const x = observations[0].x + spacing * (normalized.targetOrdinal - observations[0].ordinal);
  const y = (observations[0].y + observations[1].y) / 2;
  const width = Math.max(24, Math.round((observations[0].width + observations[1].width) / 2));
  const height = Math.max(24, Math.round((observations[0].height + observations[1].height) / 2));
  if (x <= 0 || x >= dimensions.width || y <= 0 || y >= dimensions.height) {
    throw new DeviceNodeError("LAYOUT_DRIFT", "Inferred node falls outside the verified display");
  }
  const result = {
    left: Math.max(0, Math.round(x - width / 2)),
    top: Math.max(0, Math.round(y - height / 2)),
    right: Math.min(dimensions.width, Math.round(x + width / 2)),
    bottom: Math.min(dimensions.height, Math.round(y + height / 2)),
  };
  if (!validBounds(result)) throw new DeviceNodeError("LAYOUT_DRIFT", "Inferred node bounds are invalid");
  return result;
}

export function stableNodeBounds(reference, current) {
  if (!validBounds(reference) || !validBounds(current)) return false;
  const center = (bounds) => ({
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  });
  const left = center(reference);
  const right = center(current);
  return Math.abs(left.x - right.x) <= 24 && Math.abs(left.y - right.y) <= 24
    && Math.abs(left.width - right.width) <= Math.max(8, left.width * 0.2)
    && Math.abs(left.height - right.height) <= Math.max(8, left.height * 0.2);
}

export function publicNodeDescription(selector, source) {
  const normalized = validateDeviceNodeSelector(selector);
  if (!SAFE_SOURCES.has(source) || !normalized.sources.includes(source)) {
    throw new Error("Resolved node source is invalid");
  }
  return {
    label: normalized.label,
    role: normalized.role,
    group: source === "relation" ? normalized.relation.region : null,
    ordinal: source === "relation" ? normalized.relation.targetOrdinal : null,
    source,
    unique: true,
  };
}
