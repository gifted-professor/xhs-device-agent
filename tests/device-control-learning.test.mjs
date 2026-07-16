import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeCandidate, validateLedger } from "../skills/record-device-control-learning/scripts/record-learning.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playbook = JSON.parse(await readFile(path.join(ROOT, "config", "device-control-playbook.json"), "utf8"));
const ledger = JSON.parse(await readFile(path.join(ROOT, "config", "device-control-incidents.json"), "utf8"));

function candidate(overrides = {}) {
  return {
    fingerprint: "new-reusable-device-failure",
    title: "New reusable failure",
    scope: "navigation",
    category: "perception",
    failureCode: "NODE_NOT_FOUND",
    state: "open",
    observation: "One exact semantic node could not be resolved.",
    rootCause: { status: "unknown", summary: null },
    resolution: { kind: "none", strategyId: null, summary: null },
    evidence: { artifacts: [], tests: [], liveAcceptance: [] },
    ...overrides,
  };
}

test("checked-in incident ledger is closed, deduplicated, and evidence-consistent", () => {
  const normalized = validateLedger(ledger, playbook);
  assert.equal(normalized.incidents.length, 6);
  assert.deepEqual(normalized.incidents.map(({ id, state }) => ({ id, state })), [
    { id: "DCI-0001", state: "open" },
    { id: "DCI-0002", state: "resolved" },
    { id: "DCI-0003", state: "mitigated" },
    { id: "DCI-0004", state: "open" },
    { id: "DCI-0005", state: "verified" },
    { id: "DCI-0006", state: "verified" },
  ]);
  const runtimeIncident = normalized.incidents.find(({ fingerprint }) => (
    fingerprint === "powershell-runtime-selection-and-cross-version-compatibility"
  ));
  assert.equal(runtimeIncident.evidenceLevel, "live_verified");
  assert.doesNotMatch(JSON.stringify(normalized), /\bserial\b|deviceId|\balias\b|config[\\/]local|[A-Za-z]:[\\/]/iu);
});

test("resolved and verified states require exact evidence gates", () => {
  const batch = {
    sessionId: "2026-07-16-missing-evidence",
    sessionDate: "2026-07-16",
    incidents: [candidate({
      state: "resolved",
      rootCause: { status: "confirmed", summary: "The exact cause is known." },
      resolution: { kind: "general_fix", strategyId: null, summary: "A general fix exists." },
    })],
  };
  assert.throws(() => mergeCandidate(batch, ledger, playbook), /artifacts, and tests/u);
  batch.incidents[0].evidence = {
    artifacts: [{ path: "scripts/device-node-engine.mjs", claim: "Implements the fix." }],
    tests: [{ path: "tests/device-node-engine.test.mjs", name: "verifies the fix" }],
    liveAcceptance: [],
  };
  batch.incidents[0].state = "verified";
  assert.throws(() => mergeCandidate(batch, ledger, playbook), /fresh named HTTP/u);
});

test("same fingerprint and session update without duplicate occurrence", () => {
  const first = mergeCandidate({
    sessionId: "2026-07-16-new-observation",
    sessionDate: "2026-07-16",
    incidents: [candidate()],
  }, ledger, playbook);
  const second = mergeCandidate({
    sessionId: "2026-07-16-new-observation",
    sessionDate: "2026-07-16",
    incidents: [candidate({
      state: "resolved",
      rootCause: { status: "confirmed", summary: "The exact reusable cause was confirmed." },
      resolution: { kind: "general_fix", strategyId: "ACCESSIBILITY_EXACT_NODE", summary: "The generic resolver fixes it." },
      evidence: {
        artifacts: [{ path: "scripts/device-node-engine.mjs", claim: "Implements the generic resolver." }],
        tests: [{ path: "tests/device-node-engine.test.mjs", name: "generic resolver regression" }],
        liveAcceptance: [],
      },
    })],
  }, first, playbook);
  const incident = second.incidents.find((entry) => entry.fingerprint === "new-reusable-device-failure");
  assert.equal(incident.state, "resolved");
  assert.equal(incident.occurrenceCount, 1);
  assert.equal(incident.evidenceLevel, "tests_passed");
});

test("a verified incident can only recur through reopened on a new session", () => {
  const existing = ledger.incidents.find((entry) => entry.state === "verified");
  const raw = candidate({
    fingerprint: existing.fingerprint,
    title: existing.title,
    scope: existing.scope,
    category: existing.category,
    failureCode: existing.failureCode,
    state: "reopened",
    observation: "The same reusable failure recurred in a new session.",
    rootCause: existing.rootCause,
    resolution: existing.resolution,
    evidence: existing.evidence,
  });
  const result = mergeCandidate({
    sessionId: "2026-07-17-recurrence-check",
    sessionDate: "2026-07-17",
    incidents: [raw],
  }, ledger, playbook);
  const reopened = result.incidents.find((entry) => entry.fingerprint === existing.fingerprint);
  assert.equal(reopened.state, "reopened");
  assert.equal(reopened.occurrenceCount, 2);
});

test("incident text and evidence reject private identifiers and absolute paths", () => {
  const base = {
    sessionId: "2026-07-16-private-content",
    sessionDate: "2026-07-16",
    incidents: [candidate({ observation: "The raw serial was exposed." })],
  };
  assert.throws(() => mergeCandidate(base, ledger, playbook), /forbidden content/u);
  base.incidents[0] = candidate({
    evidence: {
      artifacts: [{ path: "C:\\private\\file.mjs", claim: "Evidence." }], tests: [], liveAcceptance: [],
    },
  });
  assert.throws(() => mergeCandidate(base, ledger, playbook), /forbidden|repository-relative/u);
});
