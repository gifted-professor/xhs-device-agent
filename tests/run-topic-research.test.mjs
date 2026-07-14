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

test("live gate accepts only approved native Chinese IME profiles", async () => {
  const native = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME";
  await assert.doesNotReject(validateLiveProviderConfig(
    await task(),
    {
      ...providerConfig(mappedDevices),
      nativeIme: {
        enabled: true,
        humanApproved: true,
        approvedAliases: ["content-01"],
        preferredServices: [native],
        calibrationProbe: "测试",
        calibrationPinyin: "ceshi",
        perDevice: {
          "content-01": {
            preferredService: native,
            chineseModeToggle: {
              humanApproved: true,
              imeService: native,
              x: 820,
              y: 2180,
              displayWidth: 1080,
              displayHeight: 2400,
              densityDpi: 440,
            },
          },
        },
      },
    },
    { listOnlineDevices: async () => ["test-serial-a", "test-serial-b"] },
  ));

  await assert.rejects(
    validateLiveProviderConfig(
      await task(),
      {
        ...providerConfig(mappedDevices),
        nativeIme: {
          enabled: true,
          humanApproved: true,
          approvedAliases: ["content-01"],
          preferredServices: ["com.android.xwkeyboard/.XwIME"],
        },
      },
      { listOnlineDevices: async () => ["test-serial-a", "test-serial-b"] },
    ),
    (error) => error.code === "INVALID_NATIVE_IME_CONFIG",
  );

  for (const chineseModeToggle of [
    { humanApproved: false, imeService: native, x: 820, y: 2180, displayWidth: 1080, displayHeight: 2400, densityDpi: 440 },
    { humanApproved: true, imeService: native, x: 820, y: 400, displayWidth: 1080, displayHeight: 2400, densityDpi: 440 },
    { humanApproved: true, imeService: "com.baidu.input_mi/.ImeService", x: 820, y: 2180, displayWidth: 1080, displayHeight: 2400, densityDpi: 440 },
  ]) {
    await assert.rejects(
      validateLiveProviderConfig(
        await task(),
        {
          ...providerConfig(mappedDevices),
          nativeIme: {
            enabled: true,
            humanApproved: true,
            approvedAliases: ["content-01"],
            preferredServices: [native],
            perDevice: { "content-01": { preferredService: native, chineseModeToggle } },
          },
        },
        { listOnlineDevices: async () => ["test-serial-a", "test-serial-b"] },
      ),
      (error) => error.code === "INVALID_NATIVE_IME_CONFIG",
    );
  }
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
      "raw identifier exposed as alias",
      [{ alias: "raw-device", serial: "raw-device", groups: ["content"] }],
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

test("formal run rechecks Xiaowei identity before creating a research session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-live-identity-gate-"));
  const taskPath = path.join(root, "task.json");
  const configPath = path.join(root, "provider.json");
  const bridgeIme = "com.android.xwkeyboard/.XwIME";
  const liveConfig = {
    ...providerConfig([mappedDevices[0]]),
    packageName: "com.xingin.xhs",
    xiaowei: {
      endpoint: "ws://127.0.0.1:22222/",
      api: {
        enabled: true,
        acceptedActions: ["imeList", "selectIme", "inputText"],
        acceptedActionsByAlias: { "content-01": ["imeList", "selectIme", "inputText"] },
        acceptedDeviceSerialsByAlias: { "content-01": "test-serial-a" },
        acceptedXiaoweiVersion: "test-version",
        currentXiaoweiVersion: "test-version",
      },
      textInput: {
        enabled: true,
        humanApproved: true,
        approvedAliases: ["content-01"],
        preferredImeServices: [bridgeIme],
        perDevice: {
          "content-01": {
            preferredImeService: bridgeIme,
            allowTemporaryEnable: false,
            echoVerification: "ui_text",
          },
        },
      },
    },
  };
  await Promise.all([
    writeFile(taskPath, JSON.stringify(await task({ taskId: "node-live-identity-gate" })), "utf8"),
    writeFile(configPath, JSON.stringify(liveConfig), "utf8"),
  ]);

  let identityChecks = 0;
  await assert.rejects(
    runFromArguments([
      "--task", taskPath,
      "--provider-config", configPath,
      "--output-root", path.join(root, "output"),
    ], {
      listOnlineDevices: async () => ["test-serial-a"],
      createXiaoweiTextInputAdapter: () => {
        const adapter = async () => { assert.fail("research work must not start"); };
        adapter.verifyIdentity = async () => {
          identityChecks += 1;
          const error = new Error("identity changed");
          error.code = "XIAOWEI_IDENTITY_MISMATCH";
          throw error;
        };
        return adapter;
      },
    }),
    (error) => error.code === "XIAOWEI_IDENTITY_MISMATCH"
      && !error.message.includes("test-serial-a"),
  );
  assert.equal(identityChecks, 1);
});

test("doctor blocks enabled Xiaowei text input when API and ADB identities differ", async () => {
  const source = await readFile(new URL("../scripts/Matrix-Preflight.ps1", import.meta.url), "utf8");
  assert.match(
    source,
    /elseif \(!\$api\.identityAligned\)\s*\{\s*\$configurationBlockers\.Add\("enabled Xiaowei text input requires aligned API and ADB device identities"\)\s*\}/u,
  );
  assert.match(source, /readyForDeviceWork\s*=\s*!\$configurationBlockers\.Count/u);
});
