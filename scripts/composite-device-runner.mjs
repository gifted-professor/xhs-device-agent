import { ACTION_REGISTRY } from "./composite-action-registry.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export class CompositeDeviceRunner {
  constructor({ adapter }) {
    invariant(adapter && typeof adapter === "object", "composite adapter is required");
    this.adapter = adapter;
  }

  async execute(step) {
    invariant(ACTION_REGISTRY[step?.action], `unsupported composite action: ${String(step?.action)}`);
    const observed = await this.adapter.observe(step, { recovery: false });
    const binding = await this.adapter.bindTarget(step, { observed });
    const sendOutcome = await this.adapter.sendOnce(step, binding, { observed });
    return this.adapter.verify(step, binding, { observed, sendOutcome, recovery: false });
  }
}
