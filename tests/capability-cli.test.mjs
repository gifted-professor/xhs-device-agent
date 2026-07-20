import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runCapabilityCommand } from "../scripts/capability-cli.mjs";

test("capability acceptance requires exact hashes and an explicit human flag", async () => {
  await assert.rejects(() => runCapabilityCommand([
    "accept", "--profile", "profile.json", "--evidence", "evidence.json",
    "--confirm-profile-hash", "a".repeat(64), "--confirm-evidence-hash", "b".repeat(64),
  ], { activateCapability: async () => assert.fail("must not activate") }), /confirm-human/u);

  let received = null;
  const result = await runCapabilityCommand([
    "accept", "--profile", "profile.json", "--evidence", "evidence.json",
    "--acceptance-root", "active", "--confirm-profile-hash", "a".repeat(64),
    "--confirm-evidence-hash", "b".repeat(64), "--confirm-human",
  ], {
    activateCapability: async (value) => {
      received = value;
      return {
        receipt: {
          capabilityProfileId: "accepted-v1", capabilityProfileHash: "a".repeat(64),
          acceptanceId: "acceptance-0123456789abcdef",
        },
        acceptanceHash: "c".repeat(64),
      };
    },
  });
  assert.equal(received.confirmHuman, true);
  assert.equal(path.isAbsolute(received.profilePath), true);
  assert.equal(path.isAbsolute(received.acceptanceRoot), true);
  assert.equal(result.status, "accepted");
});

test("capability status returns only public profile and accepted-limit bindings", async () => {
  const result = await runCapabilityCommand(["status", "--json"], {
    loadActiveCapability: async () => ({
      profile: { capabilityProfileId: "accepted-v1" },
      profileHash: "a".repeat(64), acceptanceHash: "b".repeat(64),
      receipt: { acceptedBy: "human", acceptedLimits: { maxDevices: 2, allowedActions: ["detail.inspect"] } },
    }),
  });
  assert.equal(result.status, "active");
  assert.equal(result.acceptedBy, "human");
  assert.equal(JSON.stringify(result).includes("sourceProfilePath"), false);
});
