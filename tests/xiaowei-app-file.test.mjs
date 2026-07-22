import assert from "node:assert/strict";
import test from "node:test";

import { XiaoweiClient } from "../scripts/lib/xiaowei-client.mjs";

function harness() {
  const calls = [];
  const transport = {
    async invoke(request) {
      calls.push(request);
      return { code: 10000, message: "SUCCESS", data: request.action === "apkList" ? { runtime: [] } : null };
    },
  };
  const client = new XiaoweiClient({
    transport,
    resolveDevice: async () => ({ identifier: "runtime-device" }),
  });
  return { client, calls };
}

test("app operations map to the observed Xiaowei action shapes", async () => {
  const { client, calls } = harness();
  await client.appList({ deviceAlias: "01" });
  await client.startApp({ deviceAlias: "01", apk: "com.example.any" });
  await client.stopApp({ deviceAlias: "01", apk: "com.example.any" });
  await client.installApp({ deviceAlias: "01", filePath: "D:\\arbitrary\\package.apk" });
  await client.uninstallApp({ deviceAlias: "01", apk: "com.example.any" });
  assert.deepEqual(calls, [
    { action: "apkList", devices: "runtime-device" },
    { action: "startApk", devices: "runtime-device", data: { apk: "com.example.any" } },
    { action: "stopApk", devices: "runtime-device", data: { apk: "com.example.any" } },
    { action: "installApk", devices: "runtime-device", data: { filePath: "D:\\arbitrary\\package.apk" } },
    { action: "uninstallApk", devices: "runtime-device", data: { apk: "com.example.any" } },
  ]);
});

test("file operations preserve all discovered path and media parameters", async () => {
  const { client, calls } = harness();
  await client.uploadFile({
    deviceAlias: "01",
    localPath: "D:\\anywhere\\source.bin",
    phonePath: "/sdcard/anywhere/target.bin",
    fileName: "target.bin",
    isMedia: false,
  });
  await client.pullFile({
    deviceAlias: "01",
    filePath: "/sdcard/anywhere/target.bin",
    savePath: "D:\\anywhere\\export",
    verify: false,
  });
  assert.deepEqual(calls, [
    {
      action: "uploadFile",
      devices: "runtime-device",
      data: {
        localPath: "D:\\anywhere\\source.bin",
        phonePath: "/sdcard/anywhere/target.bin",
        fileName: "target.bin",
        isMedia: false,
      },
    },
    {
      action: "pullFile",
      devices: "runtime-device",
      data: { filePath: "/sdcard/anywhere/target.bin", savePath: "D:\\anywhere\\export" },
    },
  ]);
});

test("typed app/file wrappers do not impose package or path allowlists", async () => {
  const { client } = harness();
  await assert.doesNotReject(client.installApp({ deviceAlias: "01", filePath: "Z:\\outside\\anything.apk" }));
  await assert.doesNotReject(client.uninstallApp({ deviceAlias: "01", apk: "com.vendor.systemlike" }));
  await assert.doesNotReject(client.uploadFile({
    deviceAlias: "01",
    localPath: "Z:\\outside\\file",
    phonePath: "/data/local/tmp/file",
    fileName: "file",
    isMedia: false,
  }));
});
