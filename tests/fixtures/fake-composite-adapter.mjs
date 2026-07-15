export function createFakeCompositeAdapter({ verificationByStep = {}, clock } = {}) {
  const calls = [];
  const sends = new Map();
  const flushes = [];
  const verifications = [];
  return {
    calls,
    sends,
    flushes,
    verifications,
    async observe(step, context) {
      calls.push({ method: "observe", stepId: step.stepId, recovery: context?.recovery === true });
      return { status: "observed", pageState: "IMAGE_NOTE", observedAt: clock?.now?.() ?? 0 };
    },
    async bindTarget(step) {
      calls.push({ method: "bindTarget", stepId: step.stepId });
      return { targetHash: `target-${step.stepId}` };
    },
    async sendOnce(step, binding) {
      calls.push({ method: "sendOnce", stepId: step.stepId, targetHash: binding?.targetHash ?? null });
      sends.set(step.stepId, (sends.get(step.stepId) ?? 0) + 1);
      return { status: "sent" };
    },
    async verify(step, binding, context) {
      calls.push({ method: "verify", stepId: step.stepId, recovery: context?.recovery === true });
      verifications.push({ stepId: step.stepId, binding: structuredClone(binding), recovery: context?.recovery === true });
      return verificationByStep[step.stepId] ?? { status: "verified", targetHash: binding?.targetHash ?? null };
    },
    async captureEvidence(reason) {
      calls.push({ method: "captureEvidence", reason });
      return `evidence-${reason}`;
    },
    async flushReadOnly(reason, events) {
      calls.push({ method: "flushReadOnly", reason, count: events.length });
      flushes.push({ reason, events: structuredClone(events) });
    },
    sendCount(stepId) {
      return sends.get(stepId) ?? 0;
    },
  };
}

export function createFakeClock(start = 0) {
  let value = start;
  return {
    now() { return value; },
    advance(ms) { value += ms; },
  };
}
