import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAiRole } from "./ai-role-runner.mjs";
import {
  ResearchTaskError,
  runResearchTask,
  stableHash,
  validateResearchTask,
} from "./research-core.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readFreshJson(filePath, ttlDays) {
  try {
    const metadata = await stat(filePath);
    if (Date.now() - metadata.mtimeMs > ttlDays * 86400000) return null;
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const contents = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

export function parseJsonLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function uniqueQueries(values, topic, limit) {
  const seen = new Set([topic.normalize("NFKC").toLocaleLowerCase()]);
  const result = [];
  for (const value of values) {
    const query = typeof value === "string" ? value.trim() : "";
    const key = query.normalize("NFKC").toLocaleLowerCase();
    if (!query || query.length > 80 || seen.has(key)) continue;
    seen.add(key);
    result.push(query);
    if (result.length >= limit) break;
  }
  return result;
}

export function buildEffectiveTask(taskInput, suggestions = [], plannerOutput = null, trendingKeywords = []) {
  const task = validateResearchTask(taskInput);
  const excluded = new Set((plannerOutput?.excludedTerms ?? []).map((value) => String(value).trim().toLocaleLowerCase()));
  const candidates = [
    ...(plannerOutput?.rankedQueries ?? []),
    ...suggestions,
    ...trendingKeywords,
    ...task.seedKeywords,
  ].filter((value) => !excluded.has(String(value).trim().toLocaleLowerCase()));
  const maximumSeeds = Math.min(12, Math.max(0, task.budgets.maxQueries - 1));
  return validateResearchTask({
    ...task,
    seedKeywords: uniqueQueries(candidates, task.topic, maximumSeeds),
  });
}

function configuredAi(options = {}) {
  return Boolean(options.model && (options.request || (options.apiUrl && options.apiKey)));
}

async function aiCallCount(budgetPath) {
  const value = await readJsonIfExists(budgetPath);
  const count = value?.automaticCalls ?? 0;
  if (!Number.isInteger(count) || count < 0 || count > 4) {
    throw new ResearchTaskError("INVALID_AI_BUDGET", "AI budget file contains an invalid automaticCalls count");
  }
  return count;
}

async function acquireTaskLock(lockPath, staleAfterMs) {
  const tryOpen = async () => {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    return handle;
  };
  let handle;
  try {
    handle = await tryOpen();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const metadata = await stat(lockPath).catch(() => null);
    if (metadata && Date.now() - metadata.mtimeMs > staleAfterMs) {
      await rm(lockPath, { force: true });
      handle = await tryOpen();
    } else {
      throw new ResearchTaskError("TASK_IN_PROGRESS", "the same taskId is already running");
    }
  }
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  };
}

async function reserveMaintenanceSignature(outputRoot, taskId, trigger) {
  const directory = path.join(outputRoot, "_maintenance-signatures");
  await mkdir(directory, { recursive: true });
  const key = stableHash({ reason: trigger.reason, failureSignature: trigger.failureSignature });
  const markerPath = path.join(directory, `${key}.json`);
  let handle;
  try {
    handle = await open(markerPath, "wx");
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      firstTaskId: taskId,
      createdAt: new Date().toISOString(),
      trigger,
      requestedRole: "maintenance_agent",
      permission: "suggest_rules_or_code_only",
    }, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function publicAnalysisCandidates(candidates) {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    title: candidate.title,
    author: candidate.author,
    mediaType: candidate.mediaType,
    sources: candidate.sources ?? (candidate.source ? [candidate.source] : []),
    keywords: candidate.keywords ?? (candidate.keyword ? [candidate.keyword] : []),
    publicMetrics: candidate.publicMetrics,
  }));
}

function mergeAnalysisReviews(existing, analysis, candidates, task) {
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const seen = new Set(existing.map((review) => `${review.candidateKey ?? review.candidateId ?? ""}:analysis`));
  const added = [];
  for (const ranked of analysis.rankedCandidates) {
    const candidate = byId.get(ranked.candidateId);
    if (!candidate || seen.has(`${ranked.candidateId}:analysis`)) continue;
    added.push({
      reviewId: stableHash(`${task.taskId}\u0000analysis\u0000${ranked.candidateId}`).slice(0, 20),
      taskId: task.taskId,
      topic: task.topic,
      candidateKey: ranked.candidateId,
      candidateId: ranked.candidateId,
      noteId: candidate.noteId ?? null,
      title: candidate.title ?? "",
      author: candidate.author ?? "",
      mediaType: candidate.mediaType ?? "unknown",
      source: candidate.sources?.[0] ?? candidate.source ?? "",
      keyword: candidate.keywords?.[0] ?? candidate.keyword ?? "",
      deviceAlias: candidate.deviceAliases?.[0] ?? candidate.deviceAlias ?? "",
      aiScore: ranked.score,
      aiReason: ranked.reason,
      reason: ranked.reason,
      status: "pending_review",
      reviewStatus: "pending_review",
    });
  }
  return [...existing, ...added];
}

function shortCircuitUnicodeInput(provider, discovery) {
  if (discovery?.stopAll === true) {
    return {
      ...provider,
      async executeWorkUnit() {
        return {
          status: "human_required",
          candidates: [],
          humanReview: discovery.humanReview ?? [{ reason: "Sensitive discovery screen requires immediate human review" }],
          failureSignature: discovery.failureSignature ?? "discovery:stop_all",
          stopAll: true,
        };
      },
    };
  }
  const blockedByAlias = new Map((discovery?.inputBlockedDevices ?? []).flatMap((entry) =>
    entry && typeof entry.deviceAlias === "string" ? [[entry.deviceAlias, entry]] : []));
  if (blockedByAlias.size === 0) return provider;
  return {
    ...provider,
    async executeWorkUnit(context) {
      const blocked = blockedByAlias.get(context.deviceAlias);
      if (!blocked || !["search", "suggestions"].includes(context.unit.source)) return provider.executeWorkUnit(context);
      return {
        status: "human_required",
        candidates: [],
        humanReview: blocked.humanReview ?? [{ reason: "Manual Unicode search input is required on this device" }],
        failureSignature: `${blocked.failureSignature ?? "input:human_required"}:${context.deviceAlias}`,
        affectsDeviceHealth: false,
      };
    },
  };
}

function checkpointResourceUsage(checkpoint) {
  let commentPanelsUsed = 0;
  for (const entry of Object.values(checkpoint?.units ?? {})) {
    const candidates = Array.isArray(entry?.result?.candidates) ? entry.result.candidates : [];
    commentPanelsUsed += candidates.filter((candidate) => candidate?.commentMetadata?.panelOpened === true).length;
  }
  return { commentPanelsUsed };
}

function duplicateResult(existing) {
  return {
    ...existing,
    originalStatus: existing.status,
    status: "duplicate",
    duplicate: true,
  };
}

/**
 * Orchestrate one complete task. Hermes only needs to place the task JSON; this
 * function owns deterministic discovery, bounded AI roles and persisted output.
 */
export async function runResearchSession(taskInput, options = {}) {
  const originalTask = validateResearchTask(taskInput);
  const deadlineAt = Date.now() + originalTask.budgets.wallClockSeconds * 1000;
  const outputRoot = path.resolve(options.outputRoot ?? path.join("data", "research"));
  const taskDirectory = path.join(outputRoot, originalTask.taskId);
  const finalSummaryPath = path.join(taskDirectory, "summary.json");
  const originalHash = stableHash(originalTask);
  const existing = await readJsonIfExists(finalSummaryPath);
  if (existing) {
    if (existing.taskHash !== originalHash) {
      throw new ResearchTaskError("TASK_ID_CONFLICT", `taskId ${originalTask.taskId} already exists with different input`);
    }
    return duplicateResult(existing);
  }

  await mkdir(taskDirectory, { recursive: true });
  const releaseLock = await acquireTaskLock(
    path.join(taskDirectory, ".session.lock"),
    (originalTask.budgets.wallClockSeconds + 120) * 1000,
  );
  try {
    const afterLock = await readJsonIfExists(finalSummaryPath);
    if (afterLock) {
      if (afterLock.taskHash !== originalHash) throw new ResearchTaskError("TASK_ID_CONFLICT", "taskId conflict");
      return duplicateResult(afterLock);
    }

    const budgetPath = path.join(taskDirectory, "ai-budget.json");
    const cacheDir = path.resolve(options.ai?.cacheDir ?? path.join(outputRoot, "_ai-cache"));
    const aiStatus = [];
    const roleOptions = (role, input) => ({
      role,
      input,
      cacheDir,
      budgetPath,
      maxAutomaticCalls: originalTask.aiPolicy.maxAutomaticCalls,
      apiUrl: options.ai?.apiUrl,
      apiKey: options.ai?.apiKey,
      model: options.ai?.model,
      promptVersion: options.ai?.promptVersion ?? "1",
      ...(options.ai?.request ? { request: options.ai.request } : {}),
    });

    let recoveryTail = Promise.resolve();
    const pageRecovery = (input) => {
      const run = async () => {
        if (!originalTask.aiPolicy.pageFallback || !configuredAi(options.ai) || !input.imagePath) return null;
        const attestation = input.privacyAttestation;
        if (attestation?.schemaVersion !== 1 || attestation.method !== "windows_local_ocr" ||
            attestation.checks !== 2 || attestation.safeForCloud !== true ||
            !/^[a-f0-9]{64}$/u.test(String(attestation.screenshotSha256 ?? ""))) {
          aiStatus.push({ role: "page_recovery", status: "human_required", reason: "LOCAL_PRIVACY_ATTESTATION_REQUIRED" });
          return null;
        }
        try {
          const record = await runAiRole(roleOptions("page_recovery", {
            imagePath: input.imagePath,
            safeToUpload: input.classification?.safety?.blockCloudUpload === false && attestation.safeForCloud === true,
            privacyAttestation: attestation,
            visibleTexts: input.visibleTexts ?? [],
            localPageState: input.classification?.state ?? "UNKNOWN",
            targetTask: "read_only_navigation",
          }));
          aiStatus.push({ role: "page_recovery", status: record.cacheHit ? "cache_hit" : "called", cacheKey: record.cacheKey });
          return record.output;
        } catch (error) {
          aiStatus.push({ role: "page_recovery", status: "human_required", reason: error.message });
          return null;
        }
      };
      recoveryTail = recoveryTail.then(run, run);
      return recoveryTail;
    };

    const checkpoint = await readJsonIfExists(path.join(taskDirectory, "checkpoint.json"));
    const resourceBudgetPath = path.join(taskDirectory, "resource-budget.json");
    const persistedResourceUsage = await readJsonIfExists(resourceBudgetPath);
    const checkpointUsage = checkpointResourceUsage(checkpoint);
    const persistedCommentPanels = persistedResourceUsage?.commentPanelsUsed ?? 0;
    if (!Number.isInteger(persistedCommentPanels) || persistedCommentPanels < 0 || persistedCommentPanels > originalTask.budgets.maxCommentPanels) {
      throw new ResearchTaskError("INVALID_CHECKPOINT", "resource budget contains an invalid comment panel count");
    }
    const resourceUsage = {
      commentPanelsUsed: Math.max(checkpointUsage.commentPanelsUsed, persistedCommentPanels),
    };
    let resourceWrite = Promise.resolve();
    const onResourceUsage = (usage) => {
      if (usage.taskId !== originalTask.taskId || !Number.isInteger(usage.commentPanelsUsed) || usage.commentPanelsUsed < 0 || usage.commentPanelsUsed > originalTask.budgets.maxCommentPanels) {
        throw new ResearchTaskError("INVALID_PROVIDER", "provider reported invalid resource usage");
      }
      resourceWrite = resourceWrite.then(() => writeAtomic(resourceBudgetPath, {
        schemaVersion: 1,
        taskId: originalTask.taskId,
        commentPanelsUsed: usage.commentPanelsUsed,
      }));
      return resourceWrite;
    };
    const provider = options.providerFactory
      ? await options.providerFactory({ pageRecovery, resourceUsage, onResourceUsage, taskDirectory })
      : options.provider;
    if (!provider || typeof provider.listDevices !== "function" || typeof provider.executeWorkUnit !== "function") {
      throw new ResearchTaskError("INVALID_PROVIDER", "a provider or providerFactory is required");
    }

    let versionChanges = [];
    if (typeof provider.getDeviceProfiles === "function") {
      try {
        const profiles = await provider.getDeviceProfiles({ deviceGroup: originalTask.deviceGroup, task: originalTask });
        const safeProfiles = profiles.filter((profile) => profile && typeof profile.alias === "string").map((profile) => ({
          alias: profile.alias,
          online: profile.online === true,
          xhsVersion: String(profile.xhsVersion ?? ""),
          androidSdk: String(profile.androidSdk ?? ""),
          resolution: String(profile.resolution ?? ""),
          dpi: String(profile.dpi ?? ""),
        }));
        const profileCachePath = path.join(outputRoot, "_device-profiles.json");
        const previousProfiles = (await readJsonIfExists(profileCachePath))?.profiles ?? [];
        const previousByAlias = new Map(previousProfiles.map((profile) => [profile.alias, profile]));
        versionChanges = safeProfiles.filter((profile) => {
          const previous = previousByAlias.get(profile.alias);
          return profile.online && profile.xhsVersion && previous?.xhsVersion && previous.xhsVersion !== profile.xhsVersion;
        }).map((profile) => ({
          deviceAlias: profile.alias,
          previousVersion: previousByAlias.get(profile.alias).xhsVersion,
          currentVersion: profile.xhsVersion,
        }));
        const merged = new Map(previousProfiles.map((profile) => [profile.alias, profile]));
        for (const profile of safeProfiles) merged.set(profile.alias, profile);
        await writeAtomic(profileCachePath, { profiles: [...merged.values()].sort((a, b) => a.alias.localeCompare(b.alias)) });
        await writeAtomic(path.join(taskDirectory, "device-profiles.json"), { profiles: safeProfiles });
      } catch {
        versionChanges = [];
      }
    }

    const discoveryPath = path.join(taskDirectory, "topic-discovery.json");
    let discovery = await readJsonIfExists(discoveryPath);
    const topicCachePath = path.join(outputRoot, "_topic-cache", `${stableHash(originalTask.topic).slice(0, 32)}.json`);
    if (!discovery) {
      const cachedTopic = await readFreshJson(topicCachePath, 30);
      if (cachedTopic) discovery = { status: "cached", suggestions: cachedTopic.suggestions ?? [] };
    }
    let suggestions = uniqueQueries(discovery?.suggestions ?? [], originalTask.topic, 12);
    if (!discovery && typeof provider.collectTopicSuggestions === "function") {
      discovery = { status: "skipped", suggestions: [] };
      const inputBlockedDevices = [];
      const discoveryFailures = [];
      let discoveryStop = null;
      const devices = await provider.listDevices({ deviceGroup: originalTask.deviceGroup, task: originalTask });
      const healthyDevices = devices.filter((device) => device?.online !== false).sort((a, b) => a.alias.localeCompare(b.alias));
      for (const device of healthyDevices) {
        try {
          const value = await provider.collectTopicSuggestions({ task: originalTask, device, deviceAlias: device.alias });
          if (Array.isArray(value)) {
            suggestions = uniqueQueries(value, originalTask.topic, 12);
            if (suggestions.length > 0) {
              discovery = { status: "completed", suggestions, inputBlockedDevices };
              break;
            }
          } else if (isObject(value)) {
            if (value.stopAll === true) {
              discoveryStop = {
                status: "human_required",
                suggestions: [],
                stopAll: true,
                failureSignature: value.failureSignature ?? "discovery:stop_all",
                humanReview: Array.isArray(value.humanReview) ? value.humanReview : [{ reason: "Sensitive discovery screen requires immediate human review" }],
              };
              break;
            }
            const deviceSuggestions = uniqueQueries(value.suggestions ?? [], originalTask.topic, 12);
            if (deviceSuggestions.length > 0) {
              suggestions = deviceSuggestions;
              discovery = { ...value, status: value.status ?? "completed", suggestions, inputBlockedDevices };
              break;
            }
            if (value.status === "human_required") {
              inputBlockedDevices.push({
                deviceAlias: device.alias,
                failureSignature: value.failureSignature ?? "input:human_required",
                humanReview: Array.isArray(value.humanReview) ? value.humanReview : [{ reason: "Manual Unicode search input is required on this device" }],
              });
            } else {
              discoveryFailures.push(value.failureSignature ?? `suggestions:empty:${device.alias}`);
            }
          }
        } catch (error) {
          discoveryFailures.push(error.failureSignature ?? error.code ?? `suggestions:failed:${device.alias}`);
        }
      }
      if (discoveryStop) {
        discovery = discoveryStop;
      } else if (suggestions.length === 0) {
        discovery = inputBlockedDevices.length > 0
          ? {
              status: "human_required",
              suggestions: [],
              inputBlockedDevices,
              failureSignature: "input:no_approved_device",
              humanReview: inputBlockedDevices.flatMap((entry) => entry.humanReview),
            }
          : {
              status: discoveryFailures.length > 0 ? "partial" : "skipped",
              suggestions: [],
              failureSignature: discoveryFailures[0] ?? null,
            };
      }
    }
    discovery ??= { status: "skipped", suggestions: [] };
    let trendingKeywords = uniqueQueries(discovery.trendingKeywords ?? [], originalTask.topic, 12);
    if (discovery.stopAll !== true && originalTask.sources.includes("trending") && discovery.trendingKeywords === undefined && typeof provider.collectTrendingKeywords === "function") {
      try {
        const devices = await provider.listDevices({ deviceGroup: originalTask.deviceGroup, task: originalTask });
        const first = devices.filter((device) => device?.online !== false).sort((a, b) => a.alias.localeCompare(b.alias))[0];
        if (first) {
          const value = await provider.collectTrendingKeywords({ task: originalTask, device: first, deviceAlias: first.alias });
          if (Array.isArray(value)) {
            trendingKeywords = uniqueQueries(value, originalTask.topic, 12);
            discovery = { ...discovery, trendingStatus: "completed", trendingKeywords };
          } else if (isObject(value)) {
            trendingKeywords = uniqueQueries(value.trendingKeywords ?? [], originalTask.topic, 12);
            discovery = {
              ...discovery,
              trendingStatus: value.status ?? "partial",
              trendingKeywords,
              ...(value.stopAll === true ? {
                status: "human_required",
                stopAll: true,
                failureSignature: value.failureSignature ?? "trending:stop_all",
                humanReview: value.humanReview ?? [{ reason: "Sensitive trending discovery screen requires immediate human review" }],
              } : {}),
            };
          }
        }
      } catch (error) {
        discovery = {
          ...discovery,
          trendingStatus: "partial",
          trendingKeywords: [],
          trendingFailureSignature: error.failureSignature ?? error.code ?? "trending:failed",
        };
      }
    }
    discovery = { ...discovery, trendingKeywords };
    await writeAtomic(discoveryPath, discovery);
    if (discovery.status === "completed" && suggestions.length > 0) {
      await writeAtomic(topicCachePath, { topic: originalTask.topic, suggestions, cachedAt: new Date().toISOString() });
    }

    let plannerOutput = null;
    if (originalTask.aiPolicy.topicPlanner && suggestions.length > 0 && configuredAi(options.ai) && Date.now() < deadlineAt) {
      try {
        const record = await runAiRole(roleOptions("topic_planner", {
          topic: originalTask.topic,
          seedKeywords: originalTask.seedKeywords,
          platformSuggestions: suggestions,
          platformTrending: trendingKeywords,
        }));
        plannerOutput = record.output;
        aiStatus.push({ role: "topic_planner", status: record.cacheHit ? "cache_hit" : "called", cacheKey: record.cacheKey });
      } catch (error) {
        aiStatus.push({ role: "topic_planner", status: "skipped", reason: error.message });
      }
    } else {
      const reason = Date.now() >= deadlineAt
        ? "TIME_BUDGET"
        : suggestions.length ? "AI_NOT_CONFIGURED_OR_DISABLED" : "NO_PLATFORM_SUGGESTIONS";
      aiStatus.push({ role: "topic_planner", status: "skipped", reason });
    }

    const effectiveTask = buildEffectiveTask(originalTask, suggestions, plannerOutput, trendingKeywords);
    const guardedProvider = shortCircuitUnicodeInput(provider, discovery);
    let summary = await runResearchTask(effectiveTask, {
      provider: guardedProvider,
      taskIdentity: originalTask,
      outputRoot,
      modelCalls: await aiCallCount(budgetPath),
      summaryFileName: "core-summary.json",
      deadlineAt,
    });
    if (summary.status === "duplicate") {
      const { duplicate: _duplicate, originalStatus, ...resumedSummary } = summary;
      summary = { ...resumedSummary, status: originalStatus };
    }

    const candidates = parseJsonLines(await readFile(summary.paths.candidatesJsonl, "utf8"));
    const reviewPath = summary.paths.humanReviewJsonl;
    let reviews = parseJsonLines(await readFile(reviewPath, "utf8"));
    let analysis = null;
    const analysisPath = path.join(taskDirectory, "analysis.json");
    if (originalTask.aiPolicy.resultAnalysis && candidates.length >= 5 && configuredAi(options.ai) && Date.now() < deadlineAt) {
      try {
        const input = { topic: originalTask.topic, candidates: publicAnalysisCandidates(candidates) };
        const record = await runAiRole(roleOptions("research_analysis", input));
        analysis = record.output;
        await writeAtomic(analysisPath, analysis);
        reviews = mergeAnalysisReviews(reviews, analysis, candidates, originalTask);
        await writeAtomic(reviewPath, reviews.map((value) => `${JSON.stringify(value)}\n`).join(""));
        aiStatus.push({ role: "research_analysis", status: record.cacheHit ? "cache_hit" : "called", cacheKey: record.cacheKey });
      } catch (error) {
        aiStatus.push({ role: "research_analysis", status: "skipped", reason: error.message });
      }
    } else {
      const reason = Date.now() >= deadlineAt
        ? "TIME_BUDGET"
        : candidates.length < 5 ? "FEWER_THAN_5_CANDIDATES" : "AI_NOT_CONFIGURED_OR_DISABLED";
      aiStatus.push({ role: "research_analysis", status: "skipped", reason });
    }

    const calls = await aiCallCount(budgetPath);
    const paths = {
      ...summary.paths,
      summaryJson: finalSummaryPath,
      aiStatusJson: path.join(taskDirectory, "ai-status.json"),
      ...(analysis ? { analysisJson: analysisPath } : {}),
    };
    const artifacts = {
      ...summary.artifacts,
      summary: finalSummaryPath,
      summaryJson: finalSummaryPath,
      ...(analysis ? { analysis: analysisPath } : {}),
    };
    summary = {
      ...summary,
      status: summary.status,
      counts: { ...summary.counts, humanReview: reviews.length, modelCalls: calls },
      aiCallsUsed: calls,
      paths,
      artifacts,
    };

    const maintenanceTriggers = [];
    if (versionChanges.length > 0) {
      const versionSignature = stableHash(versionChanges.map(({ previousVersion, currentVersion }) => ({ previousVersion, currentVersion }))).slice(0, 16);
      maintenanceTriggers.push({
        reason: "XHS_VERSION_CHANGED",
        failureSignature: `xhs-version-change:${versionSignature}`,
        devices: versionChanges,
      });
    }
    if (summary.globalFuse?.reason === "SAME_FAILURE_ON_TWO_DEVICES") {
      maintenanceTriggers.push({
        reason: summary.globalFuse.reason,
        failureSignature: summary.globalFuse.signature,
      });
    }
    const newMaintenanceTriggers = [];
    for (const trigger of maintenanceTriggers) {
      if (await reserveMaintenanceSignature(outputRoot, originalTask.taskId, trigger)) newMaintenanceTriggers.push(trigger);
      else aiStatus.push({ role: "maintenance_agent", status: "cached", reason: trigger.failureSignature });
    }
    if (newMaintenanceTriggers.length > 0) {
      const maintenancePath = path.join(taskDirectory, "maintenance-request.json");
      await writeAtomic(maintenancePath, {
        schemaVersion: 1,
        taskId: originalTask.taskId,
        failureSignature: newMaintenanceTriggers[0].failureSignature,
        reason: newMaintenanceTriggers[0].reason,
        triggers: newMaintenanceTriggers,
        requestedRole: "maintenance_agent",
        permission: "suggest_rules_or_code_only",
      });
      summary.paths.maintenanceRequestJson = maintenancePath;
    }
    await writeAtomic(paths.aiStatusJson, { schemaVersion: 1, automaticCalls: calls, roles: aiStatus });
    await writeAtomic(finalSummaryPath, summary);
    return summary;
  } finally {
    await releaseLock();
  }
}
