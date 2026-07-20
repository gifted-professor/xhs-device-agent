import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const STATES = new Set(["open", "mitigated", "resolved", "verified", "reopened"]);
const ROOT_CAUSE_STATES = new Set(["unknown", "hypothesis", "confirmed"]);
const RESOLUTION_KINDS = new Set(["none", "workaround", "general_fix", "cleanup"]);
const SAFE_ID = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SAFE_NAME = /^[a-z][a-z0-9_]{1,63}$/u;
const SAFE_FINGERPRINT = /^[a-z0-9]+(?:-[a-z0-9]+){1,15}$/u;
const SAFE_SESSION = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+){0,11}$/u;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_COMMAND = /^[a-z][a-z0-9.-]{1,63}$/u;
const FORBIDDEN_TEXT = /(?:\bserial\b|deviceid|\balias\b|\btoken\b|\bcookie\b|\bpassword\b|config[\\/]local\.psd1|(?:^|[\\/])data[\\/])/iu;
const BIDI_OR_CONTROL = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!plainObject(value) || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function text(value, label, maximum = 512, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum
      || BIDI_OR_CONTROL.test(value) || FORBIDDEN_TEXT.test(value)
      || /^[A-Za-z]:[\\/]/u.test(value) || /^[/\\]{1,2}/u.test(value)) {
    throw new Error(`${label} is invalid or contains forbidden content`);
  }
  return value.normalize("NFKC").trim();
}

function exactDate(value, label) {
  if (typeof value !== "string" || !SAFE_DATE.test(value)
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function relativeEvidencePath(value, label) {
  const normalized = text(value, label, 256).replaceAll("\\", "/");
  if (normalized.includes("..") || !/^(?:scripts|tests|docs|config|skills)\/[A-Za-z0-9._/-]+$/u.test(normalized)) {
    throw new Error(`${label} must be a safe repository-relative evidence path`);
  }
  return normalized;
}

function uniqueByJson(values) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function validateEvidence(value, label) {
  exactKeys(value, ["artifacts", "tests", "liveAcceptance"], label);
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.tests) || !Array.isArray(value.liveAcceptance)
      || value.artifacts.length > 24 || value.tests.length > 24 || value.liveAcceptance.length > 12) {
    throw new Error(`${label} arrays are invalid`);
  }
  const artifacts = value.artifacts.map((entry, index) => {
    exactKeys(entry, ["path", "claim"], `${label}.artifacts[${index}]`);
    return {
      path: relativeEvidencePath(entry.path, `${label}.artifacts[${index}].path`),
      claim: text(entry.claim, `${label}.artifacts[${index}].claim`, 256),
    };
  });
  const tests = value.tests.map((entry, index) => {
    exactKeys(entry, ["path", "name"], `${label}.tests[${index}]`);
    const testPath = relativeEvidencePath(entry.path, `${label}.tests[${index}].path`);
    if (!testPath.startsWith("tests/")) throw new Error(`${label}.tests[${index}].path must be under tests`);
    return { path: testPath, name: text(entry.name, `${label}.tests[${index}].name`, 256) };
  });
  const liveAcceptance = value.liveAcceptance.map((entry, index) => {
    exactKeys(entry, ["command", "outcome"], `${label}.liveAcceptance[${index}]`);
    if (typeof entry.command !== "string" || !SAFE_COMMAND.test(entry.command)) {
      throw new Error(`${label}.liveAcceptance[${index}].command is invalid`);
    }
    return {
      command: entry.command,
      outcome: text(entry.outcome, `${label}.liveAcceptance[${index}].outcome`, 256),
    };
  });
  return {
    artifacts: uniqueByJson(artifacts),
    tests: uniqueByJson(tests),
    liveAcceptance: uniqueByJson(liveAcceptance),
  };
}

function evidenceLevel(evidence) {
  if (evidence.liveAcceptance.length) return "live_verified";
  if (evidence.tests.length) return "tests_passed";
  if (evidence.artifacts.length) return "inspected";
  return "reported";
}

function validateRootCause(value, label) {
  exactKeys(value, ["status", "summary"], label);
  if (!ROOT_CAUSE_STATES.has(value.status)) throw new Error(`${label}.status is invalid`);
  const summary = text(value.summary, `${label}.summary`, 512, { nullable: true });
  if ((value.status === "unknown") !== (summary === null)) {
    throw new Error(`${label}.summary must be null only for an unknown root cause`);
  }
  return { status: value.status, summary };
}

function validateResolution(value, strategies, label) {
  exactKeys(value, ["kind", "strategyId", "summary"], label);
  if (!RESOLUTION_KINDS.has(value.kind)) throw new Error(`${label}.kind is invalid`);
  if (!(value.strategyId === null || (typeof value.strategyId === "string" && strategies.has(value.strategyId)))) {
    throw new Error(`${label}.strategyId is invalid`);
  }
  const summary = text(value.summary, `${label}.summary`, 512, { nullable: true });
  if ((value.kind === "none") !== (summary === null)) {
    throw new Error(`${label}.summary must be null only when no resolution exists`);
  }
  if (value.kind === "none" && value.strategyId !== null) throw new Error(`${label} cannot bind a strategy without a resolution`);
  return { kind: value.kind, strategyId: value.strategyId, summary };
}

function assertStateEvidence(state, rootCause, resolution, evidence, existing) {
  if (state === "open") {
    if (resolution.kind !== "none") throw new Error("An open incident cannot claim a resolution");
    return;
  }
  if (state === "mitigated") {
    if (resolution.kind === "none" || (!evidence.artifacts.length && !evidence.liveAcceptance.length)) {
      throw new Error("A mitigated incident requires a bounded resolution and inspectable evidence");
    }
    return;
  }
  if (["resolved", "verified"].includes(state)) {
    if (rootCause.status !== "confirmed" || resolution.kind !== "general_fix"
        || !evidence.artifacts.length || !evidence.tests.length) {
      throw new Error(`${state} requires a confirmed cause, general fix, artifacts, and tests`);
    }
    if (state === "verified" && !evidence.liveAcceptance.length) {
      throw new Error("verified requires fresh named HTTP acceptance evidence");
    }
    return;
  }
  if (state === "reopened" && !existing) throw new Error("A new incident cannot start as reopened");
}

function validateCandidateIncident(value, failureCodes, strategies, label, existing = null) {
  exactKeys(value, [
    "fingerprint", "title", "scope", "category", "failureCode", "state", "observation", "rootCause", "resolution", "evidence",
  ], label);
  if (typeof value.fingerprint !== "string" || !SAFE_FINGERPRINT.test(value.fingerprint)) {
    throw new Error(`${label}.fingerprint is invalid`);
  }
  if (typeof value.scope !== "string" || !SAFE_NAME.test(value.scope)
      || typeof value.category !== "string" || !SAFE_NAME.test(value.category)
      || !STATES.has(value.state)
      || !(value.failureCode === null || (typeof value.failureCode === "string" && failureCodes.has(value.failureCode)))) {
    throw new Error(`${label} classification is invalid`);
  }
  const rootCause = validateRootCause(value.rootCause, `${label}.rootCause`);
  const resolution = validateResolution(value.resolution, strategies, `${label}.resolution`);
  const evidence = validateEvidence(value.evidence, `${label}.evidence`);
  assertStateEvidence(value.state, rootCause, resolution, evidence, existing);
  return {
    fingerprint: value.fingerprint,
    title: text(value.title, `${label}.title`, 120),
    scope: value.scope,
    category: value.category,
    failureCode: value.failureCode,
    state: value.state,
    observation: text(value.observation, `${label}.observation`, 512),
    rootCause,
    resolution,
    evidence,
  };
}

function allowedTransition(from, to) {
  const allowed = {
    open: new Set(["open", "mitigated", "resolved", "verified"]),
    mitigated: new Set(["mitigated", "resolved", "verified", "reopened"]),
    resolved: new Set(["resolved", "verified", "reopened"]),
    verified: new Set(["verified", "reopened"]),
    reopened: new Set(["reopened", "mitigated", "resolved", "verified"]),
  };
  return allowed[from]?.has(to) === true;
}

function validateStoredIncident(value, failureCodes, strategies, label) {
  exactKeys(value, [
    "id", "fingerprint", "title", "scope", "category", "failureCode", "state", "evidenceLevel",
    "firstObservedOn", "lastObservedOn", "occurrenceCount", "sessionIds", "observation", "rootCause", "resolution", "evidence",
  ], label);
  if (typeof value.id !== "string" || !/^DCI-\d{4}$/u.test(value.id)
      || !["reported", "inspected", "tests_passed", "live_verified"].includes(value.evidenceLevel)
      || !Number.isSafeInteger(value.occurrenceCount) || value.occurrenceCount < 1
      || !Array.isArray(value.sessionIds) || value.sessionIds.length !== value.occurrenceCount
      || new Set(value.sessionIds).size !== value.sessionIds.length
      || value.sessionIds.some((entry) => typeof entry !== "string" || !SAFE_SESSION.test(entry))) {
    throw new Error(`${label} storage metadata is invalid`);
  }
  const candidate = validateCandidateIncident({
    fingerprint: value.fingerprint,
    title: value.title,
    scope: value.scope,
    category: value.category,
    failureCode: value.failureCode,
    state: value.state,
    observation: value.observation,
    rootCause: value.rootCause,
    resolution: value.resolution,
    evidence: value.evidence,
  }, failureCodes, strategies, label, value);
  const firstObservedOn = exactDate(value.firstObservedOn, `${label}.firstObservedOn`);
  const lastObservedOn = exactDate(value.lastObservedOn, `${label}.lastObservedOn`);
  if (lastObservedOn < firstObservedOn || value.evidenceLevel !== evidenceLevel(candidate.evidence)) {
    throw new Error(`${label} evidence metadata is inconsistent`);
  }
  return { ...candidate, id: value.id, evidenceLevel: value.evidenceLevel, firstObservedOn, lastObservedOn,
    occurrenceCount: value.occurrenceCount, sessionIds: [...value.sessionIds] };
}

export function validateLedger(value, playbook) {
  exactKeys(playbook, ["schemaVersion", "protocol", "description", "decisionOrder", "strategies", "failureCodes"], "playbook");
  const failureCodes = new Set(playbook.failureCodes.map((entry) => entry.code));
  const strategies = new Set(playbook.strategies.map((entry) => entry.id));
  exactKeys(value, ["schemaVersion", "incidents"], "incident ledger");
  if (value.schemaVersion !== 1 || !Array.isArray(value.incidents) || value.incidents.length > 9999) {
    throw new Error("incident ledger metadata is invalid");
  }
  const incidents = value.incidents.map((entry, index) => validateStoredIncident(
    entry, failureCodes, strategies, `incident ledger.incidents[${index}]`,
  ));
  if (new Set(incidents.map((entry) => entry.id)).size !== incidents.length
      || new Set(incidents.map((entry) => entry.fingerprint)).size !== incidents.length) {
    throw new Error("incident ledger identities must be unique");
  }
  incidents.sort((left, right) => left.id.localeCompare(right.id));
  return { schemaVersion: 1, incidents };
}

function mergeEvidence(left, right) {
  return {
    artifacts: uniqueByJson([...left.artifacts, ...right.artifacts]),
    tests: uniqueByJson([...left.tests, ...right.tests]),
    liveAcceptance: uniqueByJson([...left.liveAcceptance, ...right.liveAcceptance]),
  };
}

export function mergeCandidate(value, rawLedger, playbook) {
  const ledger = validateLedger(rawLedger, playbook);
  exactKeys(value, ["sessionId", "sessionDate", "incidents"], "candidate batch");
  if (typeof value.sessionId !== "string" || !SAFE_SESSION.test(value.sessionId)
      || !Array.isArray(value.incidents) || value.incidents.length < 1 || value.incidents.length > 32) {
    throw new Error("candidate batch metadata is invalid");
  }
  const sessionDate = exactDate(value.sessionDate, "candidate batch.sessionDate");
  const failureCodes = new Set(playbook.failureCodes.map((entry) => entry.code));
  const strategies = new Set(playbook.strategies.map((entry) => entry.id));
  const byFingerprint = new Map(ledger.incidents.map((entry) => [entry.fingerprint, entry]));
  let nextId = Math.max(0, ...ledger.incidents.map((entry) => Number(entry.id.slice(4)))) + 1;
  for (let index = 0; index < value.incidents.length; index += 1) {
    const raw = value.incidents[index];
    const existing = plainObject(raw) ? byFingerprint.get(raw.fingerprint) ?? null : null;
    const candidate = validateCandidateIncident(raw, failureCodes, strategies, `candidate batch.incidents[${index}]`, existing);
    if (existing && !allowedTransition(existing.state, candidate.state)) {
      throw new Error(`Invalid incident transition: ${existing.state} -> ${candidate.state}`);
    }
    const evidence = existing ? mergeEvidence(existing.evidence, candidate.evidence) : candidate.evidence;
    assertStateEvidence(candidate.state, candidate.rootCause, candidate.resolution, evidence, existing);
    const sessionIds = existing
      ? [...new Set([...existing.sessionIds, value.sessionId])]
      : [value.sessionId];
    const stored = {
      ...candidate,
      id: existing?.id ?? `DCI-${String(nextId++).padStart(4, "0")}`,
      evidenceLevel: evidenceLevel(evidence),
      firstObservedOn: existing?.firstObservedOn ?? sessionDate,
      lastObservedOn: sessionDate > (existing?.lastObservedOn ?? "") ? sessionDate : existing.lastObservedOn,
      occurrenceCount: sessionIds.length,
      sessionIds,
      evidence,
    };
    byFingerprint.set(stored.fingerprint, stored);
  }
  return validateLedger({ schemaVersion: 1, incidents: [...byFingerprint.values()] }, playbook);
}

async function assertEvidenceFiles(projectRoot, batch) {
  for (const incident of batch.incidents) {
    for (const entry of [...incident.evidence.artifacts, ...incident.evidence.tests]) {
      const absolute = path.resolve(projectRoot, entry.path);
      const relative = path.relative(projectRoot, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Evidence path escaped the project root");
      await access(absolute);
    }
  }
}

function parseArgs(argv) {
  const options = { validate: false, dryRun: false, projectRoot: ".", candidateBase64: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--validate") options.validate = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (["--project-root", "--candidate-base64"].includes(arg)) {
      if (++index >= argv.length) throw new Error(`${arg} requires a value`);
      if (arg === "--project-root") options.projectRoot = argv[index];
      else options.candidateBase64 = argv[index];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.validate === Boolean(options.candidateBase64)) {
    throw new Error("Use exactly one of --validate or --candidate-base64");
  }
  return options;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  const projectRoot = path.resolve(options.projectRoot);
  const ledgerPath = path.join(projectRoot, "config", "device-control-incidents.json");
  const playbookPath = path.join(projectRoot, "config", "device-control-playbook.json");
  const [ledger, playbook] = await Promise.all([
    readFile(ledgerPath, "utf8").then(JSON.parse),
    readFile(playbookPath, "utf8").then(JSON.parse),
  ]);
  if (options.validate) {
    const normalized = validateLedger(ledger, playbook);
    process.stdout.write(`${JSON.stringify({
      valid: true,
      incidents: normalized.incidents.length,
      states: Object.fromEntries([...STATES].map((state) => [
        state, normalized.incidents.filter((entry) => entry.state === state).length,
      ])),
    })}\n`);
    return;
  }
  let batch;
  try {
    const source = Buffer.from(options.candidateBase64, "base64");
    if (!source.length || source.length > 128 * 1024 || source.toString("base64") !== options.candidateBase64) {
      throw new Error("candidate base64 is not canonical or is too large");
    }
    batch = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`Candidate JSON is invalid: ${error.message}`);
  }
  const merged = mergeCandidate(batch, ledger, playbook);
  await assertEvidenceFiles(projectRoot, merged);
  if (!options.dryRun) {
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, ledgerPath);
  }
  process.stdout.write(`${JSON.stringify({
    valid: true,
    dryRun: options.dryRun,
    incidents: merged.incidents.length,
    states: Object.fromEntries([...STATES].map((state) => [state, merged.incidents.filter((entry) => entry.state === state).length])),
  })}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}
