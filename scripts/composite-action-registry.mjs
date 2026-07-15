const PAGE = Object.freeze({
  FEED: "HOME_FEED",
  IMAGE: "IMAGE_NOTE",
  VIDEO: "VIDEO_NOTE",
  COMMENTS: "COMMENT_PANEL",
  UNKNOWN: "UNKNOWN",
});

const targetBinding = { type: "string", pattern: "^m[0-9]{2}\\.s[0-9]{3}\\.target$" };
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const enumOf = (...values) => ({ enum: values });
const params = (required = [], properties = {}) => ({ type: "object", additionalProperties: false, required, properties });

function definition({ risk = "read_only", allowedPages, paramsSchema = params(), expectedPostcondition, failureClass = "local" }) {
  return {
    version: "1",
    risk,
    allowedPages,
    paramsSchema,
    observationTtlMs: 2000,
    oneSend: true,
    expectedPostcondition,
    failureClass,
  };
}

const registry = {
  "feed.scroll": definition({
    allowedPages: [PAGE.FEED], paramsSchema: params([], { maxScrolls: integer(1, 1) }),
    expectedPostcondition: "fresh HOME_FEED with a changed or end-marked semantic card set",
  }),
  "feed.open_visible": definition({
    allowedPages: [PAGE.FEED],
    paramsSchema: params(["visibleRank", "candidateCap", "fallback"], {
      visibleRank: integer(1, 20), candidateCap: integer(1, 20),
      fallback: enumOf("feed_scroll_once_then_skip", "skip_target"),
    }),
    expectedPostcondition: "fresh public detail with a bound target fingerprint",
  }),
  "detail.inspect": definition({
    allowedPages: [PAGE.IMAGE, PAGE.VIDEO], expectedPostcondition: "typed detail observation and immutable target binding",
  }),
  "image.scroll_content": definition({
    allowedPages: [PAGE.IMAGE], paramsSchema: params(["targetBindingRef"], { targetBindingRef: targetBinding }),
    expectedPostcondition: "fresh IMAGE_NOTE preserving the same target binding",
  }),
  "video.advance": definition({
    allowedPages: [PAGE.VIDEO], paramsSchema: params(["targetBindingRef"], { targetBindingRef: targetBinding }),
    expectedPostcondition: "fresh VIDEO_NOTE with a different target fingerprint",
  }),
  "comments.observe_count": definition({
    allowedPages: [PAGE.IMAGE, PAGE.VIDEO], expectedPostcondition: "typed frozen comment count band or UNKNOWN",
  }),
  "comments.open": definition({
    allowedPages: [PAGE.IMAGE, PAGE.VIDEO], expectedPostcondition: "fresh COMMENT_PANEL for the same target",
  }),
  "comments.collect": definition({
    allowedPages: [PAGE.COMMENTS], paramsSchema: params(["policyRef"], { policyRef: { const: "count-adaptive-v1" } }),
    expectedPostcondition: "bounded deidentified deduplicated public comment observations",
  }),
  "comments.close": definition({
    allowedPages: [PAGE.COMMENTS], expectedPostcondition: "fresh return to the same public detail",
  }),
  "navigation.return_to_feed": definition({
    allowedPages: [PAGE.IMAGE, PAGE.VIDEO], expectedPostcondition: "fresh HOME_FEED",
  }),
  "wait.for_condition": definition({
    allowedPages: [PAGE.FEED, PAGE.IMAGE, PAGE.VIDEO, PAGE.COMMENTS, PAGE.UNKNOWN],
    paramsSchema: params(["conditionId", "timeoutMs"], {
      conditionId: enumOf("foreground_xhs", "page_stable", "feed_ready", "detail_ready", "comment_panel_open", "valid_visit_target_not_met"),
      timeoutMs: integer(1, 30000),
    }),
    expectedPostcondition: "named typed condition verified before the finite timeout",
  }),
  "recover.to_feed": definition({
    allowedPages: [PAGE.FEED, PAGE.IMAGE, PAGE.VIDEO, PAGE.COMMENTS, PAGE.UNKNOWN],
    paramsSchema: params(["strategyId"], { strategyId: enumOf("back_once_then_verify", "relaunch_once_then_verify") }),
    expectedPostcondition: "fresh HOME_FEED after one versioned bounded strategy",
  }),
  "engagement.ensure_liked": definition({
    risk: "account_state", allowedPages: [PAGE.IMAGE, PAGE.VIDEO],
    paramsSchema: params(["targetBindingRef"], { targetBindingRef: targetBinding }),
    expectedPostcondition: "fresh verified active like state or noop_already_active",
    failureClass: "global",
  }),
  "engagement.ensure_favorited": definition({
    risk: "account_state", allowedPages: [PAGE.IMAGE, PAGE.VIDEO],
    paramsSchema: params(["targetBindingRef"], { targetBindingRef: targetBinding }),
    expectedPostcondition: "fresh verified active favorite state or noop_already_active",
    failureClass: "global",
  }),
};

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const ACTION_REGISTRY = deepFreeze(registry);
export const EXPECTED_ACTIONS = Object.freeze(Object.keys(ACTION_REGISTRY));

function validateProperty(name, schema, value) {
  if (schema.type === "integer" && !Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${name} must be a string`);
  if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${name} is below its cap`);
  if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${name} exceeds its cap`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${name} is not a closed identifier`);
  if (Object.hasOwn(schema, "const") && value !== schema.const) throw new Error(`${name} must equal ${schema.const}`);
  if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) throw new Error(`${name} has an invalid format`);
}

function validateParams(action, schema, supplied) {
  const value = supplied ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${action} params must be an object`);
  for (const required of schema.required ?? []) {
    if (!Object.hasOwn(value, required)) throw new Error(`${action} requires ${required}`);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`${action} does not allow ${key}`);
    validateProperty(`${action}.${key}`, schema.properties[key], value[key]);
  }
  if (action === "feed.open_visible" && value.visibleRank > value.candidateCap) {
    throw new Error("feed.open_visible.visibleRank exceeds candidateCap");
  }
}

export function validateActionInvocation({ action, pageState, params: suppliedParams = {} }) {
  const entry = ACTION_REGISTRY[action];
  if (!entry) throw new Error(`unsupported action: ${String(action)}`);
  if (!entry.allowedPages.includes(pageState)) throw new Error(`${action} is not allowed from page state ${pageState}`);
  validateParams(action, entry.paramsSchema, suppliedParams);
  return entry;
}

function observationStepId(reference) {
  if (typeof reference !== "string") return null;
  const match = /^(m[0-9]{2}\.s[0-9]{3})\.(status|countBand|pageState|targetState)$/.exec(reference);
  return match?.[1] ?? null;
}

export function validateCompiledSteps(steps, { maxStateChangesTotal = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(steps)) throw new Error("compiled steps must be an array");
  if (!Number.isSafeInteger(maxStateChangesTotal) || maxStateChangesTotal < 0) {
    throw new Error("maxStateChangesTotal must be a finite non-negative integer");
  }

  const seenStepIds = new Set();
  const operationIds = new Set();
  const budgetSlotIds = new Set();
  const engagementTargets = new Set();
  let commentPanelOpen = false;
  let currentTargetBinding = null;
  let stateChanges = 0;

  for (const step of steps) {
    const entry = ACTION_REGISTRY[step?.action];
    if (!entry) throw new Error(`unsupported action: ${String(step?.action)}`);
    if (typeof step.stepId !== "string" || !/^m[0-9]{2}\.s[0-9]{3}$/.test(step.stepId)) {
      throw new Error("stepId must be a typed machine step ID");
    }
    if (seenStepIds.has(step.stepId)) throw new Error(`duplicate stepId: ${step.stepId}`);
    if (step.when) {
      const referencedStep = observationStepId(step.when.observationRef);
      if (!referencedStep || !seenStepIds.has(referencedStep)) {
        throw new Error(`${step.stepId} condition must reference an earlier typed observation`);
      }
      if (!["equals", "not_equals"].includes(step.when.operator)) throw new Error("condition operator is not closed");
      if (typeof step.when.value !== "string") throw new Error("condition value must be a typed enum string");
      for (const key of Object.keys(step.when)) {
        if (!["observationRef", "operator", "value"].includes(key)) throw new Error(`condition does not allow ${key}`);
      }
    }
    validateParams(step.action, entry.paramsSchema, step.params);

    if (["comments.observe_count", "comments.open", "image.scroll_content"].includes(step.action) && !currentTargetBinding) {
      throw new Error(`${step.action} requires a current target binding`);
    }
    if (step.action === "detail.inspect") currentTargetBinding = `${step.stepId}.target`;
    if (step.action === "image.scroll_content" && step.params.targetBindingRef !== currentTargetBinding) {
      throw new Error("image scroll target binding does not match current detail");
    }
    if (step.action === "comments.open") commentPanelOpen = true;
    if (step.action === "comments.collect" && !commentPanelOpen) throw new Error("comments.collect requires comments.open");
    if (step.action === "comments.close") {
      if (!commentPanelOpen) throw new Error("comments.close requires an open comment panel");
      commentPanelOpen = false;
    }
    if (["video.advance", "navigation.return_to_feed"].includes(step.action) && commentPanelOpen) {
      throw new Error(`${step.action} requires comments.close first`);
    }
    if (step.action === "video.advance") {
      if (step.params.targetBindingRef !== currentTargetBinding) throw new Error("video target binding does not match current detail");
      currentTargetBinding = `${step.stepId}.target`;
    }
    if (entry.risk === "account_state") {
      stateChanges += 1;
      if (step.params.targetBindingRef !== currentTargetBinding) throw new Error("account-state target binding is stale or missing");
      if (!/^operation-[a-f0-9]{16}$/.test(step.operationId ?? "")) throw new Error("account-state action requires operationId");
      if (!/^budget-[a-f0-9]{16}$/.test(step.budgetSlotId ?? "")) throw new Error("account-state action requires budgetSlotId");
      if (operationIds.has(step.operationId)) throw new Error("operationId must be unique and non-transferable");
      if (budgetSlotIds.has(step.budgetSlotId)) throw new Error("budgetSlotId must be unique and non-transferable");
      operationIds.add(step.operationId);
      budgetSlotIds.add(step.budgetSlotId);
      const targetKey = `${step.action}:${step.params.targetBindingRef}`;
      if (engagementTargets.has(targetKey)) throw new Error("same state-changing action cannot repeat on one target binding");
      engagementTargets.add(targetKey);
    }
    if (step.action === "navigation.return_to_feed" || step.action === "recover.to_feed") {
      currentTargetBinding = null;
      commentPanelOpen = false;
    }
    seenStepIds.add(step.stepId);
  }

  if (stateChanges > maxStateChangesTotal) throw new Error("compiled actions exceed the shared state-change budget");
  return { stateChanges, operationIds: operationIds.size, budgetSlotIds: budgetSlotIds.size };
}
