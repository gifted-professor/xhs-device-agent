import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../scripts/xhs-cli.mjs";

function harness() {
  const calls = [];
  const output = [];
  return {
    calls,
    output,
    services: {
      rawService: {
        async resolveDevice(alias) { calls.push(["resolve", alias]); return { vendorDevice: { sort: 1, model: "test" } }; },
        async invokeRaw(body) { calls.push(["raw", body]); return { ok: true, action: body.action }; },
      },
      client: {
        async deviceList() { calls.push(["list"]); return { code: 10000, data: [{ sort: 1, serial: "secret" }] }; },
        async invoke(id, input) { calls.push(["invoke", id, input]); return { status: "executed" }; },
      },
      async discover(options) { calls.push(["discover", options]); return [{ action: "apkList", ok: true }]; },
      operationService: { get(id) { calls.push(["operation", id]); return { operationId: id }; } },
      hostStatus: async () => ({ ok: true, host: "DESKTOP-3I1EVHE" }),
    },
    io: { log(value) { output.push(value); }, error(value) { output.push(value); } },
  };
}

test("raw CLI accepts arbitrary actions without a lab session", async () => {
  const h = harness();
  await runCli(["device", "raw", "--device", "01", "--action", "futureAction", "--data", '{"opaque":[1,true]}'], h);
  assert.deepEqual(h.calls, [
    ["resolve", "01"],
    ["raw", { deviceAlias: "01", action: "futureAction", data: { opaque: [1, true] } }],
  ]);
});

test("typed invoke and read-only discovery use public alias 01", async () => {
  const h = harness();
  await runCli(["device", "invoke", "--device", "01", "--capability", "input.key.home", "--params", "{}"], h);
  await runCli(["device", "discover", "--device", "01", "--read-only"], h);
  assert.deepEqual(h.calls.slice(0, 3), [
    ["resolve", "01"],
    ["invoke", "input.key.home", { deviceAlias: "01", params: {} }],
    ["resolve", "01"],
  ]);
  assert.deepEqual(h.calls[3], ["discover", { deviceAlias: "01" }]);
});

test("CLI rejects serial exposure and aliases other than 01", async () => {
  const h = harness();
  await assert.rejects(runCli(["device", "raw", "--serial", "secret", "--action", "x"], h), /--serial is not supported/);
  await assert.rejects(runCli(["device", "raw", "--device", "02", "--action", "x"], h), /only device alias 01/);
});

test("device list removes runtime identifiers", async () => {
  const h = harness();
  await runCli(["device", "list"], h);
  assert.doesNotMatch(h.output.join("\n"), /secret|serial/);
  assert.match(h.output.join("\n"), /"alias": "01"/);
});
