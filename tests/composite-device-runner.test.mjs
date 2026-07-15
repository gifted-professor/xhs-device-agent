import assert from "node:assert/strict";
import test from "node:test";

import { CompositeDeviceRunner } from "../scripts/composite-device-runner.mjs";

test("runner maps only registry actions and never invents forbidden calls", async () => {
  const calls = [];
  const adapter = {
    observe: async (step) => { calls.push(["observe", step.action]); return { status: "observed" }; },
    bindTarget: async (step) => { calls.push(["bind", step.action]); return { targetHash: "a".repeat(64) }; },
    sendOnce: async (step) => { calls.push(["send", step.action]); return { sent: false }; },
    verify: async (step) => { calls.push(["verify", step.action]); return { status: "verified" }; },
  };
  const runner = new CompositeDeviceRunner({ adapter });
  for (const action of ["comments.observe_count", "comments.open", "comments.collect", "comments.close", "image.scroll_content", "video.advance", "engagement.ensure_liked", "engagement.ensure_favorited"]) {
    const result = await runner.execute({ stepId: "m01.s001", action, params: {} });
    assert.equal(result.status, "verified");
  }
  await assert.rejects(() => runner.execute({ stepId: "m01.s001", action: "comment.send", params: {} }), /unsupported composite action/);
  assert.equal(calls.some((entry) => /input|send_comment|message|follow|profile|publish|delete/iu.test(entry[1])), false);
});
