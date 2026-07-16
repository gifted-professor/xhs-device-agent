---
name: record-device-control-learning
description: Close a device-control implementation or live-operation session by extracting new blockers, correcting unsupported conclusions, deduplicating recurring incidents, and recording evidence-gated lifecycle changes in the project handbook, strategy catalog, and incident ledger. Use after completing, stopping, or materially debugging a phone-control session, or when the user asks to沉淀踩坑、复盘故障、更新设备控制手册、记录已解决/未解决问题。
---

# Record device control learning

Turn one session into reusable, evidence-backed device-control knowledge. Do not treat a chat summary, documentation claim, or successful workaround as proof of a general fix.

## Close the session

1. Read `AGENTS.md`, `skills/xhs-device-operator/SKILL.md`, `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`, `config/device-control-playbook.json`, and `config/device-control-incidents.json` completely.
2. Inspect the session's actual code diff, relevant tests, policy output, and live named-HTTP results. Treat statements from Hermes or another Agent as candidate observations, not evidence.
3. Extract only reusable device-control incidents. Exclude ordinary task progress, App content, real identifiers, screenshot paths, coordinates, private UI text, and transient operator mistakes with no reusable lesson.
4. Read [references/incident-contract.md](references/incident-contract.md) and classify each incident as `open`, `mitigated`, `resolved`, `verified`, or `reopened`.
5. Build one closed candidate JSON object. Merge it through:

   `node skills/record-device-control-learning/scripts/record-learning.mjs --project-root . --candidate-base64 <BASE64_JSON>`

   Run `--dry-run` first when any lifecycle promotion is uncertain.
6. Update `config/device-control-playbook.json` only when a reusable failure class, strategy, stop condition, or implementation status changed. Do not store session history there.
7. Update `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` only when the general decision method changed. Do not append a diary of App-specific events.
8. Add or update regression tests for every `resolved` or `verified` incident. Preserve an existing open condition when a new path merely bypasses it.
9. Run the ledger validator, relevant tests, the full test suite when implementation changed, and the repository policy scan.
10. Report four lists: newly discovered, mitigated, resolved/verified, and still open/reopened. State the evidence level for every promotion.

## Evidence rules

- Record `open` from a reproducible observation or confirmed code constraint.
- Record `mitigated` only when a bounded workaround or alternate path exists while the root condition remains.
- Record `resolved` only for a confirmed root cause, a general fix, inspectable artifacts, and passing regression tests.
- Record `verified` only when all `resolved` requirements plus a fresh named-HTTP acceptance result exist.
- Record `reopened` when a previously mitigated, resolved, or verified fingerprint recurs on a new session.
- Never promote a state from documentation, test-count summaries without test identity, or another Agent's conclusion alone.

## Accuracy checks

- Separate capability scope. A navigation fix does not resolve a text-input gate.
- Separate compatibility from primary capability. Keeping a legacy special case means migration may be mitigated even when the generic path is verified.
- Separate fail-closed behavior from missing capability. A safe stop can be correct while the capability remains open.
- Separate implementation from live verification. Unit tests prove contracts; named HTTP acceptance proves the current environment.
- Reopen instead of creating a duplicate when the normalized fingerprint already exists.

## No-change close

If the session produced no reusable incident, do not invent one. Run:

`node skills/record-device-control-learning/scripts/record-learning.mjs --project-root . --validate`

Then report that the knowledge base remains valid and unchanged.
