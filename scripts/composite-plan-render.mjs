import { ACTION_REGISTRY, validateCompiledSteps } from "./composite-action-registry.mjs";
import { canonicalizeJson, hashPlan } from "./composite-plan-core.mjs";

const FORBIDDEN_DISPLAY = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const MARKDOWN = new Set(["\\", "`", "|", "[", "]", "(", ")", "#", "<", ">", "*"]);

export function escapePlanDisplay(value) {
  const text = String(value);
  if (FORBIDDEN_DISPLAY.test(text)) throw new Error("display value contains forbidden control or bidi characters");
  return [...text].map((character) => MARKDOWN.has(character) ? `\\${character}` : character).join("");
}

function lineValue(value) {
  return escapePlanDisplay(typeof value === "string" ? value : canonicalizeJson(value));
}

export function renderCompositePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("compiled plan is required");
  if (hashPlan(plan) !== plan.planHash) throw new Error("compiled plan hash mismatch");
  validateCompiledSteps(plan.devices.flatMap((device) => device.steps), plan.limits);
  const lines = [
    "# Supervised Composite Plan Review",
    "",
    `- Plan: ${lineValue(plan.planId)}`,
    `- Policy: ${lineValue(plan.policyProfileId)}`,
    `- Capability: ${lineValue(plan.capabilityProfileId)}`,
    `- Compiler: ${lineValue(plan.compilerVersion)}`,
    "",
    "## Machines and exact steps",
    "",
  ];
  for (const device of plan.devices) {
    lines.push(`### Machine ${lineValue(device.machine)} — ${lineValue(device.taskId)}`, "");
    for (const step of device.steps) {
      const risk = ACTION_REGISTRY[step.action].risk;
      lines.push(`1. ${lineValue(step.stepId)} — ${lineValue(step.action)} — risk=${lineValue(risk)}`);
      lines.push(`   - params: ${lineValue(step.params)}`);
      if (step.when) lines.push(`   - when: ${lineValue(step.when)}`);
      if (step.operationId) lines.push(`   - operationId: ${lineValue(step.operationId)}`);
      if (step.budgetSlotId) lines.push(`   - budgetSlotId: ${lineValue(step.budgetSlotId)}`);
    }
    lines.push("");
  }
  lines.push("## Finite visit policy", "");
  for (const [key, value] of Object.entries(plan.visitPolicy)) lines.push(`- ${lineValue(key)}: ${lineValue(value)}`);
  lines.push("", "## Shared limits", "");
  for (const [key, value] of Object.entries(plan.limits)) lines.push(`- ${lineValue(key)}: ${lineValue(value)}`);
  lines.push("", "## Capability-owned runtime profile", "");
  for (const [key, value] of Object.entries(plan.runtimeProfile)) lines.push(`- ${lineValue(key)}: ${lineValue(value)}`);
  lines.push(
    "",
    "## Confirmation and execution contract",
    "",
    "- This rendered plan and its exact planHash form the single confirmation boundary for this run.",
    "- After human approval, execute every compiled step, condition, bounded recovery, and fallback without intermediate confirmation.",
    "- Readiness checks cover only capabilities required by this compiled plan; unrelated capability degradation does not block execution.",
    "- Only the machines listed above are selected. Other online machines do not block this plan, and selected machines must not be substituted after approval.",
    "- A material change to any machine, target, action, content, destination, limit, or fallback requires a new rendered plan and confirmation.",
    "- Emit one terminal completion or blocked report for the attempt. An unchanged blocked preflight must not be rerun automatically.",
    "",
    "## Stop and failure behavior",
    "",
    "- Local read-only navigation failures stop only that worker after the frozen failure budget.",
    "- Any ambiguous account-state result, identity drift, approval mismatch, sensitive page, lease loss, forbidden action, or human interrupt opens the global fuse.",
    "- A global fuse prevents every later sent operation and no operation or budget slot is transferred.",
    "",
    "## Bound hashes",
    "",
    "```text",
    `policyHash=${plan.policyHash}`,
    `capabilityProfileHash=${plan.capabilityProfileHash}`,
    `inventorySnapshotHash=${plan.inventorySnapshotHash}`,
    `capabilitySnapshotHash=${plan.capabilitySnapshotHash}`,
    `planHash=${plan.planHash}`,
    "```",
    "",
  );
  return lines.join("\n");
}
