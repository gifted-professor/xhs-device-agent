import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { XiaoweiClient, normalizeCoordinates } from "../scripts/lib/xiaowei-client.mjs";
import { verifyStableFile } from "../scripts/lib/xiaowei-verifiers.mjs";

function harness({ currentIme = "ime.old/.IME" } = {}) {
  const calls = [];
  const aliases = [];
  const transport = {
    async invoke(request) {
      calls.push(request);
      if (request.action === "list") return { code: 10000, data: [{ sort: 1 }] };
      if (request.action === "imeList") return { code: 10000, data: ["ime.old/.IME", "ime.new/.IME"] };
      return { code: 10000, message: "SUCCESS", data: null };
    },
  };
  const client = new XiaoweiClient({
    transport,
    resolveDevice: async (alias) => {
      aliases.push(alias);
      return { identifier: "runtime-device-id" };
    },
    readCurrentIme: async () => currentIme,
  });
  return { client, calls, aliases };
}

test("device list uses the non-targeted list action", async () => {
  const { client, calls } = harness();
  const result = await client.deviceList();
  assert.equal(result.code, 10000);
  assert.deepEqual(calls, [{ action: "list" }]);
});

test("Home and Back map to documented pushEvent types", async () => {
  const { client, calls, aliases } = harness();
  assert.equal((await client.home({ deviceAlias: "01" })).status, "executed");
  assert.equal((await client.back({ deviceAlias: "01" })).status, "executed");
  assert.deepEqual(aliases, ["01", "01"]);
  assert.deepEqual(calls, [
    { action: "pushEvent", devices: "runtime-device-id", data: { type: "2" } },
    { action: "pushEvent", devices: "runtime-device-id", data: { type: "3" } },
  ]);
});

test("tap requires an explicit coordinate space and sends down/up", async () => {
  const { client, calls } = harness();
  const result = await client.tap({
    deviceAlias: "01",
    coordinate: { space: "sourcePixels", x: 540, y: 1200, width: 1080, height: 2400 },
  });
  assert.equal(result.status, "executed");
  assert.deepEqual(calls, [
    { action: "pointerEvent", devices: "runtime-device-id", data: { type: "0", x: "50", y: "50" } },
    { action: "pointerEvent", devices: "runtime-device-id", data: { type: "1", x: "50", y: "50" } },
  ]);
  assert.throws(() => normalizeCoordinates({ x: 1, y: 2 }), /coordinate space/);
});

test("swipe maps only documented one-shot up/down pointer events", async () => {
  const { client, calls } = harness();
  await client.swipe({ deviceAlias: "01", direction: "up" });
  await client.swipe({ deviceAlias: "01", direction: "down" });
  assert.deepEqual(calls.map((call) => call.data), [{ type: "6" }, { type: "7" }]);
  await assert.rejects(client.autoScroll({ deviceAlias: "01", operation: "start" }), /service is unavailable/);
});

test("typed auto-scroll delegates start, status, and stop to the managed service", async () => {
  const calls = [];
  const client = new XiaoweiClient({
    transport: { async invoke() { throw new Error("transport should not be called directly"); } },
    resolveDevice: async () => ({ identifier: "runtime-device-id" }),
    autoScrollService: {
      control(input) {
        calls.push(input);
        return { status: input.operation === "status" ? "running" : input.operation };
      },
    },
  });
  await client.invoke("input.pointer.autoScroll", {
    deviceAlias: "01",
    params: { operation: "start", direction: "up", intervalMs: 2000, maxSwipes: 3 },
  });
  await client.invoke("input.pointer.autoScroll", { deviceAlias: "01", params: { operation: "status" } });
  await client.invoke("input.pointer.autoScroll", { deviceAlias: "01", params: { operation: "stop", waitMs: 1000 } });
  assert.deepEqual(calls, [
    { deviceAlias: "01", operation: "start", direction: "up", intervalMs: 2000, maxSwipes: 3, waitMs: undefined },
    { deviceAlias: "01", operation: "status", direction: undefined, intervalMs: undefined, maxSwipes: undefined, waitMs: undefined },
    { deviceAlias: "01", operation: "stop", direction: undefined, intervalMs: undefined, maxSwipes: undefined, waitMs: 1000 },
  ]);
});

test("IME list/select and text input preserve documented request shapes", async () => {
  const { client, calls } = harness({ currentIme: "ime.new/.IME" });
  const list = await client.imeList({ deviceAlias: "01" });
  assert.equal(list.code, 10000);
  const selected = await client.selectIme({ deviceAlias: "01", ime: "ime.new/.IME" });
  assert.equal(selected.status, "verified");
  await client.inputText({ deviceAlias: "01", content: "本地测试" });
  assert.deepEqual(calls, [
    { action: "imeList", devices: "runtime-device-id" },
    { action: "selectIme", devices: "runtime-device-id", data: { ime: "ime.new/.IME" } },
    { action: "inputText", devices: "runtime-device-id", data: { content: "本地测试" } },
  ]);
});

test("screen capture verifier requires a stable non-zero file and hashes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-screen-"));
  mkdirSync(root, { recursive: true });
  const path = join(root, "probe.png");
  writeFileSync(path, Buffer.from("fake-png-content"));
  const result = await verifyStableFile(path, { settleMs: 1 });
  assert.equal(result.status, "verified");
  assert.equal(result.bytes, 16);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("screen capture verifies the new image Xiaowei creates inside a save directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "xiaowei-screen-directory-"));
  writeFileSync(join(root, "existing.png"), Buffer.from("old"));
  const client = new XiaoweiClient({
    transport: {
      async invoke(request) {
        if (request.action === "Screen") {
          setTimeout(() => writeFileSync(join(root, "new-capture.png"), Buffer.from("new-image")), 50);
        }
        return { code: 10000, message: "SUCCESS" };
      },
    },
    resolveDevice: async () => ({ identifier: "runtime-device-id" }),
  });
  const result = await client.screenCapture({ deviceAlias: "01", savePath: root });
  assert.equal(result.status, "verified");
  assert.equal(result.verification.bytes, 9);
  assert.match(result.verification.sha256, /^[a-f0-9]{64}$/);
});
