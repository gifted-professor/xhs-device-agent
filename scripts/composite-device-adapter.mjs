import { createHash } from "node:crypto";

import { detailSurfaceStable } from "./feed-device-runner.mjs";

import {
  advanceCommentCollection,
  applyCountUpdateToFrozenBudget,
  collectCommentSnippets,
  extractDetailMetadata,
  findCommentContainer,
  freezeCommentBudget,
  normalizedCommentHash,
  parseCommentCount,
  resolveCommentCount,
} from "./detail-perception.mjs";
import { resolveSemanticNode, resolveSemanticTarget } from "./xhs-page-engine.mjs";
import { ensureEngagementState } from "./engagement-ensure.mjs";

const DETAIL_STATES = new Set(["IMAGE_NOTE", "VIDEO_NOTE"]);
const COMMENT_STATE = new Set(["COMMENT_PANEL"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactCount(value) {
  const normalized = resolveCommentCount([value]);
  return normalized.countKind === "unknown" ? null : normalized;
}

function unknownCount() {
  return { count: null, countKind: "unknown", confidence: 0 };
}

function safeCPAObservation(value) {
  if (!value || value.status !== "ok" || !value.result || typeof value.result !== "object") return null;
  if (!['exact', 'lower_bound'].includes(value.result.countKind)) return null;
  return exactCount(value.result);
}

export async function observeCommentCountCascade({
  snapshot,
  dependencies = {},
  liveCap = { maxScrolls: 3, maxItems: 20 },
} = {}) {
  invariant(snapshot && DETAIL_STATES.has(snapshot.classification?.state), "comment count requires a public detail snapshot");
  const ui = parseCommentCount(extractDetailMetadata(snapshot).count);
  let source = "ui";
  let observation = ui.countKind === "unknown" ? null : ui;

  if (!observation && typeof dependencies.localNumericOcr === "function") {
    const local = await dependencies.localNumericOcr({ snapshot });
    observation = exactCount(local);
    source = "local_ocr";
  }

  if (!observation && typeof dependencies.analyzeCpa === "function") {
    dependencies.assertFastGate?.({ action: "comments.observe_count", phase: "before_cpa" });
    const artifact = await dependencies.createCommentCountArtifact?.({ snapshot });
    invariant(artifact, "CPA artifact is unavailable");
    const response = await dependencies.analyzeCpa({
      role: "comment_count",
      artifact,
      execution: dependencies.execution,
      runtime: dependencies.runtime,
      gate: { assertFastGate: dependencies.assertFastGate },
    });
    observation = safeCPAObservation(response);
    source = "cpa";
  }

  if (!observation) {
    observation = unknownCount();
    source = "unknown";
  }
  const budget = freezeCommentBudget(observation, { liveCap });
  return Object.freeze({
    source,
    observation: Object.freeze({ ...observation }),
    budget,
    applyLaterObservation: (later) => applyCountUpdateToFrozenBudget(budget, later),
  });
}

function boundsOf(node) {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/u.exec(String(node?.attributes?.bounds ?? ""));
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (left < 0 || top < 0 || right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function detailTarget(snapshot) {
  invariant(snapshot && DETAIL_STATES.has(snapshot.classification?.state), "a fresh public detail is required");
  const metadata = extractDetailMetadata(snapshot);
  const stable = {
    state: snapshot.classification.state,
    fingerprint: snapshot.fingerprint,
    title: metadata.title,
    author: metadata.author,
  };
  invariant(typeof stable.fingerprint === "string" && stable.fingerprint.length > 0, "detail fingerprint is unavailable");
  return {
    targetHash: createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex"),
    pageState: stable.state,
    observationId: `ui-${stable.fingerprint}`,
    metadata: { title: metadata.title, author: metadata.author },
  };
}

function treePath(document, node) {
  const parts = [];
  let current = node;
  while (current) {
    if (current.parentIndex === null || current.parentIndex === undefined) {
      parts.push(document.roots.indexOf(current.nodeIndex));
      break;
    }
    const parent = document.nodes[current.parentIndex];
    parts.push(parent.children.indexOf(current.nodeIndex));
    current = parent;
  }
  return `/${parts.reverse().join("/")}`;
}

export class CompositeDeviceAdapter {
  constructor({
    feedAdapter,
    rules,
    runtimeProfile = {},
    assertFastGate,
    localNumericOcr,
    createCommentCountArtifact,
    analyzeCpa,
    executionContext,
    operationLedger,
    machine,
    now = Date.now,
    tripFuse = () => {},
  }) {
    invariant(feedAdapter && typeof feedAdapter.stableUi === "function", "feedAdapter is required");
    invariant(rules && typeof rules === "object", "page rules are required");
    invariant(typeof assertFastGate === "function", "composite fast gate is required");
    this.feedAdapter = feedAdapter;
    this.rules = rules;
    this.runtimeProfile = runtimeProfile;
    this.assertFastGate = assertFastGate;
    this.localNumericOcr = localNumericOcr;
    this.createCommentCountArtifact = createCommentCountArtifact;
    this.analyzeCpa = analyzeCpa;
    if (analyzeCpa) {
      invariant(executionContext && /^[a-f0-9]{64}$/u.test(executionContext.planHash), "CPA planHash is required");
      invariant(/^attempt-[a-f0-9]{16}$/u.test(executionContext.attemptId), "CPA attemptId is required");
      invariant(Number.isSafeInteger(runtimeProfile.cpaWorkflowSoftTimeoutMs) && runtimeProfile.cpaWorkflowSoftTimeoutMs > 0, "CPA workflow timeout is required");
    }
    this.executionContext = executionContext ?? null;
    if (operationLedger) invariant(/^[0-9]{2}$/u.test(machine), "operation ledger requires a machine binding");
    this.operationLedger = operationLedger ?? null;
    this.machine = machine ?? null;
    this.now = now;
    this.tripFuse = tripFuse;
    this.currentSnapshot = null;
    this.currentSnapshotAt = 0;
    this.currentBinding = null;
    this.commentBudgets = new Map();
    this.lastResults = new Map();
  }

  invalidateSnapshot() {
    this.currentSnapshot = null;
    this.currentSnapshotAt = 0;
  }

  async freshSnapshot(stage, expectedStates = null) {
    const value = await this.feedAdapter.stableUi(stage);
    if (value.classification?.safety?.sensitive) {
      this.tripFuse("SENSITIVE_PAGE");
      throw new Error("SENSITIVE_PAGE");
    }
    this.feedAdapter.assertOperable?.(value, expectedStates);
    this.currentSnapshot = value;
    this.currentSnapshotAt = this.now();
    return value;
  }

  async readOnlySnapshot(stage, expectedStates = null) {
    const reuseMs = Math.max(0, Number(this.runtimeProfile.uiSnapshotReuseMs) || 0);
    if (this.currentSnapshot && this.now() - this.currentSnapshotAt <= reuseMs) {
      this.feedAdapter.assertOperable?.(this.currentSnapshot, expectedStates);
      return this.currentSnapshot;
    }
    return this.freshSnapshot(stage, expectedStates);
  }

  async bindCurrentDetail(stage = "composite-detail-bind", { fresh = false } = {}) {
    const snapshot = fresh
      ? await this.freshSnapshot(stage, DETAIL_STATES)
      : await this.readOnlySnapshot(stage, DETAIL_STATES);
    const binding = Object.freeze(detailTarget(snapshot));
    this.currentBinding = binding;
    return binding;
  }

  assertBinding(binding) {
    invariant(binding?.targetHash && this.currentBinding?.targetHash === binding.targetHash, "detail target binding changed");
  }

  resolveTarget(snapshot, semanticTarget) {
    const target = resolveSemanticTarget(snapshot.document, this.rules, semanticTarget, this.feedAdapter.context ?? {});
    invariant(target.found && target.node, `${semanticTarget} semantic target is unavailable`);
    const actual = snapshot.document.nodes.find((entry) => treePath(snapshot.document, entry) === target.node.path);
    invariant(actual, `${semanticTarget} resolved node is unavailable in the current snapshot`);
    return actual;
  }

  sendSwipe(node, action) {
    const bounds = boundsOf(node);
    invariant(bounds, `${action} semantic bounds are unavailable`);
    this.assertFastGate({ action, phase: "before_send" });
    const x = Math.round(bounds.left + bounds.width * 0.5);
    const startY = Math.round(bounds.top + bounds.height * 0.78);
    const endY = Math.round(bounds.top + bounds.height * 0.28);
    this.feedAdapter.adb(["shell", "input", "swipe", String(x), String(startY), String(x), String(endY), "350"], { sent: true });
    this.invalidateSnapshot();
  }

  async openComments(binding) {
    this.assertBinding(binding);
    const before = await this.readOnlySnapshot("comments-open-before", DETAIL_STATES);
    const target = this.resolveTarget(before, "comments_entry");
    this.assertFastGate({ action: "comments.open", phase: "before_send" });
    this.feedAdapter.tapNode(target, { sent: true });
    this.invalidateSnapshot();
    const after = await this.freshSnapshot("comments-open-after", COMMENT_STATE);
    const result = { status: "verified", targetHash: binding.targetHash, pageState: after.classification.state, sent: true };
    this.lastResults.set("comments.open", result);
    return result;
  }

  async collectComments(binding, budget) {
    this.assertBinding(binding);
    invariant(budget?.frozen === true, "comments.collect requires a frozen budget");
    let snapshot = await this.readOnlySnapshot("comments-collect-initial", COMMENT_STATE);
    const seenHashes = new Set();
    const snippets = [];
    let progress = null;

    const collect = (scrolled) => {
      const remaining = Math.max(0, budget.liveBudget.maxItems - seenHashes.size);
      const added = collectCommentSnippets({
        nodes: snapshot.document.nodes,
        maximum: remaining,
        seenHashes,
        authorNames: [binding.metadata?.author].filter(Boolean),
      });
      snippets.push(...added);
      const hashes = added.map(normalizedCommentHash);
      const endMarker = snapshot.document.nodes.some((entry) => /(?:没有更多|到底了|end of comments)/iu.test(String(entry.text || entry.contentDesc || "")));
      progress = advanceCommentCollection(progress, { hashes, budget, scrolled, endMarker });
    };

    collect(false);
    while (!progress.stop && progress.scrolls < budget.liveBudget.maxScrolls) {
      const semantic = resolveSemanticTarget(snapshot.document, this.rules, "comments_container", this.feedAdapter.context ?? {});
      const container = semantic.found && semantic.node
        ? snapshot.document.nodes.find((entry) => treePath(snapshot.document, entry) === semantic.node.path)
        : findCommentContainer(snapshot)?.node;
      invariant(container && !/input|editor/iu.test(String(container.resourceId ?? "")), "verified comment container is unavailable");
      this.sendSwipe(container, "comments.collect");
      snapshot = await this.freshSnapshot(`comments-collect-after-${progress.scrolls + 1}`, COMMENT_STATE);
      collect(true);
    }
    const result = {
      status: "verified",
      targetHash: binding.targetHash,
      snippets,
      hashes: [...progress.seenHashes],
      scrolls: progress.scrolls,
      stopReason: progress.stopReason ?? "completed",
    };
    this.lastResults.set("comments.collect", result);
    return result;
  }

  async closeComments(binding) {
    this.assertBinding(binding);
    await this.readOnlySnapshot("comments-close-before", COMMENT_STATE);
    this.assertFastGate({ action: "comments.close", phase: "before_send" });
    this.feedAdapter.adb(["shell", "input", "keyevent", "KEYCODE_BACK"], { sent: true });
    this.invalidateSnapshot();
    const after = await this.freshSnapshot("comments-close-after", DETAIL_STATES);
    const returned = detailTarget(after);
    invariant(returned.targetHash === binding.targetHash, "comments.close returned to a different detail");
    this.currentBinding = Object.freeze(returned);
    const result = { status: "verified", targetHash: binding.targetHash, pageState: after.classification.state, sent: true };
    this.lastResults.set("comments.close", result);
    return result;
  }

  async scrollImageContent(binding) {
    this.assertBinding(binding);
    const before = await this.readOnlySnapshot("image-scroll-before", new Set(["IMAGE_NOTE"]));
    const resolved = resolveSemanticNode(before.document, this.rules, "note_content_container", this.feedAdapter.context ?? {});
    invariant(resolved.found && resolved.node, "note_content_container semantic target is unavailable");
    this.sendSwipe(resolved.node, "image.scroll_content");
    const after = await this.freshSnapshot("image-scroll-after", new Set(["IMAGE_NOTE"]));
    const returned = detailTarget(after);
    if (!detailSurfaceStable(before, after)) {
      return { status: "ambiguous", targetHash: binding.targetHash, observationId: returned.observationId, sent: true };
    }
    this.currentBinding = Object.freeze({ ...binding, observationId: returned.observationId, pageState: returned.pageState });
    const result = { status: "verified", targetHash: binding.targetHash, observationId: returned.observationId, sent: true };
    this.lastResults.set("image.scroll_content", result);
    return result;
  }

  async advanceVideo(binding) {
    this.assertBinding(binding);
    const before = await this.readOnlySnapshot("video-advance-before");
    invariant(before.classification?.state === "VIDEO_NOTE", "video.advance requires VIDEO_NOTE and a closed comment panel");
    const resolved = resolveSemanticNode(before.document, this.rules, "video_player_surface", this.feedAdapter.context ?? {});
    invariant(resolved.found && resolved.node, "video_player_surface semantic target is unavailable");
    this.sendSwipe(resolved.node, "video.advance");
    const after = await this.freshSnapshot("video-advance-after");
    if (after.classification?.state !== "VIDEO_NOTE") {
      return { status: "ambiguous", targetHash: binding.targetHash, observationId: `ui-${after.fingerprint}`, sent: true };
    }
    const advanced = detailTarget(after);
    if (advanced.targetHash === binding.targetHash) {
      return { status: "ambiguous", targetHash: binding.targetHash, observationId: advanced.observationId, sent: true };
    }
    this.currentBinding = Object.freeze(advanced);
    const result = {
      status: "verified",
      targetHash: advanced.targetHash,
      previousTargetHash: binding.targetHash,
      observationId: advanced.observationId,
      previousObservationId: binding.observationId,
      sent: true,
    };
    this.lastResults.set("video.advance", result);
    return result;
  }

  async ensureEngagement(step, binding) {
    invariant(this.operationLedger, "account-state operation ledger is unavailable");
    const action = step.action === "engagement.ensure_liked" ? "like" : "favorite";
    return ensureEngagementState({
      action,
      operation: {
        operationId: step.operationId,
        budgetSlotId: step.budgetSlotId,
        machine: this.machine,
        stepId: step.stepId,
        action: step.action,
      },
      binding,
      ledger: this.operationLedger,
      invalidateSnapshot: () => this.invalidateSnapshot(),
      freshSnapshot: (stage) => this.freshSnapshot(stage, DETAIL_STATES),
      bindSnapshot: (snapshot) => detailTarget(snapshot),
      sameTarget: (before, after) => detailSurfaceStable(before, after),
      assertFastGate: this.assertFastGate,
      sendOnce: async (inspected) => this.feedAdapter.tapNode(inspected.node, { sent: true }),
      tripFuse: this.tripFuse,
    });
  }

  async closeSkippedOperation(step, binding) {
    if (!this.operationLedger) return null;
    invariant(binding?.targetHash, "skipped account-state operation requires its target binding");
    return this.operationLedger.closeWithoutSend({
      operationId: step.operationId,
      budgetSlotId: step.budgetSlotId,
      machine: this.machine,
      stepId: step.stepId,
      action: step.action,
      targetHash: binding.targetHash,
    }, "skipped_condition");
  }

  async observe(step) {
    if (step.action === "detail.inspect") {
      const binding = await this.bindCurrentDetail(`step-${step.stepId}-detail`);
      return { status: "observed", pageState: binding.pageState, targetHash: binding.targetHash };
    }
    if (step.action === "comments.observe_count") {
      const snapshot = await this.readOnlySnapshot(`step-${step.stepId}-count`, DETAIL_STATES);
      const result = await observeCommentCountCascade({
        snapshot,
        dependencies: {
          localNumericOcr: this.localNumericOcr,
          createCommentCountArtifact: this.createCommentCountArtifact,
          analyzeCpa: this.analyzeCpa,
          assertFastGate: this.assertFastGate,
          execution: this.executionContext ? { ...this.executionContext, stepId: step.stepId } : undefined,
          runtime: this.runtimeProfile,
        },
      });
      if (this.currentBinding) this.commentBudgets.set(this.currentBinding.targetHash, result.budget);
      this.lastResults.set(step.action, result);
      return { status: "observed", pageState: snapshot.classification.state, countBand: result.budget.band, ...result };
    }
    const expected = step.action.startsWith("comments.") ? COMMENT_STATE : DETAIL_STATES;
    const snapshot = await this.readOnlySnapshot(`step-${step.stepId}-observe`, expected);
    return { status: "observed", pageState: snapshot.classification.state };
  }

  async bindTarget(step) {
    if (step.params?.targetBindingRef) return this.currentBinding;
    return this.bindCurrentDetail(`step-${step.stepId}-bind`);
  }

  async sendOnce(step, binding, { observed } = {}) {
    if (["detail.inspect", "comments.observe_count"].includes(step.action)) return { status: "completed", sent: false };
    if (step.action === "comments.open") return this.openComments(binding);
    if (step.action === "image.scroll_content") return this.scrollImageContent(binding);
    if (step.action === "video.advance") return this.advanceVideo(binding);
    if (["engagement.ensure_liked", "engagement.ensure_favorited"].includes(step.action)) return this.ensureEngagement(step, binding);
    if (step.action === "comments.collect") {
      const budget = observed?.budget ?? this.commentBudgets.get(binding?.targetHash);
      return this.collectComments(binding, budget);
    }
    if (step.action === "comments.close") return this.closeComments(binding);
    throw new Error(`unsupported composite adapter action: ${step.action}`);
  }

  async verify(step, binding, { sendOutcome } = {}) {
    const result = sendOutcome ?? this.lastResults.get(step.action);
    if (!result) return { status: "ambiguous", targetHash: binding?.targetHash };
    if (result.status === "completed") return { ...result, status: "verified", targetHash: binding?.targetHash };
    return result;
  }
}
