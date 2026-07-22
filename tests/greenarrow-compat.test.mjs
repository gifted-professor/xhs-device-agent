import assert from "node:assert/strict";
import test from "node:test";

import { createLegacyClient, executeLegacyCommand, runLegacyCli } from "../scripts/greenarrow-api.mjs";
import { XiaoweiError } from "../scripts/lib/xiaowei-errors.mjs";

function harness() {
  const calls = [];
  const transport = {
    async invoke(request, options) {
      calls.push({ request, options });
      return { code: 10000, message: "SUCCESS", data: { action: request.action } };
    },
  };
  return { calls, client: createLegacyClient({ transport }) };
}

test("legacy commands preserve all existing Xiaowei request shapes", async () => {
  const { calls, client } = harness();
  const env = { LVJIAN_DEVICE: "legacy-runtime-device" };

  await executeLegacyCommand(["list"], { env, client });
  await executeLegacyCommand(["home"], { env, client });
  await executeLegacyCommand(["back"], { env, client });
  await executeLegacyCommand(["start-xhs"], { env, client });
  await executeLegacyCommand(["tap", "12.5", "80"], { env, client });
  await executeLegacyCommand(["swipe-up"], { env, client });
  await executeLegacyCommand(["swipe-down"], { env, client });
  await executeLegacyCommand(["screenshot", "D:\\Evidence"], { env, client });
  await executeLegacyCommand(["shell", "wm", "size"], { env, client });

  assert.deepEqual(calls.map(({ request }) => request), [
    { action: "list" },
    { action: "pushEvent", devices: "legacy-runtime-device", data: { type: "2" } },
    { action: "pushEvent", devices: "legacy-runtime-device", data: { type: "3" } },
    { action: "startApk", devices: "legacy-runtime-device", data: { apk: "com.xingin.xhs" } },
    { action: "pointerEvent", devices: "legacy-runtime-device", data: { type: "0", x: "12.5", y: "80" } },
    { action: "pointerEvent", devices: "legacy-runtime-device", data: { type: "1", x: "12.5", y: "80" } },
    { action: "pointerEvent", devices: "legacy-runtime-device", data: { type: "6" } },
    { action: "pointerEvent", devices: "legacy-runtime-device", data: { type: "7" } },
    { action: "Screen", devices: "legacy-runtime-device", data: { savePath: "D:\\Evidence" } },
    { action: "adb_shell", devices: "legacy-runtime-device", data: { command: "wm size" } },
  ]);
});

test("legacy command result JSON remains unwrapped", async () => {
  const { client } = harness();
  const result = await executeLegacyCommand(["home"], { env: { LVJIAN_DEVICE: "legacy" }, client });
  assert.deepEqual(result, { code: 10000, message: "SUCCESS", data: { action: "pushEvent" } });

  const tap = await executeLegacyCommand(["tap", "10", "20"], { env: { LVJIAN_DEVICE: "legacy" }, client });
  assert.deepEqual(tap.percent, { x: "10", y: "20" });
  assert.equal(tap.down.data.action, "pointerEvent");
  assert.equal(tap.up.data.action, "pointerEvent");
});

test("legacy environment and usage errors remain compatible", async () => {
  const { client } = harness();
  await assert.rejects(executeLegacyCommand(["home"], { env: {}, client }), /LVJIAN_DEVICE/);
  await assert.rejects(executeLegacyCommand(["tap", "1"], { env: { LVJIAN_DEVICE: "legacy" }, client }), /tap <x百分比> <y百分比>/);
  await assert.rejects(executeLegacyCommand(["shell"], { env: { LVJIAN_DEVICE: "legacy" }, client }), /shell <adb shell 后面的命令>/);
  await assert.rejects(executeLegacyCommand(["tap-xhs"], { env: { LVJIAN_DEVICE: "legacy" }, client }), /不同手机桌面布局不同/);
});

test("legacy CLI prints exactly one JSON result", async () => {
  const { client } = harness();
  const output = [];
  await runLegacyCli(["back"], {
    env: { LVJIAN_DEVICE: "legacy" },
    client,
    io: { log(value) { output.push(value); } },
  });
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]), { code: 10000, message: "SUCCESS", data: { action: "pushEvent" } });
});

test("legacy CLI preserves vendor-error and connection-error behavior", async () => {
  const vendorResponse = { code: 10001, message: "参数不能为空" };
  const vendorClient = {
    async deviceList() {
      throw new XiaoweiError("XIAOWEI_VENDOR_ERROR", "rejected", { response: vendorResponse });
    },
  };
  assert.deepEqual(await executeLegacyCommand(["list"], { env: {}, client: vendorClient }), vendorResponse);

  const connectionClient = {
    async deviceList() { throw new XiaoweiError("XIAOWEI_CONNECTION_ERROR", "new internal message"); },
  };
  await assert.rejects(
    executeLegacyCommand(["list"], { env: {}, client: connectionClient }),
    /无法连接绿箭 API，请确认绿箭矩阵正在运行且 API 服务已开启/,
  );
});
