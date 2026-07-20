import { createHash } from "node:crypto";

import { ACTION_REGISTRY, validateCompiledSteps } from "./composite-action-registry.mjs";
import { canonicalizeJson, hashPlan } from "./composite-plan-core.mjs";
import { validateResearchTask } from "./research-core.mjs";

const COMMENT_BANDS = new Set(["ZERO", "ONE_TO_FIVE", "SIX_TO_TWENTY", "TWENTY_ONE_TO_NINETY_NINE", "HUNDRED_PLUS", "UNKNOWN"]);
const ENGAGEMENT_ACTIONS = new Set(["engagement.ensure_liked", "engagement.ensure_favorited"]);
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function plain(value, name) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) invariant(allowed.includes(key), `${name} does not allow ${key}`);
}

function integer(value, name, minimum, maximum) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} is outside its finite bounds`);
  return value;
}

function safeText(value, name, maximum) {
  invariant(typeof value === "string" && value.length > 0 && value.length <= maximum, `${name} length is invalid`);
  invariant(value === value.trim() && SAFE_TEXT.test(value), `${name} contains unsafe text`);
  return value;
}

function safeXhsUrl(value) {
  safeText(value, "source URL", 2048);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("source URL is invalid"); }
  invariant(parsed.protocol === "https:", "source URL must use HTTPS");
  const host = parsed.hostname.toLowerCase();
  if (host === "xhslink.com" || host === "www.xhslink.com") {
    invariant(/^\/[A-Za-z0-9_-]+$/u.test(parsed.pathname), "xhslink URL path is invalid");
  } else {
    invariant(host === "xiaohongshu.com" || host === "www.xiaohongshu.com", "source URL host is not approved");
    invariant(/^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+$/u.test(parsed.pathname), "Xiaohongshu URL path is invalid");
  }
  return parsed.toString();
}

function normalizeTitle(value) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
}

function sourceCount(source) {
  if (source.type === "research_read_only") return 1;
  return source.type === "url_list" ? source.urls.length : source.count;
}

function operationId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function taskSource(source, sourceCountsByMachine, researchAssignments = []) {
  if (source.type === "feed") return {
    type: "feed", count: source.count, candidateCap: source.candidateCap, maxScrollsPerItem: source.maxScrollsPerItem,
    ...(sourceCountsByMachine?.length ? { countsByMachine: sourceCountsByMachine.map((entry) => ({ ...entry })) } : {}),
  };
  if (source.type === "search_results") return {
    type: "search_results", queryRef: "query-001", query: source.query, count: source.count,
    maxScrollsPerResult: source.maxScrollsPerResult,
  };
  if (source.type === "research_read_only") return {
    ...source,
    assignments: researchAssignments.map((entry) => ({ machine: entry.machine, task: structuredClone(entry.task) })),
  };
  return {
    type: "url_list",
    urls: source.urls.map((url, index) => ({ urlRef: `url-${String(index + 1).padStart(3, "0")}`, url })),
  };
}

function safeDerivedTaskId(taskId, machine) {
  const plain = `${taskId}-research-${machine}`;
  if (plain.length <= 80) return plain;
  return `${taskId.slice(0, 56)}-${machine}-${operationId("shard", taskId, machine).slice(-16)}`;
}

function allocateWithMinimum(total, minima) {
  invariant(Number.isSafeInteger(total) && minima.every(Number.isSafeInteger), "research shard budget is invalid");
  const values = [...minima];
  let remaining = total - values.reduce((sum, value) => sum + value, 0);
  invariant(remaining >= 0, "research shard minima exceed the approved budget");
  for (let index = 0; remaining > 0; index = (index + 1) % values.length) {
    values[index] += 1;
    remaining -= 1;
  }
  return values;
}

function compileResearchAssignments(task, machines) {
  if (task.source.type !== "research_read_only") return [];
  const source = task.source;
  const keywordSources = source.sources.some((value) => value === "search" || value === "suggestions");
  const keywords = [...new Set([source.topic, ...source.seedKeywords])].slice(0, source.budgets.maxQueries);
  const activeCount = keywordSources
    ? Math.min(machines.length, keywords.length, source.budgets.maxQueries, source.budgets.maxNotes)
    : 1;
  const activeMachines = machines.slice(0, activeCount);
  const keywordGroups = activeMachines.map(() => []);
  if (keywordSources) keywords.forEach((keyword, index) => keywordGroups[index % activeCount].push(keyword));
  else keywordGroups[0].push(source.topic);
  const queryMinima = keywordGroups.map((group) => Math.max(1, group.length));
  const queryBudgets = allocateWithMinimum(source.budgets.maxQueries, queryMinima);
  const noteBudgets = allocateWithMinimum(source.budgets.maxNotes, activeMachines.map(() => 1));
  const commentBudgets = allocateWithMinimum(source.budgets.maxCommentPanels, activeMachines.map(() => 0));
  const aiBudgets = allocateWithMinimum(source.aiPolicy.maxAutomaticCalls, activeMachines.map(() => 0));
  const assignments = [];
  for (const [index, machine] of activeMachines.entries()) {
    const sources = source.sources.filter((value) => {
      if (value === "search" || value === "suggestions") return keywordGroups[index].length > 0;
      return index === 0;
    });
    if (!sources.length) continue;
    const shardTopic = keywordGroups[index][0] ?? source.topic;
    assignments.push({
      machine,
      task: {
        schemaVersion: 1,
        taskId: safeDerivedTaskId(task.taskId, machine),
        mode: "research_read_only",
        topic: shardTopic,
        seedKeywords: keywordGroups[index].slice(1),
        sources,
        deviceGroup: "unified-task",
        commentMode: source.commentMode,
        interactionPolicy: "human_final",
        budgets: {
          ...source.budgets,
          maxQueries: queryBudgets[index],
          maxNotes: noteBudgets[index],
          maxCommentPanels: commentBudgets[index],
        },
        aiPolicy: { ...source.aiPolicy, maxAutomaticCalls: aiBudgets[index] },
      },
    });
  }
  return assignments;
}

export function resolveTaskMachines(task, inventory) {
  plain(task, "task");
  const selection = plain(task.deviceSelection, "deviceSelection");
  invariant(Array.isArray(inventory), "device inventory must be an array");
  if (selection.mode === "explicit") return [...selection.machines];
  invariant(selection.mode === "auto_idle", "unsupported device selection mode");
  const candidates = inventory
    .filter((entry) => entry?.online === true && entry?.unlocked === true && entry?.idle === true && /^[0-9]{2}$/u.test(entry.machine ?? ""))
    .sort((left, right) => (Number(left.preferenceRank ?? Number.MAX_SAFE_INTEGER) - Number(right.preferenceRank ?? Number.MAX_SAFE_INTEGER)) || left.machine.localeCompare(right.machine));
  invariant(candidates.length >= selection.count, "not enough online unlocked idle machines");
  return candidates.slice(0, selection.count).map((entry) => entry.machine);
}

export function normalizeTaskSpec(input, { resolvedMachines } = {}) {
  plain(input, "task spec");
  exactKeys(input, ["schemaVersion", "taskId", "capabilityProfileId", "seed", "deviceSelection", "maxParallel", "sourceCountsByMachine", "taskIdsByMachine", "source", "actions", "maxWallClockMs"], "task spec");
  invariant(input.schemaVersion === "xhs-task-spec/v1", "unsupported task schemaVersion");
  invariant(typeof input.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(input.taskId), "taskId is invalid");
  invariant(typeof input.capabilityProfileId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(input.capabilityProfileId), "capabilityProfileId is invalid");
  invariant(typeof input.seed === "string" && input.seed.length >= 24 && input.seed.length <= 128 && /^[A-Za-z0-9+/=_-]+$/u.test(input.seed), "seed is invalid");

  const selection = plain(input.deviceSelection, "deviceSelection");
  let machines;
  if (selection.mode === "explicit") {
    exactKeys(selection, ["mode", "machines"], "deviceSelection");
    invariant(Array.isArray(selection.machines) && selection.machines.length > 0 && selection.machines.length <= 64, "explicit machines are required");
    invariant(selection.machines.every((machine) => /^[0-9]{2}$/u.test(machine)), "machine must use a two-digit number");
    invariant(new Set(selection.machines).size === selection.machines.length, "duplicate machine");
    machines = [...selection.machines];
  } else {
    exactKeys(selection, ["mode", "count"], "deviceSelection");
    invariant(selection.mode === "auto_idle", "unsupported device selection mode");
    integer(selection.count, "deviceSelection.count", 1, 64);
    invariant(Array.isArray(resolvedMachines), "auto_idle requires a fresh deterministic machine resolution");
    invariant(resolvedMachines.length === selection.count, "resolved machine count mismatch");
    invariant(resolvedMachines.every((machine) => /^[0-9]{2}$/u.test(machine)), "resolved machine is invalid");
    invariant(new Set(resolvedMachines).size === resolvedMachines.length, "duplicate resolved machine");
    machines = [...resolvedMachines];
  }
  integer(input.maxParallel, "maxParallel", 1, 64);
  invariant(input.maxParallel <= machines.length, "maxParallel exceeds selected machines");

  const source = plain(input.source, "source");
  let normalizedSource;
  if (source.type === "feed") {
    exactKeys(source, ["type", "count", "candidateCap", "maxScrollsPerItem"], "feed source");
    integer(source.count, "source.count", 1, 10000);
    const candidateCap = source.candidateCap === undefined ? Math.min(20, source.count) : integer(source.candidateCap, "source.candidateCap", 1, 20);
    const maxScrollsPerItem = source.maxScrollsPerItem === undefined ? 1 : integer(source.maxScrollsPerItem, "source.maxScrollsPerItem", 0, 10000);
    normalizedSource = { type: "feed", count: source.count, candidateCap, maxScrollsPerItem };
  } else if (source.type === "search_results") {
    exactKeys(source, ["type", "query", "count", "maxScrollsPerResult"], "search source");
    normalizedSource = {
      type: "search_results",
      query: safeText(source.query, "source.query", 200),
      count: integer(source.count, "source.count", 1, 10000),
      maxScrollsPerResult: source.maxScrollsPerResult === undefined
        ? 1
        : integer(source.maxScrollsPerResult, "source.maxScrollsPerResult", 0, 10000),
    };
  } else if (source.type === "url_list") {
    exactKeys(source, ["type", "urls"], "URL source");
    invariant(source.type === "url_list" && Array.isArray(source.urls) && source.urls.length > 0 && source.urls.length <= 10000, "URL list is invalid");
    normalizedSource = { type: "url_list", urls: source.urls.map(safeXhsUrl) };
    invariant(new Set(normalizedSource.urls).size === normalizedSource.urls.length, "URL list contains duplicates");
  } else {
    exactKeys(source, ["type", "topic", "seedKeywords", "sources", "commentMode", "budgets", "aiPolicy"], "research source");
    invariant(source.type === "research_read_only", "unsupported task source");
    const research = validateResearchTask({
      schemaVersion: 1,
      taskId: input.taskId,
      mode: "research_read_only",
      topic: source.topic,
      seedKeywords: source.seedKeywords,
      sources: source.sources,
      deviceGroup: "unified-task",
      commentMode: source.commentMode,
      interactionPolicy: "human_final",
      budgets: source.budgets,
      aiPolicy: source.aiPolicy,
    });
    normalizedSource = {
      type: "research_read_only",
      topic: research.topic,
      seedKeywords: [...research.seedKeywords],
      sources: [...research.sources],
      commentMode: research.commentMode,
      budgets: { ...research.budgets },
      aiPolicy: { ...research.aiPolicy },
    };
  }

  let sourceCountsByMachine;
  if (input.sourceCountsByMachine !== undefined) {
    invariant(normalizedSource.type === "feed", "sourceCountsByMachine currently applies only to Feed sources");
    invariant(Array.isArray(input.sourceCountsByMachine) && input.sourceCountsByMachine.length > 0 && input.sourceCountsByMachine.length <= machines.length, "sourceCountsByMachine must be a finite selected-machine list");
    const seenMachines = new Set();
    const byMachine = new Map();
    for (const [index, entry] of input.sourceCountsByMachine.entries()) {
      plain(entry, `sourceCountsByMachine[${index}]`);
      exactKeys(entry, ["machine", "count"], `sourceCountsByMachine[${index}]`);
      invariant(machines.includes(entry.machine) && !seenMachines.has(entry.machine), "sourceCountsByMachine must reference each selected machine at most once");
      seenMachines.add(entry.machine);
      byMachine.set(entry.machine, integer(entry.count, `sourceCountsByMachine[${index}].count`, 1, normalizedSource.count));
    }
    sourceCountsByMachine = machines.filter((machine) => byMachine.has(machine)).map((machine) => ({ machine, count: byMachine.get(machine) }));
  }
  let taskIdsByMachine;
  if (input.taskIdsByMachine !== undefined) {
    invariant(Array.isArray(input.taskIdsByMachine) && input.taskIdsByMachine.length > 0 && input.taskIdsByMachine.length <= machines.length, "taskIdsByMachine must be a finite selected-machine list");
    const seenMachines = new Set();
    const seenTaskIds = new Set();
    const byMachine = new Map();
    for (const [index, entry] of input.taskIdsByMachine.entries()) {
      plain(entry, `taskIdsByMachine[${index}]`);
      exactKeys(entry, ["machine", "taskId"], `taskIdsByMachine[${index}]`);
      invariant(machines.includes(entry.machine) && !seenMachines.has(entry.machine), "taskIdsByMachine must reference each selected machine at most once");
      invariant(typeof entry.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(entry.taskId) && !seenTaskIds.has(entry.taskId), "taskIdsByMachine contains an invalid or duplicate taskId");
      seenMachines.add(entry.machine);
      seenTaskIds.add(entry.taskId);
      byMachine.set(entry.machine, entry.taskId);
    }
    taskIdsByMachine = machines.filter((machine) => byMachine.has(machine)).map((machine) => ({ machine, taskId: byMachine.get(machine) }));
  }

  invariant(Array.isArray(input.actions) && input.actions.length <= 10000, "actions must be a finite ordered array");
  if (normalizedSource.type === "research_read_only") invariant(input.actions.length === 0, "research compatibility source is read-only");
  const count = sourceCount(normalizedSource);
  const actions = input.actions.map((entry, index) => {
    plain(entry, `actions[${index}]`);
    exactKeys(entry, ["target", "action", "when"], `actions[${index}]`);
    invariant(ENGAGEMENT_ACTIONS.has(entry.action), `actions[${index}].action is not in the automatic registry`);
    const target = plain(entry.target, `actions[${index}].target`);
    let normalizedTarget;
    if (target.mode === "ordinal") {
      exactKeys(target, ["mode", "ordinal"], `actions[${index}].target`);
      normalizedTarget = { mode: "ordinal", ordinal: integer(target.ordinal, `actions[${index}].target.ordinal`, 1, count) };
    } else {
      exactKeys(target, ["mode"], `actions[${index}].target`);
      invariant(target.mode === "each", `actions[${index}].target mode is invalid`);
      normalizedTarget = { mode: "each" };
    }
    let when;
    if (entry.when !== undefined) {
      plain(entry.when, `actions[${index}].when`);
      if (entry.when.type === "comment_band") {
        exactKeys(entry.when, ["type", "bands"], `actions[${index}].when`);
        invariant(Array.isArray(entry.when.bands) && entry.when.bands.length > 0 && entry.when.bands.length <= COMMENT_BANDS.size, "comment bands are invalid");
        invariant(entry.when.bands.every((band) => COMMENT_BANDS.has(band)) && new Set(entry.when.bands).size === entry.when.bands.length, "comment bands must be unique closed values");
        when = { type: "comment_band", bands: [...entry.when.bands] };
      } else {
        exactKeys(entry.when, ["type", "text"], `actions[${index}].when`);
        invariant(entry.when.type === "title_contains", "condition type is invalid");
        when = { type: "title_contains", text: normalizeTitle(safeText(entry.when.text, "title condition", 200)) };
      }
    }
    return { target: normalizedTarget, action: entry.action, ...(when ? { when } : {}) };
  });

  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    const seen = new Set();
    for (const entry of actions.filter((action) => action.target.mode === "each" || action.target.ordinal === ordinal)) {
      invariant(!seen.has(entry.action), `same state-changing action is scheduled more than once for target ${ordinal}`);
      seen.add(entry.action);
    }
  }
  const maxWallClockMs = input.maxWallClockMs === undefined ? 1800000 : integer(input.maxWallClockMs, "maxWallClockMs", 1000, 86400000);
  return Object.freeze({
    ...input,
    deviceSelection: { mode: "explicit", machines: [...machines] },
    ...(sourceCountsByMachine ? { sourceCountsByMachine } : {}),
    ...(taskIdsByMachine ? { taskIdsByMachine } : {}),
    source: normalizedSource,
    actions,
    maxWallClockMs,
  });
}

function requiredActions(task) {
  const actions = new Set(task.source.type === "research_read_only" ? ["research.collect"] : ["detail.inspect"]);
  if (task.source.type === "feed") actions.add("recover.to_feed"), actions.add("feed.open_visible"), actions.add("navigation.return_to_feed");
  if (task.source.type === "search_results") actions.add("search.open_results"), actions.add("search.open_result"), actions.add("navigation.return_to_source");
  if (task.source.type === "url_list") actions.add("content.open_xhs_url");
  if (task.actions.some((entry) => entry.when?.type === "comment_band")) actions.add("comments.observe_count");
  if (task.actions.some((entry) => entry.when?.type === "title_contains")) actions.add("detail.evaluate_title_rule");
  for (const entry of task.actions) actions.add(entry.action);
  return [...actions];
}

function compileWorker(task, machine, titleRules, visibleName, count, taskId, researchAssignment = null) {
  const steps = [];
  let sequence = 0;
  const add = (action, params = {}, when, accountState = false, ordinal = 0) => {
    sequence += 1;
    invariant(sequence <= 99999, "compiled worker step count exceeds v1 capacity");
    const stepId = `m${machine}.s${String(sequence).padStart(5, "0")}`;
    const step = { stepId, action, ...(when ? { when } : {}), params };
    if (accountState) {
      step.operationId = operationId("operation", task.seed, machine, String(ordinal), action);
      step.budgetSlotId = operationId("budget", task.seed, machine, String(ordinal), action);
    }
    steps.push(step);
    return step;
  };
  if (task.source.type === "research_read_only") {
    if (researchAssignment) add("research.collect", { policyRef: "research-read-only-v1" });
    return { machine, ...(visibleName ? { visibleName } : {}), taskId, sourceCount: researchAssignment ? 1 : 0, steps };
  }
  if (task.source.type === "feed") add("recover.to_feed", {
    strategyId: "bounded_home_entry_v1", maxBackAttemptsPerPhase: 4, maxLaunchAttempts: 2,
  });
  if (task.source.type === "search_results") add("search.open_results", { queryRef: "query-001" });
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    if (task.source.type === "feed") add("feed.open_visible", {
      visibleRank: 1, candidateCap: task.source.candidateCap, maxScrolls: task.source.maxScrollsPerItem,
      fallback: task.source.maxScrollsPerItem > 0 ? "feed_scroll_once_then_skip" : "skip_target",
    });
    if (task.source.type === "search_results") add("search.open_result", {
      resultOrdinal: ordinal, candidateCap: count, maxScrolls: task.source.maxScrollsPerResult,
    });
    if (task.source.type === "url_list") add("content.open_xhs_url", { urlRef: `url-${String(ordinal).padStart(3, "0")}` });
    const detail = add("detail.inspect", {});
    const targetBindingRef = `${detail.stepId}.target`;
    const scheduled = task.actions.filter((entry) => entry.target.mode === "each" || entry.target.ordinal === ordinal);
    let countStep = null;
    if (scheduled.some((entry) => entry.when?.type === "comment_band")) countStep = add("comments.observe_count", {});
    const titleSteps = new Map();
    for (const entry of scheduled) {
      if (entry.when?.type !== "title_contains") continue;
      const rule = titleRules.find((candidate) => candidate.value === entry.when.text);
      if (!titleSteps.has(rule.ruleRef)) titleSteps.set(rule.ruleRef, add("detail.evaluate_title_rule", { ruleRef: rule.ruleRef }));
    }
    for (const entry of scheduled) {
      let when;
      if (entry.when?.type === "comment_band") when = { observationRef: `${countStep.stepId}.countBand`, operator: "in", value: [...entry.when.bands] };
      if (entry.when?.type === "title_contains") {
        const rule = titleRules.find((candidate) => candidate.value === entry.when.text);
        when = { observationRef: `${titleSteps.get(rule.ruleRef).stepId}.targetState`, operator: "equals", value: "ACTIVE" };
      }
      add(entry.action, { targetBindingRef }, when, true, ordinal);
    }
    if (task.source.type === "feed") add("navigation.return_to_feed", {});
    if (task.source.type === "search_results") add("navigation.return_to_source", { sourceType: "search_results" });
  }
  return { machine, ...(visibleName ? { visibleName } : {}), taskId, sourceCount: count, steps };
}

export function compileUnifiedTaskPlan(input, context) {
  const task = normalizeTaskSpec(input, { resolvedMachines: context?.resolvedMachines });
  plain(context, "compiler context");
  const capability = plain(context.capabilityProfile, "capability profile");
  invariant(task.capabilityProfileId === capability.capabilityProfileId, "capability profile mismatch");
  const machines = task.deviceSelection.machines;
  invariant(machines.length <= capability.maxDevices, "selected device count exceeds capability");
  invariant(task.maxParallel <= capability.maxParallel, "maxParallel exceeds capability");
  const needed = requiredActions(task);
  invariant(needed.every((action) => ACTION_REGISTRY[action] && capability.allowedActions.includes(action)), "task requires an unaccepted capability");
  invariant(/^[a-f0-9]{64}$/u.test(context.policyHash ?? ""), "policyHash is required");
  invariant(/^[a-f0-9]{64}$/u.test(context.capabilityProfileHash ?? ""), "capabilityProfileHash is required");
  invariant(/^[a-f0-9]{64}$/u.test(context.preparationSnapshot?.inventorySnapshotHash ?? ""), "inventorySnapshotHash is required");
  invariant(/^[a-f0-9]{64}$/u.test(context.preparationSnapshot?.capabilitySnapshotHash ?? ""), "capabilitySnapshotHash is required");
  const preparedMachines = context.preparationSnapshot.devices?.map((entry) => entry.machine);
  invariant(Array.isArray(preparedMachines) && canonicalizeJson(preparedMachines) === canonicalizeJson(machines), "preparation machines do not match the task");

  const titleValues = [...new Set(task.actions.filter((entry) => entry.when?.type === "title_contains").map((entry) => entry.when.text))];
  invariant(titleValues.length <= 10000, "too many title rules");
  const titleRules = titleValues.map((value, index) => ({ ruleRef: `title-rule-${String(index + 1).padStart(3, "0")}`, operator: "normalized_contains", value }));
  const preparedByMachine = new Map(context.preparationSnapshot.devices.map((entry) => [entry.machine, entry]));
  const sourceCountOverrides = new Map((task.sourceCountsByMachine ?? []).map((entry) => [entry.machine, entry.count]));
  const taskIdOverrides = new Map((task.taskIdsByMachine ?? []).map((entry) => [entry.machine, entry.taskId]));
  const researchAssignments = compileResearchAssignments(task, machines);
  const researchByMachine = new Map(researchAssignments.map((entry) => [entry.machine, entry]));
  const deviceSourceCount = (machine) => task.source.type === "research_read_only"
    ? Number(researchByMachine.has(machine))
    : (sourceCountOverrides.get(machine) ?? sourceCount(task.source));
  const devices = machines.map((machine) => compileWorker(
    task,
    machine,
    titleRules,
    preparedByMachine.get(machine)?.visibleName,
    deviceSourceCount(machine),
    researchByMachine.get(machine)?.task.taskId ?? taskIdOverrides.get(machine) ?? `${task.taskId}-${machine}`,
    researchByMachine.get(machine),
  ));
  const stateChanges = devices.flatMap((device) => device.steps).filter((step) => ACTION_REGISTRY[step.action].risk === "account_state").length;
  const commentConditionTargets = new Set();
  for (const machine of machines) {
    for (let ordinal = 1; ordinal <= deviceSourceCount(machine); ordinal += 1) {
      if (task.actions.some((entry) => (entry.target.mode === "each" || entry.target.ordinal === ordinal) && entry.when?.type === "comment_band")) {
        commentConditionTargets.add(`${machine}:${ordinal}`);
      }
    }
  }
  invariant(stateChanges <= capability.maxStateChangesTotal, "task state changes exceed capability");
  const limits = {
    maxParallel: task.maxParallel,
    maxStateChangesTotal: stateChanges,
    maxReadStepsTotal: devices.flatMap((device) => device.steps).length - stateChanges,
    maxVisionCallsTotal: commentConditionTargets.size,
    maxWallClockMs: task.maxWallClockMs,
  };
  validateCompiledSteps(devices.flatMap((device) => device.steps), limits);
  const count = sourceCount(task.source);
  const planCore = {
    schemaVersion: "xhs-composite-plan/v1",
    policyProfileId: "supervised-composite-v1",
    policyHash: context.policyHash,
    capabilityProfileId: capability.capabilityProfileId,
    capabilityProfileHash: context.capabilityProfileHash,
    compilerVersion: context.compilerVersion ?? "2.0.0",
    rng: { algorithm: "hmac-sha256-counter-v1", seed: task.seed },
    taskSource: taskSource(task.source, task.sourceCountsByMachine, researchAssignments),
    titleRules,
    inventorySnapshotHash: context.preparationSnapshot.inventorySnapshotHash,
    capabilitySnapshotHash: context.preparationSnapshot.capabilitySnapshotHash,
    capabilityRequirements: {
      actionRegistry: "composite-actions/v1",
      commentPolicy: "count-adaptive-v1",
      cpaCommentCountSchema: "cpa-comment-count/v1",
      ...(task.source.type === "research_read_only" ? { researchPolicy: "research-read-only-v1" } : {}),
    },
    visitPolicy: {
      targetValidVisitsPerDevice: count,
      maxVisitAttemptsPerDevice: count * 2,
      maxSkippedTargetsPerDevice: count,
      maxFeedScrollsPerAttempt: task.source.type === "feed" ? task.source.maxScrollsPerItem : 0,
      maxFeedScrollsTotalPerDevice: task.source.type === "feed" ? count * task.source.maxScrollsPerItem : 0,
      visibleCandidateCap: task.source.type === "feed" ? task.source.candidateCap : Math.min(20, count),
      imageContentScrolls: { min: 0, max: 0 },
      videoAdvances: { min: 0, max: 0 },
      commentPolicyRef: "count-adaptive-v1",
      ensureLikedPerDevice: task.actions.filter((entry) => entry.action === "engagement.ensure_liked").reduce((sum, entry) => sum + (entry.target.mode === "each" ? count : 1), 0),
      ensureFavoritedPerDevice: task.actions.filter((entry) => entry.action === "engagement.ensure_favorited").reduce((sum, entry) => sum + (entry.target.mode === "each" ? count : 1), 0),
      eligibleVisitOrdinals: { min: 1, max: count },
      perDevice: machines.map((machine) => {
        const deviceCount = deviceSourceCount(machine);
        const scheduledCount = (action) => task.actions
          .filter((entry) => entry.action === action)
          .reduce((sum, entry) => sum + (entry.target.mode === "each" ? deviceCount : Number(entry.target.ordinal <= deviceCount)), 0);
        return {
          machine,
          targetValidVisits: deviceCount,
          maxVisitAttempts: deviceCount * 2,
          maxSkippedTargets: deviceCount,
          maxFeedScrollsTotal: task.source.type === "feed" ? deviceCount * task.source.maxScrollsPerItem : 0,
          ensureLiked: scheduledCount("engagement.ensure_liked"),
          ensureFavorited: scheduledCount("engagement.ensure_favorited"),
        };
      }),
    },
    devices,
    limits,
    runtimeProfile: { ...capability.runtimeProfile },
    failurePolicyRef: "supervised-failure-policy-v1",
  };
  const coreHash = createHash("sha256").update(canonicalizeJson(planCore), "utf8").digest("hex");
  const planWithoutHash = { ...planCore, planId: `plan-${coreHash.slice(0, 16)}` };
  return { ...planWithoutHash, planHash: hashPlan(planWithoutHash) };
}
