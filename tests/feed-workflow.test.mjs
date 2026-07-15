import test from "node:test";
import assert from "node:assert/strict";

import {
  FeedWorkflowError,
  createFeedCheckpoint,
  deterministicDwellSeconds,
  normalizeFeedSpec,
  runFeedWorkflow,
} from "../scripts/feed-workflow.mjs";

function identity(index) {
  return "feed-item-" + String(index).padStart(3, "0");
}

function fakeAdapter({ active = [], failOpenAt = null, failDwellAt = null, failReturnAt = null } = {}) {
  const calls = [];
  const activeSet = new Set(active);
  return {
    calls,
    async ensureFeed() {
      calls.push(["ensureFeed"]);
      return { verified: true };
    },
    async openNextUnique(seen, index) {
      calls.push(["open", index, [...seen]]);
      if (index === failOpenAt) throw new FeedWorkflowError("OPEN_FAILED", "fixture open failure");
      return {
        identity: identity(index),
        pageType: index % 2 ? "IMAGE_NOTE" : "VIDEO_NOTE",
        evidence: { detail: "evidence/item-" + index + ".xml" },
      };
    },
    async dwell(item, { plannedSeconds }) {
      calls.push(["dwell", item.index, plannedSeconds]);
      if (item.index === failDwellAt) return { verified: false };
      return {
        verified: true,
        actualSeconds: plannedSeconds + 0.1,
        foregroundVerified: true,
        playbackProgressVerified: item.pageType === "VIDEO_NOTE" ? true : null,
        beforeProgressSeconds: item.pageType === "VIDEO_NOTE" ? 4 : null,
        afterProgressSeconds: item.pageType === "VIDEO_NOTE" ? 4 + plannedSeconds : null,
        evidence: { after: "evidence/dwell-" + item.index + ".xml" },
      };
    },
    async inspectAction(action, item) {
      calls.push(["inspect", action, item.index]);
      return {
        active: activeSet.has(action + ":" + item.index),
        evidence: { before: "evidence/" + action + "-before.xml" },
      };
    },
    async activateActionOnce(action, item) {
      calls.push(["activate", action, item.index]);
      return { verified: true, evidence: { after: "evidence/" + action + "-after.xml" } };
    },
    async returnToFeed(item) {
      calls.push(["return", item.index]);
      if (item.index === failReturnAt) return { verified: false };
      return { verified: true, evidence: { returned: "evidence/returned-" + item.index + ".xml" } };
    },
  };
}

test("feed workflow counts ten unique details and acts only at positions five and ten", async () => {
  const adapter = fakeAdapter();
  const checkpoints = [];
  const summary = await runFeedWorkflow({
    spec: { taskId: "feed-sequence-001", count: 10, likeAt: 5, favoriteAt: 10 },
    deviceAlias: "device-01",
    adapter,
    saveCheckpoint: async (value) => checkpoints.push(structuredClone(value)),
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.viewedCount, 10);
  assert.deepEqual(summary.items.map((item) => item.identity), Array.from({ length: 10 }, (_, i) => identity(i + 1)));
  assert.deepEqual(
    adapter.calls.filter(([name]) => name === "activate").map(([, action, index]) => [action, index]),
    [["like", 5], ["favorite", 10]],
  );
  assert.equal(summary.items[4].actions.like.verification, "verified_active");
  assert.equal(summary.items[9].actions.favorite.verification, "verified_active");
  for (const item of summary.items) {
    if (item.pageType === "VIDEO_NOTE") {
      assert.ok(item.dwell.plannedSeconds >= 10 && item.dwell.plannedSeconds <= 20);
      assert.equal(item.dwell.playbackProgressVerified, true);
      assert.ok(item.dwell.playbackProgressAfterSeconds > item.dwell.playbackProgressBeforeSeconds);
    } else {
      assert.ok(item.dwell.plannedSeconds >= 3 && item.dwell.plannedSeconds <= 6);
      assert.equal(item.dwell.playbackProgressVerified, null);
    }
    assert.equal(item.dwell.foregroundVerified, true);
  }
  assert.ok(checkpoints.some((entry) => entry.inFlightItem?.actions?.like?.phase === "send_intent"));
  assert.ok(checkpoints.some((entry) => entry.inFlightItem?.actions?.favorite?.phase === "send_intent"));
  assert.equal(checkpoints.at(-1).inFlightItem, null);
  assert.equal(checkpoints.at(-1).items.every((item) => item.phase === "committed"), true);
});

test("already active like and favorite are idempotent no-ops", async () => {
  const adapter = fakeAdapter({ active: ["like:2", "favorite:3"] });
  const summary = await runFeedWorkflow({
    spec: { taskId: "feed-idempotent-001", count: 3, likeAt: 2, favoriteAt: 3 },
    deviceAlias: "device-01",
    adapter,
  });

  assert.equal(adapter.calls.some(([name]) => name === "activate"), false);
  assert.equal(summary.items[1].actions.like.outcome, "idempotent_noop");
  assert.equal(summary.items[2].actions.favorite.outcome, "idempotent_noop");
});

test("a navigation failure stops the sequence before later items or actions", async () => {
  const adapter = fakeAdapter({ failOpenAt: 4 });
  let lastCheckpoint;
  await assert.rejects(
    runFeedWorkflow({
      spec: { taskId: "feed-stop-001", count: 10, likeAt: 5, favoriteAt: 10 },
      deviceAlias: "device-01",
      adapter,
      saveCheckpoint: async (value) => { lastCheckpoint = structuredClone(value); },
    }),
    /fixture open failure/u,
  );
  assert.equal(lastCheckpoint.status, "failed");
  assert.equal(lastCheckpoint.items.length, 3);
  assert.equal(adapter.calls.some(([name]) => name === "activate"), false);
  assert.equal(adapter.calls.some(([name, index]) => name === "open" && index > 4), false);
});

test("a dwell verification failure stops before the scheduled interaction", async () => {
  const adapter = fakeAdapter({ failDwellAt: 5 });
  let lastCheckpoint;
  await assert.rejects(
    runFeedWorkflow({
      spec: { taskId: "feed-dwell-stop-001", count: 10, likeAt: 5, favoriteAt: 10 },
      deviceAlias: "device-01",
      adapter,
      saveCheckpoint: async (value) => { lastCheckpoint = structuredClone(value); },
    }),
    /dwell interval was not verified/u,
  );
  assert.equal(lastCheckpoint.status, "failed");
  assert.equal(lastCheckpoint.items.length, 4);
  assert.equal(lastCheckpoint.inFlightItem.index, 5);
  assert.equal(lastCheckpoint.inFlightItem.phase, "opened");
  assert.equal(adapter.calls.some(([name]) => name === "activate"), false);
  assert.equal(adapter.calls.some(([name, index]) => name === "open" && index > 5), false);
});

test("a return verification failure leaves the item in flight and does not count it", async () => {
  const adapter = fakeAdapter({ failReturnAt: 2 });
  let lastCheckpoint;
  await assert.rejects(
    runFeedWorkflow({
      spec: { taskId: "feed-return-stop-001", count: 2 },
      deviceAlias: "device-01",
      adapter,
      saveCheckpoint: async (value) => { lastCheckpoint = structuredClone(value); },
    }),
    (error) => error.code === "RETURN_TO_FEED_FAILED",
  );
  assert.equal(lastCheckpoint.items.length, 1);
  assert.equal(lastCheckpoint.inFlightItem.index, 2);
  assert.equal(lastCheckpoint.inFlightItem.phase, "actions_verified");
  assert.equal(lastCheckpoint.inFlightItem.returnedToFeed, false);
});

test("an unclassified detail stops before dwell or interaction", async () => {
  const adapter = fakeAdapter();
  adapter.openNextUnique = async () => ({ identity: identity(1), pageType: "UNKNOWN" });
  await assert.rejects(
    runFeedWorkflow({
      spec: { taskId: "feed-page-type-stop-001", count: 1, likeAt: 1 },
      deviceAlias: "device-01",
      adapter,
    }),
    (error) => error.code === "PAGE_TYPE_UNVERIFIED",
  );
  assert.equal(adapter.calls.some(([name]) => name === "dwell" || name === "activate"), false);
});

test("a recovered unsupported candidate is persisted and does not consume an item position", async () => {
  const adapter = fakeAdapter();
  const originalOpen = adapter.openNextUnique;
  let skipped = false;
  adapter.openNextUnique = async (seen, index) => {
    if (!skipped) {
      skipped = true;
      return {
        skipped: true,
        identity: "commercial-card-001",
        pageState: "UNKNOWN",
        reason: "commercial_cta",
        evidence: { unsupported: "evidence/commercial.xml", returned: "evidence/feed.xml" },
      };
    }
    return originalOpen(seen, index);
  };
  const events = [];
  let lastCheckpoint;
  const summary = await runFeedWorkflow({
    spec: { taskId: "feed-skip-commercial-001", count: 1 },
    deviceAlias: "device-01",
    adapter,
    emit: async (event) => events.push(event),
    saveCheckpoint: async (value) => { lastCheckpoint = structuredClone(value); },
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.viewedCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.items[0].index, 1);
  assert.equal(summary.skipped[0].identity, "commercial-card-001");
  assert.equal(lastCheckpoint.skipped[0].reason, "commercial_cta");
  assert.equal(events.some((event) => event.type === "item_skipped" && event.targetIndex === 1), true);
  assert.deepEqual(
    adapter.calls.find(([name]) => name === "open"),
    ["open", 1, ["commercial-card-001"]],
  );
});

test("dwell must verify duration and foreground before interaction", async () => {
  for (const [taskId, result] of [
    ["feed-dwell-short-001", { verified: true, actualSeconds: 0, foregroundVerified: true }],
    ["feed-dwell-background-001", { verified: true, actualSeconds: 60, foregroundVerified: false }],
  ]) {
    const adapter = fakeAdapter();
    adapter.dwell = async () => result;
    await assert.rejects(
      runFeedWorkflow({
        spec: { taskId, count: 1, likeAt: 1 },
        deviceAlias: "device-01",
        adapter,
      }),
      (error) => error.code === "DWELL_NOT_VERIFIED",
    );
    assert.equal(adapter.calls.some(([name]) => name === "activate"), false);
  }
});

test("an unresolved send intent blocks resume without replay", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-unknown-001", count: 2, likeAt: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.items.push({
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    returnedToFeed: false,
    evidence: {},
    actions: {
      like: { operationId: "operation-1", phase: "send_intent", outcome: null, verification: null, evidence: {} },
    },
  });
  const adapter = fakeAdapter();
  await assert.rejects(
    runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint }),
    (error) => error.code === "ACTION_OUTCOME_UNKNOWN",
  );
  assert.deepEqual(adapter.calls, []);
});

test("a crash after opening does not count the in-flight item and resumes with a new identity", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-resume-opened-001", count: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.status = "failed";
  checkpoint.inFlightItem = {
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    phase: "opened",
    returnedToFeed: false,
    dwell: null,
    actions: {},
    evidence: { detail: "evidence/opened.xml" },
  };
  const adapter = fakeAdapter();
  adapter.openNextUnique = async (seen, index) => {
    adapter.calls.push(["open", index, [...seen]]);
    return { identity: identity(2), pageType: "IMAGE_NOTE", evidence: {} };
  };

  const summary = await runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint });

  assert.equal(summary.viewedCount, 1);
  assert.equal(summary.items[0].identity, identity(2));
  assert.equal(summary.items[0].phase, "committed");
  assert.equal(summary.skipped[0].identity, identity(1));
  assert.equal(summary.skipped[0].reason, "interrupted_before_dwell_verified");
  assert.deepEqual(adapter.calls.find(([name]) => name === "open"), ["open", 1, [identity(1)]]);
});

test("a crash after verified dwell commits a read-only item only after Feed is re-verified", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-resume-dwell-001", count: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.status = "failed";
  checkpoint.inFlightItem = {
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    phase: "dwell_verified",
    returnedToFeed: false,
    dwell: { actualSeconds: 3, foregroundVerified: true },
    actions: {},
    evidence: { detail: "evidence/detail.xml" },
  };
  const adapter = fakeAdapter();

  const summary = await runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint });

  assert.equal(summary.viewedCount, 1);
  assert.equal(summary.items[0].phase, "committed");
  assert.equal(summary.items[0].returnedToFeed, true);
  assert.equal(summary.items[0].evidence.resumedToFeed, true);
  assert.deepEqual(adapter.calls, [["ensureFeed"]]);
});

test("a crash before a scheduled action never moves that action to the interrupted item", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-resume-action-001", count: 1, likeAt: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.status = "failed";
  checkpoint.inFlightItem = {
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    phase: "dwell_verified",
    returnedToFeed: false,
    dwell: { actualSeconds: 3, foregroundVerified: true },
    actions: {},
    evidence: {},
  };
  const adapter = fakeAdapter();
  adapter.openNextUnique = async (seen, index) => {
    adapter.calls.push(["open", index, [...seen]]);
    return { identity: identity(2), pageType: "IMAGE_NOTE", evidence: {} };
  };

  const summary = await runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint });

  assert.equal(summary.items[0].identity, identity(2));
  assert.deepEqual(
    adapter.calls.filter(([name]) => name === "activate").map(([, action, index]) => [action, index]),
    [["like", 1]],
  );
  assert.equal(summary.skipped[0].reason, "interrupted_before_scheduled_action");
});

test("a crash after return verification commits without reopening or replaying actions", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-resume-return-001", count: 1, likeAt: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.status = "failed";
  checkpoint.inFlightItem = {
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    phase: "returned_verified",
    returnedToFeed: true,
    dwell: { actualSeconds: 3, foregroundVerified: true },
    actions: {
      like: { operationId: "operation-1", phase: "verified", outcome: "completed", verification: "verified_active", evidence: {} },
    },
    evidence: { returned: "evidence/feed.xml" },
  };
  const adapter = fakeAdapter();

  const summary = await runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint });

  assert.equal(summary.viewedCount, 1);
  assert.equal(summary.items[0].phase, "committed");
  assert.equal(summary.items[0].actions.like.verification, "verified_active");
  assert.equal(adapter.calls.some(([name]) => name === "open" || name === "activate"), false);
});

test("a completed taskId returns a duplicate summary without touching the device", async () => {
  const spec = normalizeFeedSpec({ taskId: "feed-complete-001", count: 1 });
  const checkpoint = createFeedCheckpoint(spec, "device-01");
  checkpoint.status = "completed";
  checkpoint.items.push({
    index: 1,
    identity: identity(1),
    pageType: "IMAGE_NOTE",
    returnedToFeed: true,
    evidence: {},
    actions: {},
  });
  const adapter = fakeAdapter();
  const summary = await runFeedWorkflow({ spec, deviceAlias: "device-01", adapter, checkpoint });
  assert.equal(summary.duplicate, true);
  assert.deepEqual(adapter.calls, []);
});

test("feed specification rejects out-of-range values and accepts both actions at one position", () => {
  assert.throws(() => normalizeFeedSpec({ taskId: "feed-invalid-001", count: 0 }), /count/u);
  assert.throws(() => normalizeFeedSpec({ taskId: "feed-invalid-002", count: 10, likeAt: 11 }), /likeAt/u);
  const samePosition = normalizeFeedSpec({ taskId: "feed-same-position-001", count: 10, likeAt: 5, favoriteAt: 5 });
  assert.equal(samePosition.likeAt, 5);
  assert.equal(samePosition.favoriteAt, 5);
  assert.throws(
    () => normalizeFeedSpec({ taskId: "feed-invalid-004", count: 10, videoMinSeconds: 20, videoMaxSeconds: 10 }),
    /minimums/u,
  );
  assert.throws(
    () => normalizeFeedSpec({ taskId: "feed-invalid-005", count: 10, videoPolicy: "fast" }),
    /videoPolicy/u,
  );
  assert.throws(
    () => normalizeFeedSpec({ taskId: "feed-invalid-006", count: 10, videoDwellMs: -1 }),
    /videoDwellMs/u,
  );
  assert.throws(
    () => normalizeFeedSpec({ taskId: "feed-invalid-007", count: 10, videoDwellMs: 20001 }),
    /videoDwellMs/u,
  );
  assert.throws(
    () => normalizeFeedSpec({ taskId: "feed-invalid-008", count: 10, videoDwellMs: 1.5 }),
    /videoDwellMs/u,
  );
});

test("feed specification accepts video policy and millisecond dwell overrides", () => {
  const defaults = normalizeFeedSpec({ taskId: "feed-video-defaults-001", count: 1 });
  assert.equal(defaults.videoPolicy, "normal");
  assert.equal(defaults.videoDwellMs, null);

  const configured = normalizeFeedSpec({
    taskId: "feed-video-configured-001",
    count: 1,
    videoPolicy: "skip_and_count",
    videoDwellMs: 0,
  });
  assert.equal(configured.videoPolicy, "skip_and_count");
  assert.equal(configured.videoDwellMs, 0);
});

test("skip_and_count records a video with zero dwell without calling the adapter timer", async () => {
  const adapter = fakeAdapter();
  adapter.openNextUnique = async () => ({
    identity: identity(1),
    pageType: "VIDEO_NOTE",
    evidence: { detailVisited: true, returnedToList: false, videoSkipped: false },
  });
  const summary = await runFeedWorkflow({
    spec: {
      taskId: "feed-video-skip-001",
      count: 1,
      videoPolicy: "skip_and_count",
      videoDwellMs: 0,
    },
    deviceAlias: "device-01",
    adapter,
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.viewedCount, 1);
  assert.equal(summary.items[0].dwell.plannedSeconds, 0);
  assert.equal(summary.items[0].dwell.actualSeconds, 0);
  assert.equal(summary.items[0].dwell.foregroundVerified, true);
  assert.equal(summary.items[0].dwell.playbackProgressVerified, null);
  assert.equal(summary.items[0].evidence.videoSkipped, true);
  assert.equal(adapter.calls.some(([name]) => name === "dwell"), false);
});

test("dwell duration is deterministic per task, item identity, and media type", () => {
  const spec = normalizeFeedSpec({ taskId: "feed-dwell-001", count: 2 });
  const imageFirst = deterministicDwellSeconds(spec, identity(1), "IMAGE_NOTE");
  const imageSecond = deterministicDwellSeconds(spec, identity(1), "IMAGE_NOTE");
  const video = deterministicDwellSeconds(spec, identity(1), "VIDEO_NOTE");
  assert.equal(imageFirst, imageSecond);
  assert.ok(imageFirst >= 3 && imageFirst <= 6);
  assert.ok(video >= 10 && video <= 20);

  const millisecondVideo = deterministicDwellSeconds(
    { taskId: "feed-dwell-ms-001", count: 1, videoDwellMs: 1250 },
    identity(1),
    "VIDEO_NOTE",
  );
  assert.equal(millisecondVideo, 1.25);
});
