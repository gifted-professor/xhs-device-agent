import { createHash } from "node:crypto";

const ACTION_NAMES = Object.freeze(["like", "favorite"]);
const DETAIL_PAGE_TYPES = new Set(["IMAGE_NOTE", "VIDEO_NOTE"]);
const VIDEO_POLICIES = new Set(["normal", "skip_and_count"]);
const ITEM_PHASES = new Set(["opened", "dwell_verified", "actions_verified", "returned_verified", "committed"]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const DEFAULT_DWELL = Object.freeze({
  imageMinSeconds: 3,
  imageMaxSeconds: 6,
  videoMinSeconds: 10,
  videoMaxSeconds: 20,
});

export class FeedWorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FeedWorkflowError";
    this.code = code;
    Object.assign(this, details);
  }
}

function asBoundedInteger(value, name, minimum, maximum, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new FeedWorkflowError("INVALID_SPEC", name + " must be an integer from " + minimum + " to " + maximum);
  }
  return number;
}

export function normalizeFeedSpec(input = {}) {
  const taskId = String(input.taskId ?? "").trim();
  if (!SAFE_TASK_ID.test(taskId)) {
    throw new FeedWorkflowError("INVALID_SPEC", "taskId must be 3-80 safe characters");
  }
  const count = asBoundedInteger(input.count, "count", 1, Number.MAX_SAFE_INTEGER);
  const likeAt = asBoundedInteger(input.likeAt, "likeAt", 1, count, { optional: true });
  const favoriteAt = asBoundedInteger(input.favoriteAt, "favoriteAt", 1, count, { optional: true });
  const imageMinSeconds = asBoundedInteger(
    input.imageMinSeconds ?? DEFAULT_DWELL.imageMinSeconds,
    "imageMinSeconds",
    1,
    60,
  );
  const imageMaxSeconds = asBoundedInteger(
    input.imageMaxSeconds ?? DEFAULT_DWELL.imageMaxSeconds,
    "imageMaxSeconds",
    1,
    60,
  );
  const videoMinSeconds = asBoundedInteger(
    input.videoMinSeconds ?? DEFAULT_DWELL.videoMinSeconds,
    "videoMinSeconds",
    1,
    60,
  );
  const videoMaxSeconds = asBoundedInteger(
    input.videoMaxSeconds ?? DEFAULT_DWELL.videoMaxSeconds,
    "videoMaxSeconds",
    1,
    60,
  );
  if (imageMinSeconds > imageMaxSeconds || videoMinSeconds > videoMaxSeconds) {
    throw new FeedWorkflowError("INVALID_SPEC", "Dwell minimums cannot exceed their maximums");
  }
  const videoPolicy = String(input.videoPolicy ?? "normal").trim();
  if (!VIDEO_POLICIES.has(videoPolicy)) {
    throw new FeedWorkflowError("INVALID_SPEC", "videoPolicy must be normal or skip_and_count");
  }
  const videoDwellMs = asBoundedInteger(input.videoDwellMs, "videoDwellMs", 0, 20000, { optional: true });
  return Object.freeze({
    schemaVersion: 1,
    taskId,
    count,
    likeAt,
    favoriteAt,
    imageMinSeconds,
    imageMaxSeconds,
    videoMinSeconds,
    videoMaxSeconds,
    videoPolicy,
    videoDwellMs,
  });
}

export function feedSpecHash(specInput) {
  const spec = normalizeFeedSpec(specInput);
  return createHash("sha256").update(JSON.stringify(spec), "utf8").digest("hex");
}

function operationId(spec, identity, action) {
  return createHash("sha256")
    .update(spec.taskId + "\n" + identity + "\n" + action, "utf8")
    .digest("hex")
    .slice(0, 24);
}

export function deterministicDwellSeconds(specInput, identity, pageType) {
  const spec = normalizeFeedSpec(specInput);
  const video = String(pageType) === "VIDEO_NOTE";
  if (video && spec.videoPolicy === "skip_and_count") return 0;
  if (video && spec.videoDwellMs !== null) return spec.videoDwellMs / 1000;
  const minimum = video ? spec.videoMinSeconds : spec.imageMinSeconds;
  const maximum = video ? spec.videoMaxSeconds : spec.imageMaxSeconds;
  const digest = createHash("sha256")
    .update(spec.taskId + "\n" + String(identity) + "\n" + String(pageType), "utf8")
    .digest();
  return minimum + (digest.readUInt32BE(0) % (maximum - minimum + 1));
}

export function createFeedCheckpoint(specInput, deviceAlias, now = new Date().toISOString()) {
  const spec = normalizeFeedSpec(specInput);
  return {
    schemaVersion: 1,
    taskId: spec.taskId,
    specHash: feedSpecHash(spec),
    deviceAlias: String(deviceAlias ?? ""),
    status: "running",
    createdAt: now,
    updatedAt: now,
    failureSignature: null,
    skipped: [],
    inFlightItem: null,
    items: [],
  };
}

function actionAt(spec, index) {
  const actions = [];
  if (spec.likeAt === index) actions.push("like");
  if (spec.favoriteAt === index) actions.push("favorite");
  return actions;
}

function itemIsSkippedVideo(spec, pageType) {
  return spec.videoPolicy === "skip_and_count" && pageType === "VIDEO_NOTE";
}

function inferLegacyItemPhase(item) {
  if (item?.returnedToFeed === true) return "committed";
  const actions = Object.values(item?.actions ?? {});
  if (actions.some((record) => record?.phase === "verified")) return "actions_verified";
  if (
    item?.dwell?.foregroundVerified === true &&
    Number.isFinite(Number(item?.dwell?.actualSeconds))
  ) return "dwell_verified";
  return "opened";
}

function normalizeCheckpointLifecycle(checkpoint) {
  if (!Array.isArray(checkpoint.items)) checkpoint.items = [];
  if (!Array.isArray(checkpoint.skipped)) checkpoint.skipped = [];
  if (!Object.hasOwn(checkpoint, "inFlightItem")) checkpoint.inFlightItem = null;

  const incomplete = checkpoint.items.filter((item) => item?.returnedToFeed !== true);
  if (incomplete.length > 1 || (incomplete.length === 1 && checkpoint.items.at(-1) !== incomplete[0])) {
    throw new FeedWorkflowError("INVALID_CHECKPOINT", "Feed checkpoint contains multiple or non-trailing incomplete items");
  }
  if (incomplete.length === 1) {
    if (checkpoint.inFlightItem) {
      throw new FeedWorkflowError("INVALID_CHECKPOINT", "Feed checkpoint contains two in-flight items");
    }
    checkpoint.inFlightItem = checkpoint.items.pop();
  }
  for (const item of checkpoint.items) item.phase ??= "committed";
  if (checkpoint.inFlightItem) checkpoint.inFlightItem.phase ??= inferLegacyItemPhase(checkpoint.inFlightItem);
}

function checkpointItems(checkpoint) {
  return [...checkpoint.items, ...(checkpoint.inFlightItem ? [checkpoint.inFlightItem] : [])];
}

function requiredActionsVerified(spec, item) {
  return actionAt(spec, item.index).every((action) => item.actions?.[action]?.phase === "verified");
}

function itemDwellVerified(item) {
  return item?.dwell?.foregroundVerified === true && Number.isFinite(Number(item?.dwell?.actualSeconds));
}

function assertCheckpoint(checkpoint, spec, deviceAlias) {
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.taskId !== spec.taskId) {
    throw new FeedWorkflowError("INVALID_CHECKPOINT", "Feed checkpoint identity is invalid");
  }
  if (checkpoint.specHash !== feedSpecHash(spec)) {
    throw new FeedWorkflowError("TASK_CONFLICT", "The taskId already exists with a different feed specification");
  }
  if (checkpoint.deviceAlias !== String(deviceAlias ?? "")) {
    throw new FeedWorkflowError("TASK_CONFLICT", "The taskId is bound to a different device alias");
  }
  normalizeCheckpointLifecycle(checkpoint);
  if (checkpoint.items.length > spec.count) {
    throw new FeedWorkflowError("INVALID_CHECKPOINT", "Feed checkpoint contains more committed items than requested");
  }
  if (
    checkpoint.status === "completed" &&
    (checkpoint.inFlightItem !== null || checkpoint.items.length !== spec.count)
  ) {
    throw new FeedWorkflowError("INVALID_CHECKPOINT", "Completed feed checkpoint is not fully committed");
  }
  for (const item of checkpointItems(checkpoint)) {
    if (!ITEM_PHASES.has(item.phase)) {
      throw new FeedWorkflowError("INVALID_CHECKPOINT", "Feed checkpoint contains an invalid item phase");
    }
    for (const action of ACTION_NAMES) {
      if (item.actions?.[action]?.phase === "send_intent") {
        throw new FeedWorkflowError(
          "ACTION_OUTCOME_UNKNOWN",
          "A previous " + action + " reached its send boundary; the workflow will not replay it",
          { action, operationId: item.actions[action].operationId },
        );
      }
    }
  }
}

function workflowSummary(checkpoint, duplicate = false) {
  const skipped = Array.isArray(checkpoint.skipped) ? checkpoint.skipped : [];
  return {
    schemaVersion: 1,
    taskId: checkpoint.taskId,
    deviceAlias: checkpoint.deviceAlias,
    status: checkpoint.status,
    duplicate,
    viewedCount: checkpoint.items.length,
    skippedCount: skipped.length,
    failureSignature: checkpoint.failureSignature,
    inFlightItem: checkpoint.inFlightItem ? {
      index: checkpoint.inFlightItem.index,
      identity: checkpoint.inFlightItem.identity,
      pageType: checkpoint.inFlightItem.pageType,
      phase: checkpoint.inFlightItem.phase,
      returnedToFeed: checkpoint.inFlightItem.returnedToFeed,
      actions: checkpoint.inFlightItem.actions,
      dwell: checkpoint.inFlightItem.dwell,
      evidence: checkpoint.inFlightItem.evidence,
    } : null,
    skipped: skipped.map((entry) => ({
      targetIndex: entry.targetIndex,
      identity: entry.identity,
      pageState: entry.pageState,
      reason: entry.reason,
      evidence: entry.evidence,
    })),
    items: checkpoint.items.map((item) => ({
      index: item.index,
      identity: item.identity,
      pageType: item.pageType,
      phase: item.phase,
      returnedToFeed: item.returnedToFeed,
      actions: item.actions,
      dwell: item.dwell,
      evidence: item.evidence,
    })),
  };
}

export async function runFeedWorkflow({
  spec: specInput,
  deviceAlias,
  adapter,
  checkpoint: suppliedCheckpoint,
  saveCheckpoint = async () => {},
  emit = async () => {},
  now = () => new Date().toISOString(),
} = {}) {
  const spec = normalizeFeedSpec(specInput);
  if (
    !adapter ||
    typeof adapter.ensureFeed !== "function" ||
    typeof adapter.openNextUnique !== "function" ||
    typeof adapter.dwell !== "function"
  ) {
    throw new FeedWorkflowError("INVALID_ADAPTER", "Feed adapter is incomplete");
  }
  const checkpoint = suppliedCheckpoint ?? createFeedCheckpoint(spec, deviceAlias, now());
  assertCheckpoint(checkpoint, spec, deviceAlias);
  if (checkpoint.status === "completed") return workflowSummary(checkpoint, true);

  checkpoint.status = "running";
  checkpoint.failureSignature = null;
  checkpoint.updatedAt = now();
  await saveCheckpoint(checkpoint);
  await emit({
    type: "started",
    taskId: spec.taskId,
    resumed: checkpoint.items.length > 0 || checkpoint.inFlightItem !== null,
  });

  try {
    const feedReady = await adapter.ensureFeed();
    if (!feedReady?.verified) {
      throw new FeedWorkflowError("FEED_NOT_VERIFIED", "The workflow did not verify the feed before continuing");
    }

    if (checkpoint.inFlightItem) {
      const item = checkpoint.inFlightItem;
      const canCommit = itemDwellVerified(item) && requiredActionsVerified(spec, item);
      if (canCommit) {
        item.returnedToFeed = true;
        item.phase = "committed";
        item.committedAt = now();
        item.evidence = { ...item.evidence, ...(feedReady.evidence ?? {}), resumedToFeed: true };
        checkpoint.items.push(item);
        checkpoint.inFlightItem = null;
        checkpoint.updatedAt = now();
        await saveCheckpoint(checkpoint);
        await emit({ type: "item_committed_after_resume", index: item.index, identity: item.identity });
      } else {
        const interrupted = {
          targetIndex: item.index,
          identity: item.identity,
          pageState: item.pageType,
          reason: itemDwellVerified(item)
            ? "interrupted_before_scheduled_action"
            : "interrupted_before_dwell_verified",
          skippedAt: now(),
          evidence: { ...item.evidence, resumedToFeed: true },
        };
        checkpoint.skipped.push(interrupted);
        checkpoint.inFlightItem = null;
        checkpoint.updatedAt = now();
        await saveCheckpoint(checkpoint);
        await emit({ type: "item_interrupted_recovered", ...interrupted });
      }
    }

    const seen = new Set(
      [...checkpoint.items, ...checkpoint.skipped]
        .map((entry) => entry.identity)
        .filter((identity) => typeof identity === "string" && identity.length >= 8),
    );
    while (checkpoint.items.length < spec.count) {
      const index = checkpoint.items.length + 1;
      const opened = await adapter.openNextUnique(seen, index);
      if (opened?.skipped === true) {
        if (typeof opened.identity !== "string" || opened.identity.length < 8) {
          throw new FeedWorkflowError("ITEM_IDENTITY_UNVERIFIED", "A skipped feed candidate did not expose a stable identity");
        }
        if (seen.has(opened.identity)) {
          throw new FeedWorkflowError("DUPLICATE_ITEM", "The feed adapter returned an already skipped candidate");
        }
        const skipped = {
          targetIndex: index,
          identity: opened.identity,
          pageState: String(opened.pageState ?? "UNKNOWN"),
          reason: String(opened.reason ?? "unsupported_page_type"),
          skippedAt: now(),
          evidence: opened.evidence ?? {},
        };
        checkpoint.skipped.push(skipped);
        seen.add(skipped.identity);
        checkpoint.updatedAt = now();
        await saveCheckpoint(checkpoint);
        await emit({ type: "item_skipped", ...skipped });
        continue;
      }
      if (!opened || typeof opened.identity !== "string" || opened.identity.length < 8) {
        throw new FeedWorkflowError("ITEM_IDENTITY_UNVERIFIED", "The next feed item did not expose a stable identity");
      }
      if (seen.has(opened.identity)) {
        throw new FeedWorkflowError("DUPLICATE_ITEM", "The feed adapter returned an already counted item");
      }
      if (!DETAIL_PAGE_TYPES.has(opened.pageType)) {
        throw new FeedWorkflowError(
          "PAGE_TYPE_UNVERIFIED",
          "The opened feed item was not classified as an image note or video note",
        );
      }

      const item = {
        index,
        identity: opened.identity,
        pageType: opened.pageType ?? "UNKNOWN",
        phase: "opened",
        openedAt: now(),
        returnedToFeed: false,
        dwell: null,
        actions: {},
        evidence: {
          ...(opened.evidence ?? {}),
          videoSkipped: itemIsSkippedVideo(spec, opened.pageType),
        },
      };
      checkpoint.inFlightItem = item;
      seen.add(item.identity);
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);
      await emit({ type: "item_opened", index, identity: item.identity, pageType: item.pageType });

      const plannedSeconds = deterministicDwellSeconds(spec, item.identity, item.pageType);
      item.dwell = {
        mediaType: item.pageType === "VIDEO_NOTE" ? "video" : "image",
        mediaTypeSource: "detail_classification",
        plannedSeconds,
        actualSeconds: null,
        foregroundVerified: false,
        playbackProgressVerified: null,
        playbackProgressBeforeSeconds: null,
        playbackProgressAfterSeconds: null,
        evidence: {},
      };
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);
      const dwellResult = itemIsSkippedVideo(spec, item.pageType)
        ? {
            verified: true,
            actualSeconds: 0,
            foregroundVerified: true,
            playbackProgressVerified: null,
            evidence: { videoPolicy: spec.videoPolicy },
          }
        : await adapter.dwell(item, { plannedSeconds });
      const actualSeconds = Number(dwellResult?.actualSeconds);
      if (
        !dwellResult?.verified ||
        dwellResult.foregroundVerified !== true ||
        !Number.isFinite(actualSeconds) ||
        actualSeconds < plannedSeconds ||
        (item.pageType === "VIDEO_NOTE" && dwellResult.playbackProgressVerified === false)
      ) {
        throw new FeedWorkflowError("DWELL_NOT_VERIFIED", "The item dwell interval was not verified");
      }
      item.dwell.actualSeconds = actualSeconds;
      item.dwell.foregroundVerified = true;
      item.dwell.playbackProgressVerified = dwellResult.playbackProgressVerified ?? null;
      item.dwell.playbackProgressBeforeSeconds = dwellResult.beforeProgressSeconds ?? null;
      item.dwell.playbackProgressAfterSeconds = dwellResult.afterProgressSeconds ?? null;
      item.dwell.evidence = dwellResult.evidence ?? {};
      item.phase = "dwell_verified";
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);
      await emit({
        type: "item_dwell_verified",
        index,
        mediaType: item.dwell.mediaType,
        plannedSeconds,
        actualSeconds: item.dwell.actualSeconds,
        foregroundVerified: true,
        playbackProgressVerified: item.dwell.playbackProgressVerified,
        playbackProgressBeforeSeconds: item.dwell.playbackProgressBeforeSeconds,
        playbackProgressAfterSeconds: item.dwell.playbackProgressAfterSeconds,
      });

      for (const action of actionAt(spec, index)) {
        const inspected = await adapter.inspectAction(action, item);
        const record = {
          operationId: operationId(spec, item.identity, action),
          phase: inspected?.active ? "verified" : "inspected",
          outcome: inspected?.active ? "idempotent_noop" : null,
          verification: inspected?.active ? "verified_active" : null,
          evidence: inspected?.evidence ?? {},
        };
        item.actions[action] = record;
        checkpoint.updatedAt = now();
        await saveCheckpoint(checkpoint);

        if (!inspected?.active) {
          record.phase = "send_intent";
          checkpoint.updatedAt = now();
          await saveCheckpoint(checkpoint);
          await emit({ type: "action_send_intent", index, action, operationId: record.operationId });
          try {
            const activated = await adapter.activateActionOnce(action, item, inspected);
            if (!activated?.verified) {
              throw new FeedWorkflowError(
                "ACTION_POSTCONDITION_UNKNOWN",
                action + " was sent once but its active state was not verified",
                { sent: true },
              );
            }
            record.phase = "verified";
            record.outcome = "completed";
            record.verification = "verified_active";
            record.evidence = { ...record.evidence, ...(activated.evidence ?? {}) };
            checkpoint.updatedAt = now();
            await saveCheckpoint(checkpoint);
            await emit({ type: "action_verified", index, action, operationId: record.operationId });
          } catch (error) {
            if (error?.sent !== false) {
              checkpoint.status = "unknown";
              checkpoint.failureSignature = "feed:" + action + ":after_send_unknown";
            }
            throw error;
          }
        }
      }

      item.phase = "actions_verified";
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);

      const returned = await adapter.returnToFeed(item);
      if (!returned?.verified) {
        throw new FeedWorkflowError("RETURN_TO_FEED_FAILED", "The workflow did not verify a return to the feed");
      }
      item.returnedToFeed = true;
      item.phase = "returned_verified";
      item.evidence = { ...item.evidence, ...(returned.evidence ?? {}) };
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);

      item.phase = "committed";
      item.committedAt = now();
      checkpoint.items.push(item);
      checkpoint.inFlightItem = null;
      checkpoint.updatedAt = now();
      await saveCheckpoint(checkpoint);
      await emit({ type: "item_completed", index, identity: item.identity });
    }

    checkpoint.status = "completed";
    checkpoint.failureSignature = null;
    checkpoint.updatedAt = now();
    await saveCheckpoint(checkpoint);
    await emit({ type: "completed", viewedCount: checkpoint.items.length, skippedCount: checkpoint.skipped.length });
    return workflowSummary(checkpoint);
  } catch (error) {
    if (checkpoint.status !== "unknown") {
      checkpoint.status = "failed";
      checkpoint.failureSignature = error?.code ? "feed:" + String(error.code).toLowerCase() : "feed:unexpected";
    }
    checkpoint.updatedAt = now();
    await saveCheckpoint(checkpoint);
    await emit({
      type: "failed",
      status: checkpoint.status,
      failureSignature: checkpoint.failureSignature,
      message: String(error?.message ?? error),
    });
    throw error;
  }
}
