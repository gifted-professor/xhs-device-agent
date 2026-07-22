import { randomUUID } from "node:crypto";

import { MemoryEvidenceSink } from "./xiaowei-evidence.mjs";
import { XiaoweiError } from "./xiaowei-errors.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function fingerprint(request) {
  return JSON.stringify(canonical(request));
}

export class XiaoweiOperationService {
  constructor({ execute, verify, restore, evidence = new MemoryEvidenceSink(), now = Date.now } = {}) {
    if (typeof execute !== "function") throw new TypeError("execute is required");
    this.execute = execute;
    this.verify = verify;
    this.restore = restore;
    this.evidence = evidence;
    this.now = now;
    this.idempotency = new Map();
    this.operations = new Map();
    this.activeAliases = new Set();
  }

  run({ idempotencyKey, request, labSession, labContext }) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return Promise.reject(new XiaoweiError("XIAOWEI_IDEMPOTENCY_REQUIRED", "idempotency key is required"));
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return Promise.reject(new XiaoweiError("XIAOWEI_INVALID_REQUEST", "operation request must be an object"));
    }
    if (labSession) labSession.assertUsable({ deviceAlias: request.deviceAlias, ...labContext });

    const requestFingerprint = fingerprint(request);
    const prior = this.idempotency.get(idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== requestFingerprint) {
        return Promise.reject(new XiaoweiError("XIAOWEI_IDEMPOTENCY_CONFLICT", "idempotency key conflict"));
      }
      return prior.promise;
    }

    if (this.activeAliases.has(request.deviceAlias)) {
      return Promise.reject(new XiaoweiError("XIAOWEI_DEVICE_BUSY", `device ${request.deviceAlias} already has an active operation`));
    }
    const promise = this.#executeOperation(request);
    this.idempotency.set(idempotencyKey, { fingerprint: requestFingerprint, promise });
    return promise;
  }

  get(operationId) {
    return this.operations.get(operationId) || null;
  }

  async #executeOperation(request) {
    const operationId = randomUUID();
    const startedAt = this.now();
    const base = { operationId, deviceAlias: request.deviceAlias, capability: request.capability, startedAt };
    const operation = { ...base, status: "accepted" };
    this.operations.set(operationId, operation);
    this.activeAliases.add(request.deviceAlias);
    this.evidence.append({ ...base, stage: "accepted" });

    let execution;
    let verification;
    let primaryError;
    let status = "verified";

    try {
      operation.status = "executing";
      this.evidence.append({ ...base, stage: "executing" });
      execution = await this.execute(request);
      if (this.verify) {
        operation.status = "verifying";
        this.evidence.append({ ...base, stage: "verifying", vendorCode: execution?.vendorCode });
        verification = await this.verify({ request, execution });
      }
    } catch (error) {
      primaryError = error;
      status = error?.sent || error?.code === "XIAOWEI_TIMEOUT" ? "ambiguous" : "failed";
    } finally {
      if (this.restore) {
        operation.status = "restoring";
        this.evidence.append({ ...base, stage: "restoring", vendorCode: execution?.vendorCode });
        try {
          await this.restore({ request, execution, verification, error: primaryError });
        } catch (restoreError) {
          if (!primaryError) primaryError = restoreError;
          status = "failed";
        }
      }
      this.activeAliases.delete(request.deviceAlias);
    }

    const finishedAt = this.now();
    const result = {
      operationId,
      deviceAlias: request.deviceAlias,
      capability: request.capability,
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      vendorCode: execution?.vendorCode ?? null,
      errorClass: primaryError?.code || primaryError?.name || null,
    };
    this.operations.set(operationId, result);
    this.evidence.append({
      ...base,
      stage: status,
      status,
      finishedAt,
      durationMs: result.durationMs,
      vendorCode: result.vendorCode,
      errorClass: result.errorClass,
      hash: verification?.hash,
    });
    return result;
  }
}
