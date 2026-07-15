import { createHash } from "node:crypto";

const DETAIL_STATES = new Set(["IMAGE_NOTE", "VIDEO_NOTE"]);
const DIRECT_XHS_HOSTS = new Set(["xiaohongshu.com", "www.xiaohongshu.com"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compact(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function directNoteIdentity(url) {
  const parsed = new URL(url);
  if (!DIRECT_XHS_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = /^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)$/u.exec(parsed.pathname);
  return match?.[1] ?? null;
}

function observableSnapshotText(snapshot) {
  return snapshot.document.nodes.flatMap((node) => [
    node.text,
    node.contentDesc,
    node.resourceId,
    ...Object.values(node.attributes ?? {}),
  ]).map(compact).filter(Boolean).join(" ");
}

export class TaskSourceDeviceAdapter {
  constructor({ feedAdapter, searchProvider, researchRunner, taskSource, taskId, deviceAlias, machine, assertFastGate }) {
    invariant(feedAdapter && typeof feedAdapter.stableUiWhileTransitioning === "function", "task source feed adapter is required");
    invariant(taskSource && ["feed", "search_results", "url_list", "research_read_only"].includes(taskSource.type), "task source is invalid");
    invariant(typeof taskId === "string" && taskId.length > 0, "task source taskId is required");
    invariant(typeof deviceAlias === "string" && deviceAlias.length > 0, "task source device alias is required");
    if (taskSource.type === "research_read_only") invariant(/^[0-9]{2}$/u.test(machine ?? ""), "research source machine is required");
    invariant(typeof assertFastGate === "function", "task source fast gate is required");
    this.feedAdapter = feedAdapter;
    this.searchProvider = searchProvider ?? null;
    this.researchRunner = researchRunner ?? null;
    this.taskSource = taskSource;
    this.taskId = taskId;
    this.deviceAlias = deviceAlias;
    this.machine = machine ?? null;
    this.assertFastGate = assertFastGate;
    this.searchSession = null;
    this.currentUrlRef = null;
  }

  async openSearchResults({ queryRef }) {
    invariant(this.taskSource.type === "search_results", "search action does not match the compiled source");
    invariant(queryRef === this.taskSource.queryRef, "search query reference does not match the compiled source");
    invariant(this.searchProvider && typeof this.searchProvider.createUnifiedSearchSession === "function", "search source adapter is unavailable");
    invariant(!this.searchSession, "search results may be opened only once per worker");
    this.assertFastGate({ action: "search.open_results", phase: "before_source_open" });
    this.searchSession = await this.searchProvider.createUnifiedSearchSession({
      taskId: this.taskId,
      query: this.taskSource.query,
      count: this.taskSource.count,
      deviceAlias: this.deviceAlias,
    });
    return Object.freeze({
      status: "verified",
      pageState: "SEARCH_RESULTS",
      queryRef,
      ...(this.searchSession.inputMethodAudit ? { inputMethodAudit: this.searchSession.inputMethodAudit } : {}),
    });
  }

  async openSearchResult({ resultOrdinal, maxScrolls = 1 }) {
    invariant(this.searchSession, "search results are not open");
    this.assertFastGate({ action: "search.open_result", phase: "before_source_result" });
    return this.searchSession.openNextResult({ resultOrdinal, maxScrolls });
  }

  async returnToSearchResults() {
    invariant(this.searchSession, "search results are not open");
    this.assertFastGate({ action: "navigation.return_to_source", phase: "before_source_return" });
    return this.searchSession.returnToResults();
  }

  async openXhsUrl({ urlRef }) {
    invariant(this.taskSource.type === "url_list", "URL action does not match the compiled source");
    const entry = this.taskSource.urls.find((candidate) => candidate.urlRef === urlRef);
    invariant(entry, "URL reference does not match the compiled source");
    const noteIdentity = directNoteIdentity(entry.url);
    invariant(noteIdentity, "live URL execution requires a direct Xiaohongshu note URL with a verifiable identity");
    this.assertFastGate({ action: "content.open_xhs_url", phase: "before_url_open" });
    this.feedAdapter.adb([
      "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW",
      "-d", entry.url, "-p", "com.xingin.xhs",
    ], { sent: true, timeout: 30_000 });
    const transition = await this.feedAdapter.stableUiWhileTransitioning(`url-${urlRef}-detail`);
    const detail = transition.sample;
    this.feedAdapter.assertOperable(detail, DETAIL_STATES);
    const activity = this.feedAdapter.adb(["shell", "dumpsys", "activity", "activities"]);
    const identityVerified = compact(activity).includes(noteIdentity) || observableSnapshotText(detail).includes(noteIdentity);
    invariant(identityVerified, "TARGET_IDENTITY_UNVERIFIED: opened URL detail does not expose the approved note identity");
    this.currentUrlRef = urlRef;
    return Object.freeze({
      status: "verified",
      pageState: detail.classification.state,
      urlRef,
      targetIdentityHash: createHash("sha256").update(noteIdentity, "utf8").digest("hex"),
      verifiedBy: compact(activity).includes(noteIdentity) ? "activity_intent" : "ui_hierarchy",
    });
  }

  async collectResearch({ policyRef }) {
    invariant(this.taskSource.type === "research_read_only", "research action does not match the compiled source");
    invariant(policyRef === "research-read-only-v1", "research policy reference does not match the compiled source");
    invariant(typeof this.researchRunner === "function", "research source runner is unavailable");
    const assignment = this.taskSource.assignments.find((entry) => entry.machine === this.machine);
    invariant(assignment?.task?.taskId === this.taskId, "research machine assignment does not match the compiled worker");
    this.assertFastGate({ action: "research.collect", phase: "before_research" });
    const summary = await this.researchRunner(structuredClone(assignment.task));
    invariant(summary && typeof summary === "object", "research runner returned an invalid result");
    if (summary.globalFuse) throw new Error(`RESEARCH_GLOBAL_FUSE:${summary.globalFuse.reason ?? "PROVIDER_STOP"}`);
    const completed = ["completed", "duplicate"].includes(summary.status);
    return Object.freeze({
      status: completed ? "verified" : "failed",
      researchStatus: summary.status,
      taskId: assignment.task.taskId,
      resultHash: createHash("sha256").update(JSON.stringify(summary), "utf8").digest("hex"),
      counts: summary.counts && typeof summary.counts === "object" ? Object.freeze({ ...summary.counts }) : Object.freeze({}),
      sent: true,
    });
  }
}

export function taskSourceRequiresSearch(taskSource) {
  return ["search_results", "research_read_only"].includes(taskSource?.type);
}

export function unsupportedLiveUrl(taskSource) {
  if (taskSource?.type !== "url_list") return null;
  return taskSource.urls.find((entry) => !directNoteIdentity(entry.url)) ?? null;
}
