import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildFields,
  listAllRemoteReviewRows,
  mergeReviewStatus,
  normalizeReviewRecord,
  parseJsonLines,
  reconcileReviewStatuses,
  remoteRowsFromRecordList,
  syncReviewQueue,
} from "../scripts/sync-research-review.mjs";

test("review JSONL normalization never includes device serials or screenshots", () => {
  const [raw] = parseJsonLines('{"taskId":"t1","candidate":{"candidateId":"c1","title":"Title","deviceAlias":"02","serial":"secret","screenshotPath":"secret.png"}}\n');
  const normalized = normalizeReviewRecord(raw);
  assert.equal(normalized.candidateId, "c1");
  assert.equal(normalized.deviceAlias, "02");
  assert.equal("serial" in normalized, false);
  assert.equal("screenshotPath" in normalized, false);
});

test("primary field follows the target table primary column", () => {
  const fields = buildFields(normalizeReviewRecord({ candidateId: "c1", title: "Title" }), "Existing primary");
  assert.equal(fields["Existing primary"], "c1");
  assert.equal(fields["Review ID"], "c1");
  assert.equal(fields["Candidate key"], "c1");
  assert.equal(fields["Note title"], "Title");
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

test("Feishu review listing follows every page token before reconciliation", async () => {
  const calls = [];
  const rows = await listAllRemoteReviewRows({
    baseToken: "base",
    tableId: "table",
    primaryFieldName: "Review ID",
    async invoke(args) {
      calls.push(args);
      if (!args.includes("--page-token")) {
        return {
          data: {
            fields: ["Review ID", "Review status"],
            record_id_list: ["record-1"],
            data: [["review-1", "selected"]],
            has_more: true,
            page_token: "next-1",
          },
        };
      }
      return {
        data: {
          fields: ["Review ID", "Review status"],
          record_id_list: ["record-2"],
          data: [["review-2", "rejected"]],
          has_more: false,
        },
      };
    },
  });
  assert.deepEqual(rows.map((row) => row.reviewId), ["review-1", "review-2"]);
  assert.deepEqual(calls[1].slice(-2), ["--page-token", "next-1"]);
});

test("an ambiguous full Feishu page blocks uploads instead of assuming no page 2", async () => {
  await assert.rejects(() => listAllRemoteReviewRows({
    baseToken: "base",
    tableId: "table",
    primaryFieldName: "Review ID",
    invoke: async () => ({
      data: {
        fields: ["Review ID", "Review status"],
        record_id_list: Array.from({ length: 500 }, (_, index) => `record-${index}`),
        data: Array.from({ length: 500 }, (_, index) => [`review-${index}`, "pending_review"]),
      },
    }),
  }), /did not prove/);
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

test("sync pulls a manual Feishu decision atomically and uploads the merged status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xhs-review-sync-"));
  const reviewPath = path.join(directory, "human-review.jsonl");
  const payloadPath = path.join(directory, "payload.json");
  await writeFile(reviewPath, `${JSON.stringify({
    reviewId: "review-01",
    candidateKey: "candidate-01",
    reason: "manual decision needed",
    status: "pending_review",
  })}\n`, "utf8");
  const required = ["Review ID", "Candidate key", "Task ID", "Topic", "Source", "Keyword", "Note title", "Public author", "Media type", "AI reason", "Review status", "Device alias", "Collected at"];
  let uploaded = null;
  try {
    const result = await syncReviewQueue({
      reviewPath,
      baseToken: "base",
      tableId: "table",
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
