const ALLOWED_FIELDS = new Set([
  "operationId", "stage", "status", "deviceAlias", "capability", "vendorCode", "durationMs",
  "hash", "errorClass", "startedAt", "finishedAt", "outcome",
]);

export function redactEvidence(event) {
  return Object.fromEntries(
    Object.entries(event).filter(([key, value]) => ALLOWED_FIELDS.has(key) && value !== undefined),
  );
}

export class MemoryEvidenceSink {
  constructor() {
    this.events = [];
  }

  append(event) {
    const redacted = redactEvidence(event);
    this.events.push(redacted);
    return redacted;
  }
}
