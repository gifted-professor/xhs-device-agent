import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseOnlineAdbDevices,
  runFromArguments,
  validateLiveProviderConfig,
} from "../scripts/run-topic-research.mjs";

async function task(overrides = {}) {
  const base = JSON.parse(await readFile(new URL("../config/research-task.example.json", import.meta.url), "utf8"));
  return { ...base, ...overrides };
}

function providerConfig(devices) {
  return { adbPath: "test-adb", devices };
}

const mappedDevices = [
  { alias: "content-01", serial: "test-serial-a", groups: ["content"] },
  { alias: "spare-01", serial: "test-serial-b", groups: ["spare"] },
];

test("ADB inventory parser only returns devices in the online state", () => {
  const output = [
    "List of devices attached",
    "test-serial-a\tdevice product:a model:a",
    "test-serial-b\toffline",
    "test-serial-c\tunauthorized",
    "test-serial-a\tdevice",
    "",
  ].join("\n");
  assert.deepEqual(parseOnlineAdbDevices(output), ["test-serial-a"]);
});

test("live gate accepts unique mappings with explicit groups and a non-empty task group", async () => {
  await assert.doesNotReject(validateLiveProviderConfig(
    await task(),
    providerConfig(mappedDevices),
    { listOnlineDevices: async () => ["test-serial-a", "test-serial-b"] },
  ));
});

test("live gate rejects implicit groups, duplicate aliases, duplicate identifiers, and an empty task group", async () => {
  const cases = [
    [
      "implicit groups",
      [{ alias: "content-01", serial: "test-serial-a" }],
      "INVALID_PROVIDER_CONFIG",
    ],
    [
      "duplicate groups",
      [{ alias: "content-01", serial: "test-serial-a", groups: ["content", "content"] }],
      "INVALID_PROVIDER_CONFIG",
    ],
    [
      "duplicate aliases",
      [
        { alias: "content-01", serial: "test-serial-a", groups: ["content"] },
        { alias: "content-01", serial: "test-serial-b", groups: ["content"] },
      ],
      "INVALID_PROVIDER_CONFIG",
    ],
    [
      "duplicate identifiers",
      [
        { alias: "content-01", serial: "test-serial-a", groups: ["content"] },
        { alias: "content-02", serial: "test-serial-a", groups: ["content"] },
      ],
      "INVALID_PROVIDER_CONFIG",
    ],
    [
      "empty task group",
      [{ alias: "spare-01", serial: "test-serial-a", groups: ["spare"] }],
      "EMPTY_TASK_DEVICE_GROUP",
    ],
  ];

  for (const [name, devices, code] of cases) {
    await assert.rejects(
      validateLiveProviderConfig(await task(), providerConfig(devices), {
        listOnlineDevices: async () => ["test-serial-a"],
      }),
      (error) => error.code === code,
      name,
    );
  }
});

test("live gate blocks an unmapped online device without leaking its identifier", async () => {
  const privateIdentifier = "private-online-identifier";
  await assert.rejects(
    validateLiveProviderConfig(await task(), providerConfig([mappedDevices[0]]), {
      listOnlineDevices: async () => ["test-serial-a", privateIdentifier],
    }),
    (error) => {
      assert.equal(error.code, "UNMAPPED_ONLINE_DEVICES");
      assert.equal(error.message.includes(privateIdentifier), false);
      return true;
    },
  );
});

test("live gate sanitizes ADB inventory failures", async () => {
  const privateIdentifier = "private-error-identifier";
  await assert.rejects(
    validateLiveProviderConfig(await task(), providerConfig([mappedDevices[0]]), {
      listOnlineDevices: async () => { throw new Error(`failed near ${privateIdentifier}`); },
    }),
    (error) => {
      assert.equal(error.code, "ADB_INVENTORY_FAILED");
      assert.equal(error.message.includes(privateIdentifier), false);
      return true;
    },
  );
});

test("formal run entry performs the Node inventory gate before creating a provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-live-gate-"));
  const taskPath = path.join(root, "task.json");
  const configPath = path.join(root, "provider.json");
  await Promise.all([
    writeFile(taskPath, JSON.stringify(await task({ taskId: "node-live-gate" })), "utf8"),
    writeFile(configPath, JSON.stringify(providerConfig([mappedDevices[0]])), "utf8"),
  ]);

  await assert.rejects(
    runFromArguments([
      "--task", taskPath,
      "--provider-config", configPath,
      "--output-root", path.join(root, "output"),
    ], {
      listOnlineDevices: async () => ["test-serial-a", "private-unmapped-device"],
    }),
    (error) => error.code === "UNMAPPED_ONLINE_DEVICES" && !error.message.includes("private-unmapped-device"),
  );
});
