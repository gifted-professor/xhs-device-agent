import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_REVIEW_FIELD_NAMES,
  buildFields,
  listAllRemoteReviewRows,
  mergeReviewStatus,
  normalizeReviewRecord,
  parseJsonLines,
  reconcileReviewStatuses,
  remoteRowsFromRecordList,
  syncReviewQueue,
  validateReviewSyncRecords,
} from "../scripts/sync-research-review.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncScript = path.join(root, "scripts", "sync-research-review.mjs");
const syncWrapper = path.join(root, "scripts", "Sync-ResearchReview.ps1");

function safeReview(overrides = {}) {
  return {
    reviewId: "review-01",
    candidateKey: "candidate-01",
    taskId: "review-task-001",
    topic: "public topic",
    source: "search",
    keyword: "public keyword",
    title: "Public title",
    author: "Public author",
    mediaType: "image",
    reason: "manual decision needed",
    status: "pending_review",
    deviceAlias: "device-01",
    ...overrides,
  };
}

function completeFieldList() {
  return {
    data: {
      fields: [{ name: "Candidate ID", is_primary: true }, ...APPROVED_REVIEW_FIELD_NAMES.map((name) => ({ name }))],
    },
  };
}

test("review JSONL normalization never includes device serials or screenshots", () => {
  const [raw] = parseJsonLines('{"taskId":"t1","candidate":{"candidateId":"c1","title":"Title","deviceAlias":"device-02","serial":"secret","screenshotPath":"secret.png"}}\n');
  const normalized = normalizeReviewRecord(raw);
  assert.equal(normalized.candidateId, "c1");
  assert.equal(normalized.deviceAlias, "device-02");
  assert.equal("serial" in normalized, false);
  assert.equal("screenshotPath" in normalized, false);
});

test("direct review sync entry points repeat the external confirmation gate", () => {
  const direct = spawnSync(process.execPath, [syncScript, "--review", "unused.jsonl"], { encoding: "utf8" });
  assert.notEqual(direct.status, 0);
  assert.match(`${direct.stdout}${direct.stderr}`, /requires --confirm-external-sync/u);

  const unknown = spawnSync(process.execPath, [syncScript, "--base-token", "not-used"], { encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /Unknown review sync option: --base-token/u);

  const wrapper = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", syncWrapper,
    "-ReviewPath", "unused.jsonl", "-ConfigPath", path.join(tmpdir(), "missing-review-config.psd1"),
  ], { encoding: "utf8" });
  assert.notEqual(wrapper.status, 0);
  assert.match(`${wrapper.stdout}${wrapper.stderr}`, /explicit external-sync confirmation/u);
});

test("external review validation is closed to trusted task identity, aliases, fields, and public values", () => {
  const options = { taskId: "review-task-001", approvedAliases: ["device-01"] };
  assert.equal(validateReviewSyncRecords([safeReview()], options)[0].deviceAlias, "device-01");
  assert.throws(
    () => validateReviewSyncRecords([safeReview({ serial: "private" })], options),
    /outside the closed local schema/u,
  );
  assert.throws(
    () => validateReviewSyncRecords([safeReview({ taskId: "other-task-001" })], options),
    /must match its trusted research directory/u,
  );
  assert.throws(
    () => validateReviewSyncRecords([safeReview({ deviceAlias: "other-device" })], options),
    /not approved by the local device mapping/u,
  );
  assert.throws(
    () => validateReviewSyncRecords([safeReview({ title: "C:\\Users\\private\\screen.png" })], options),
    /direct identifier, credential, or local path/u,
  );
  assert.throws(
    () => validateReviewSyncRecords([safeReview({ reviewStatus: "selected" })], options),
    /conflicting local statuses/u,
  );
});

test("primary field follows the target table primary column", () => {
  const fields = buildFields(normalizeReviewRecord({ candidateId: "c1", title: "Title" }), "Existing primary");
  assert.equal(fields["Existing primary"], "c1");
  assert.equal(fields["Review ID"], "c1");
  assert.equal(fields["Candidate key"], "c1");
  assert.equal(fields["Note title"], "Title");
  assert.deepEqual(
    Object.keys(fields).filter((name) => name !== "Existing primary"),
    [...APPROVED_REVIEW_FIELD_NAMES],
  );
  assert.throws(
    () => buildFields(normalizeReviewRecord({ candidateId: "c1" }), "Device alias"),
    /conflicts with an approved review data field/u,
  );
});

test("current human-review rows use reviewId identity and candidateKey metadata", () => {
  const normalized = normalizeReviewRecord({
    reviewId: "review-01",
    candidateKey: "candidate-01",
    reason: "inspect",
    status: "pending_review",
  });
  const fields = buildFields(normalized, "Candidate ID");
  assert.equal(normalized.reviewId, "review-01");
  assert.equal(normalized.candidateKey, "candidate-01");
  assert.equal(fields["Candidate ID"], "review-01");
  assert.equal(fields["Review ID"], "review-01");
  assert.equal(fields["Candidate key"], "candidate-01");
});

test("Feishu finalized status is pulled into the local truth source before upload", () => {
  const local = [{
    reviewId: "review-01",
    candidateKey: "candidate-01",
    reason: "keep this local field",
    status: "pending_review",
  }];
  const result = reconcileReviewStatuses(local, [{
    recordId: "remote-01",
    reviewId: "review-01",
    candidateKey: "candidate-01",
    reviewStatus: "selected",
  }]);
  assert.equal(result.pulled, 1);
  assert.equal(result.records[0].status, "selected");
  assert.equal(result.records[0].reviewStatus, "selected");
  assert.equal(result.records[0].reason, "keep this local field");
  assert.equal(result.normalized[0].reviewStatus, "selected");
  assert.equal(result.matches.get("review-01").recordId, "remote-01");
});

test("legacy Feishu rows match candidateKey only when the local key is unambiguous", () => {
  const records = {
    data: {
      fields: ["Candidate ID", "Review status"],
      record_id_list: ["legacy-record"],
      data: [["candidate-01", "approved"]],
    },
  };
  const remote = remoteRowsFromRecordList(records, "Candidate ID");
  const result = reconcileReviewStatuses([{ reviewId: "review-01", candidateKey: "candidate-01", status: "pending_review" }], remote);
  assert.equal(result.records[0].status, "approved");
  assert.equal(result.matches.get("review-01").recordId, "legacy-record");

  assert.throws(() => reconcileReviewStatuses([
    { reviewId: "review-01", candidateKey: "candidate-01", status: "pending_review" },
    { reviewId: "review-02", candidateKey: "candidate-01", status: "pending_review" },
  ], remote), /Ambiguous legacy Candidate key mapping/);
});

test("Feishu review listing follows offset pages before reconciliation", async () => {
  const calls = [];
  const rows = await listAllRemoteReviewRows({
    baseToken: "base",
    tableId: "table",
    primaryFieldName: "Review ID",
    async invoke(args) {
      calls.push(args);
      const offset = Number(args[args.indexOf("--offset") + 1]);
      if (offset === 0) {
        return {
          data: {
            fields: ["Review ID", "Review status"],
            record_id_list: Array.from({ length: 200 }, (_, index) => `record-${index + 1}`),
            data: Array.from({ length: 200 }, (_, index) => [`review-${index + 1}`, index === 0 ? "selected" : "pending_review"]),
          },
        };
      }
      return {
        data: {
          fields: ["Review ID", "Review status"],
          record_id_list: ["record-201"],
          data: [["review-201", "rejected"]],
          has_more: false,
        },
      };
    },
  });
  assert.equal(rows.length, 201);
  assert.equal(rows[0].reviewId, "review-1");
  assert.equal(rows.at(-1).reviewId, "review-201");
  assert.equal(calls[1][calls[1].indexOf("--offset") + 1], "200");
  assert.equal(calls.every((args) => !args.includes("--page-token")), true);
});

test("a repeated full Feishu page blocks uploads", async () => {
  await assert.rejects(() => listAllRemoteReviewRows({
    baseToken: "base",
    tableId: "table",
    primaryFieldName: "Review ID",
    invoke: async () => ({
      data: {
        fields: ["Review ID", "Review status"],
        record_id_list: Array.from({ length: 200 }, (_, index) => `record-${index}`),
        data: Array.from({ length: 200 }, (_, index) => [`review-${index}`, "pending_review"]),
      },
    }),
  }), /repeated record/);
});

test("a finalized local status is not overwritten by remote pending", () => {
  assert.equal(mergeReviewStatus("approved", "pending_review", "review-01"), "approved");
});

test("conflicting finalized statuses stop synchronization instead of losing either decision", () => {
  assert.throws(
    () => mergeReviewStatus("approved", "rejected", "review-01"),
    /Conflicting finalized review statuses for review-01/,
  );
});

test("external review sync rejects an arbitrary JSONL path before any Lark call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-path-"));
  const researchRoot = path.join(directory, "research");
  const outsidePath = path.join(directory, "human-review.jsonl");
  await mkdir(researchRoot, { recursive: true });
  await writeFile(outsidePath, `${JSON.stringify(safeReview())}\n`, "utf8");
  let invoked = false;
  try {
    await assert.rejects(() => syncReviewQueue({
      reviewPath: outsidePath,
      trustedResearchRoot: researchRoot,
      approvedAliases: ["device-01"],
      baseToken: "base",
      tableId: "table",
      invoke: async () => { invoked = true; return {}; },
    }), /only trusted data\/research task output/u);
    assert.equal(invoked, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty trusted review queue performs no external call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-empty-"));
  const researchRoot = path.join(directory, "research");
  const taskDirectory = path.join(researchRoot, "review-task-001");
  const reviewPath = path.join(taskDirectory, "human-review.jsonl");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(reviewPath, "", "utf8");
  let invoked = false;
  try {
    const result = await syncReviewQueue({
      reviewPath,
      trustedResearchRoot: researchRoot,
      approvedAliases: ["device-01"],
      baseToken: "base",
      tableId: "table",
      invoke: async () => { invoked = true; return {}; },
    });
    assert.deepEqual(result, { synced: 0, statusesPulled: 0 });
    assert.equal(invoked, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("different review queues use isolated payload files during concurrent sync", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-concurrent-"));
  const researchRoot = path.join(directory, "research");
  const captures = [];
  try {
    const inputs = await Promise.all(["review-task-001", "review-task-002"].map(async (taskId, index) => {
      const taskDirectory = path.join(researchRoot, taskId);
      const reviewPath = path.join(taskDirectory, "human-review.jsonl");
      await mkdir(taskDirectory, { recursive: true });
      await writeFile(reviewPath, `${JSON.stringify(safeReview({
        reviewId: `review-0${index + 1}`,
        candidateKey: `candidate-0${index + 1}`,
        taskId,
        topic: `public topic ${index + 1}`,
      }))}\n`, "utf8");
      return { taskId, reviewPath };
    }));
    await Promise.all(inputs.map(({ taskId, reviewPath }) => syncReviewQueue({
      reviewPath,
      trustedResearchRoot: researchRoot,
      approvedAliases: ["device-01"],
      baseToken: "base",
      tableId: "table",
      async invoke(args) {
        if (args[1] === "+field-list") return completeFieldList();
        if (args[1] === "+record-list") return { data: { fields: [], record_id_list: [], data: [] } };
        if (args[1] === "+record-upsert") {
          const argument = args[args.indexOf("--json") + 1];
          captures.push({ argument, payload: JSON.parse(await readFile(argument.slice(1), "utf8")) });
          return { data: {} };
        }
        throw new Error(`Unexpected command for ${taskId}: ${args[1]}`);
      },
    })));
    assert.equal(captures.length, 2);
    assert.equal(new Set(captures.map(({ argument }) => argument)).size, 2);
    assert.deepEqual(new Set(captures.map(({ payload }) => payload["Task ID"])), new Set(inputs.map(({ taskId }) => taskId)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the same review queue cannot be externally synchronized twice at once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-lock-"));
  const researchRoot = path.join(directory, "research");
  const taskDirectory = path.join(researchRoot, "review-task-001");
  const reviewPath = path.join(taskDirectory, "human-review.jsonl");
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(reviewPath, `${JSON.stringify(safeReview())}\n`, "utf8");
  let allowFirst;
  const firstGate = new Promise((resolve) => { allowFirst = resolve; });
  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  try {
    const first = syncReviewQueue({
      reviewPath,
      trustedResearchRoot: researchRoot,
      approvedAliases: ["device-01"],
      baseToken: "base",
      tableId: "table",
      async invoke(args) {
        if (args[1] === "+field-list") {
          announceFirst();
          await firstGate;
          return completeFieldList();
        }
        if (args[1] === "+record-list") return { data: { fields: [], record_id_list: [], data: [] } };
        if (args[1] === "+record-upsert") return { data: {} };
        throw new Error(`Unexpected command: ${args[1]}`);
      },
    });
    await firstStarted;
    await assert.rejects(() => syncReviewQueue({
      reviewPath,
      trustedResearchRoot: researchRoot,
      approvedAliases: ["device-01"],
      baseToken: "base",
      tableId: "table",
      invoke: async () => completeFieldList(),
    }), /already has an active external sync/u);
    allowFirst();
    await first;
  } finally {
    allowFirst?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync pulls a manual Feishu decision atomically and uploads the merged status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-sync-"));
  const researchRoot = path.join(directory, "research");
  const taskId = "review-task-001";
  const taskDirectory = path.join(researchRoot, taskId);
  await mkdir(taskDirectory, { recursive: true });
  const reviewPath = path.join(taskDirectory, "human-review.jsonl");
  const payloadPath = path.join(directory, "payload.json");
  await writeFile(reviewPath, `${JSON.stringify({
    reviewId: "review-01",
    candidateKey: "candidate-01",
    taskId,
    topic: "public topic",
    source: "search",
    deviceAlias: "device-01",
    reason: "manual decision needed",
    status: "pending_review",
  })}\n`, "utf8");
  const required = [...APPROVED_REVIEW_FIELD_NAMES];
  let uploaded = null;
  try {
    const result = await syncReviewQueue({
      reviewPath,
      baseToken: "base",
      tableId: "table",
      approvedAliases: ["device-01"],
      trustedResearchRoot: researchRoot,
      payloadPath,
      payloadArgument: "@payload.json",
      async invoke(args) {
        if (args[1] === "+field-list") {
          return { data: { fields: [{ name: "Candidate ID", is_primary: true }, ...required.map((name) => ({ name }))] } };
        }
        if (args[1] === "+record-list") {
          return {
            data: {
              fields: ["Candidate ID", "Review ID", "Candidate key", "Review status"],
              record_id_list: ["remote-01"],
              data: [["review-01", "review-01", "candidate-01", "selected"]],
            },
          };
        }
        if (args[1] === "+record-upsert") {
          uploaded = JSON.parse(await readFile(payloadPath, "utf8"));
          assert.deepEqual(args.slice(-2), ["--record-id", "remote-01"]);
          return { data: {} };
        }
        throw new Error(`Unexpected command: ${args[1]}`);
      },
    });
    const [saved] = parseJsonLines(await readFile(reviewPath, "utf8"));
    assert.deepEqual(result, { synced: 1, statusesPulled: 1 });
    assert.equal(saved.status, "selected");
    assert.equal(saved.reviewStatus, "selected");
    assert.equal(saved.reason, "manual decision needed");
    assert.equal(uploaded["Review status"], "selected");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
