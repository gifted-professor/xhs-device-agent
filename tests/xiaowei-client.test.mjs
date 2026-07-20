import assert from "node:assert/strict";
import test from "node:test";

import { createXiaoweiClient, XiaoweiClientError } from "../scripts/xiaowei-client.mjs";

const endpoint = "ws://127.0.0.1:22222/";

test("client requires local per-action acceptance before sending", async () => {
  let sent = false;
  const client = createXiaoweiClient({ endpoint, acceptedActions: [] }, {
    sendRequest: async () => { sent = true; return { code: 10000, message: "SUCCESS", data: null }; },
  });
  await assert.rejects(() => client.invoke("apkList", { devices: "test-device" }), (error) => {
    assert.equal(error.code, "CAPABILITY_NOT_ACCEPTED");
    return true;
  });
  assert.equal(sent, false);
});

test("read-only accepted action returns an unverified acknowledgement", async () => {
  let time = 10;
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, {
    now: () => { time += 5; return time; },
    sendRequest: async (request) => ({ code: 10000, message: "SUCCESS", data: { [request.devices]: [] } }),
  });
  const result = await client.invoke("apkList", { devices: "test-device" });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "accepted_unverified");
  assert.equal(result.audit.transport, "xiaowei-api");
  assert.equal(result.audit.durationMs, 5);
});

test("screen requires an approved local save root", async () => {
  let sent = false;
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["screen"] }, {
    sendRequest: async () => { sent = true; return { code: 10000, message: "SUCCESS", data: null }; },
  });
  const payload = { devices: "test-device", data: { savePath: "C:\\repo\\data\\runs" } };
  await assert.rejects(() => client.invoke("screen", payload), /approved local root/u);
  assert.equal(sent, false);
  const result = await client.invoke("screen", payload, {
    authorization: { mode: "verified_read", approvedSaveRoot: "C:\\repo\\data" },
  });
  assert.equal(result.ok, true);
  await assert.rejects(() => client.invoke("screen", {
    ...payload,
    data: { savePath: "C:\\outside" },
  }, { authorization: { mode: "verified_read", approvedSaveRoot: "C:\\repo\\data" } }), /approved local root/u);
});

test("catalog-only file actions cannot be enabled through the ordinary client", () => {
  for (const action of ["uploadFile", "pullFile", "installApk"]) {
    assert.throws(() => createXiaoweiClient({ endpoint, acceptedActions: [action] }), /cannot be enabled/u);
  }
});

test("navigation requires one device and an explicit postcondition", async () => {
  let sent = false;
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["startApk"] }, {
    sendRequest: async () => { sent = true; return { code: 10000, message: "SUCCESS", data: null }; },
  });
  await assert.rejects(
    () => client.invoke("startApk", { devices: "test-device", data: { apk: "com.xingin.xhs" } }),
    /verification plan/u,
  );
  const result = await client.invoke("startApk", {
    devices: "test-device",
    data: { apk: "com.xingin.xhs" },
  }, {
    authorization: {
      mode: "verified_navigation",
      singleDevice: true,
      expectedPostcondition: "focused package is com.xingin.xhs",
      approvedPackage: "com.xingin.xhs",
    },
  });
  assert.equal(result.outcome, "accepted_unverified");
  assert.equal(sent, true);
});

test("ordinary client repeats the single-device, key subset, and exact-package gates", async () => {
  let sent = false;
  const sendRequest = async () => { sent = true; return { code: 10000, message: "SUCCESS", data: null }; };
  const readClient = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, { sendRequest });
  await assert.rejects(() => readClient.invoke("apkList", { devices: "all" }), /exactly one device/u);

  const keyClient = createXiaoweiClient({ endpoint, acceptedActions: ["pushEvent"] }, { sendRequest });
  await assert.rejects(() => keyClient.invoke("pushEvent", {
    devices: "test-device",
    data: { type: "1" },
  }, {
    authorization: {
      mode: "verified_navigation",
      singleDevice: true,
      expectedPostcondition: "task manager is visible",
    },
  }), /only HOME and BACK/u);

  const appClient = createXiaoweiClient({ endpoint, acceptedActions: ["startApk"] }, { sendRequest });
  await assert.rejects(() => appClient.invoke("startApk", {
    devices: "test-device",
    data: { apk: "com.example.app" },
  }, {
    authorization: {
      mode: "verified_navigation",
      singleDevice: true,
      expectedPostcondition: "approved app is focused",
      approvedPackage: "com.example.other",
    },
  }), /exact approved application package/u);
  assert.equal(sent, false);
});

test("stopApk requires both session confirmation and the exact approved package", async () => {
  let sent = false;
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["stopApk"] }, {
    sendRequest: async () => { sent = true; return { code: 10000, message: "SUCCESS", data: null }; },
  });
  await assert.rejects(() => client.invoke("stopApk", {
    devices: "test-device",
    data: { apk: "com.example.app" },
  }, {
    authorization: {
      mode: "session_confirmation",
      confirmed: true,
      reason: "approved maintenance",
      rollback: "restart approved app",
      approvedPackage: "com.example.other",
    },
  }), /exact approved application package/u);
  assert.equal(sent, false);
});

test("approved per-device profiles can authorize only selectIme and inputText", async () => {
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["inputText"] }, {
    sendRequest: async () => ({ code: 10000, message: "SUCCESS", data: null }),
  });
  const approved = await client.invoke("inputText", {
    devices: "test-device",
    data: { content: "test" },
  }, {
    authorization: { mode: "approved_device_profile", capability: "inputText", deviceAlias: "device-01" },
  });
  assert.equal(approved.ok, true);
  assert.throws(
    () => createXiaoweiClient({ endpoint, acceptedActions: ["writeClipBoard"] }),
    /cannot be enabled/u,
  );
});

test("destructive catalog-only actions cannot be enabled through the ordinary client", () => {
  for (const action of ["uninstallApk", "removeTag", "removeTagDevice"]) {
    assert.throws(() => createXiaoweiClient({ endpoint, acceptedActions: [action] }), /cannot be enabled/u);
  }
});

test("privileged, catalog-only, and opaque automation actions cannot be accepted by the ordinary client", () => {
  for (const action of ["adb", "adb_shell", "pointerEvent", "actionTasks", "autojsTasks", "actionCreate", "actionRemove", "autojsCreate", "autojsRemove"]) {
    assert.throws(() => createXiaoweiClient({ endpoint, acceptedActions: [action] }), /cannot be enabled/u);
  }
});

test("send-timeout errors preserve an unknown outcome", async () => {
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, {
    sendRequest: async () => { throw new Error("Xiaowei API timed out after the request was sent; device outcome is unknown"); },
  });
  await assert.rejects(() => client.invoke("apkList", { devices: "test-device" }), (error) => {
    assert.ok(error instanceof XiaoweiClientError);
    assert.equal(error.outcome, "unknown");
    return true;
  });
});

test("any transport error explicitly marked sent remains unknown regardless of message text", async () => {
  const error = new Error("socket closed");
  error.sent = true;
  error.outcome = "failed";
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, {
    sendRequest: async () => { throw error; },
  });
  await assert.rejects(() => client.invoke("apkList", { devices: "test-device" }), (caught) => {
    assert.equal(caught.outcome, "unknown");
    assert.equal(caught.sent, true);
    return true;
  });
});

test("a vendor failure is known to have crossed the send boundary", async () => {
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, {
    sendRequest: async () => ({ code: 10001, message: "REJECTED", data: null }),
  });
  await assert.rejects(() => client.invoke("apkList", { devices: "test-device" }), (caught) => {
    assert.equal(caught.code, "VENDOR_FAILED");
    assert.equal(caught.outcome, "failed");
    assert.equal(caught.sent, true);
    return true;
  });
});

test("a parseable but invalid response envelope remains an unknown sent outcome", async () => {
  const client = createXiaoweiClient({ endpoint, acceptedActions: ["apkList"] }, {
    sendRequest: async () => ({ message: "missing code" }),
  });
  await assert.rejects(() => client.invoke("apkList", { devices: "test-device" }), (error) => {
    assert.ok(error instanceof XiaoweiClientError);
    assert.equal(error.code, "INVALID_RESPONSE");
    assert.equal(error.outcome, "unknown");
    assert.equal(error.sent, true);
    return true;
  });
});
