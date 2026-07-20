---
name: xhs-device-operator
description: Safely inventory, diagnose, run deterministic read-only Xiaohongshu research, and execute a narrowly scoped like/favorite acceptance template while the user physically supervises the selected machine.
---

# XHS device operator

## Run the workflow

1. Read `docs/RESEARCH_AUTOMATION.md` and `docs/INPUT_METHOD_WORKFLOW.md` for task, result, and input contracts. Load `config/local.psd1` and the local per-device input policy without displaying or committing real identifiers. Use `xhs.cmd` as the only device-operation entry point.
2. Run `xhs.cmd doctor`, `xhs.cmd host status`, and `xhs.cmd device list`. Treat Xiaowei as projection, grouping, and human takeover; use ADB as the production execution channel. Keep the Xiaowei API disabled unless its probe and the exact action have been formally validated. Read the `windowsCapture` result before using Computer Use: when `computerUseWindowScreenshotCompatible=false`, do not request or retry its Xiaowei desktop screenshot because Windows build 19045 does not expose `GraphicsCaptureSession.IsBorderRequired`. Use ADB screenshots plus fresh UI hierarchy for phone content. When a Xiaowei desktop image is genuinely needed, activate only its window with Computer Use, then run `xhs.cmd host capture` for that foreground, fully visible window. Keep the image under the ignored `data/windows-capture` folder and never use this helper for keyboard or pointer input.
3. Refuse formal work until every currently online phone has a unique two-digit machine number, a visible machine name, an internal binding, and an explicit group. Use the machine number and name in operator consultation and reports; names may repeat, so the number is primary. Never expose internal aliases or substitute sorted serials for machine numbers.
4. Accept only tasks with `mode=research_read_only` and `interactionPolicy=human_final`. Reject any field or value requesting likes, favorites, follows, comment sending, messages, publishing, deletion, or payment.
5. Run `scripts/Run-TopicResearch.ps1 -TaskPath <task.json>`. Let Hermes only drop task files; keep validation, allocation, budgets, idempotency, and failure handling inside the research runner.
6. Resolve every phone independently through its fresh UI hierarchy. Prefer resource ID, then text/content description, then stable node relations. Use a device override only for its calibrated alias, resolution, DPI, and exact Xiaohongshu version.
   Never use generic group `TapText` or a full-screen `Swipe` for research. Scroll only a semantic list or image-note content container; never swipe a video canvas.
7. Require two matching normalized UI fingerprints 500 ms apart within 8 seconds before acting. Verify the target state afterward; never replay an uncertain click.
8. Before non-ASCII input, inventory the device's installed IME services and language subtypes, select an explicitly approved native Chinese IME, calibrate its Chinese mode once in a safe local field, and verify exact search-box echo. Never use `adb shell input text` for Chinese and never treat a bridge keyboard as a native Chinese IME. Restore the prior default IME at the end. A failed alias must not block an approved peer; after two calibration or echo failures, retain evidence and return `human_required`. After human handling or adapter approval, continue with a new taskId so the original result remains idempotent.
9. Keep AI event-driven: topic planning once per uncached topic, page recovery at most twice after local failure, and result analysis once after at least five candidates. Expand bounded queries from platform suggestions and read-only trending terms. Enforce the task's total automatic-call cap of four.
10. For page recovery, run both Windows local-OCR privacy checks against the same screenshot file and require a SHA-256 attestation tying that exact file to the upload. A boolean safety flag alone is never sufficient. Block login, challenge, permission, order, account-privacy, payment, message, and contact screens. Require confidence at least 0.90, no coordinates, and re-resolution of the semantic target in a new UI dump; otherwise stop for a human.
11. Stop a device after two consecutive transitions fail and retain its current screenshot and hierarchy paths. Trigger the global fuse when two devices produce the same failure signature. Stop all devices on login, CAPTCHA, risk, payment, private-message, contact, or permission screens.
12. Report only machine number, visible name, and result artifact paths. Treat local JSON/JSONL as the source of truth; run `scripts/sync-research-review.mjs` only for an already approved Feishu table. The sync must pull unambiguous human review decisions into the local queue before mirroring rows back.

## Physically supervised `trusted-10` acceptance

Use this mode only after the user explicitly approves the current run and confirms that they are physically watching the selected machine for the entire run.

1. Re-run `xhs.cmd host status` and `xhs.cmd device list`. Continue only when the requested machine number resolves uniquely and is online.
2. Use one machine, one foreground SSH session, and one new task ID. Do not run parallel or unattended Feed tasks.
3. Run only `xhs.cmd feed run --template trusted-10 --machine <two-digit-number> --task-id <new-task-id>`.
4. The reviewed interaction budget is exactly one like at item 5 and one favorite at item 7. No other engagement action is authorized.
5. Require semantic target resolution plus fresh before/after evidence. Accept only a verified active state; an unknown, mismatched, or already-active state stops the run for human review instead of toggling blindly.
6. Bounded dwell times are allowed only to verify that Xiaohongshu stayed in the foreground. They must not be used for evasion, account warming, or simulated-identity workflows.
7. Stop immediately on login, CAPTCHA, challenge, risk-control, payment, private-message, contact, permission, account, or identity-mismatch pages. Never bypass or retry through those gates.
8. If SSH disconnects, do not create a replacement task ID. Inspect the existing task's `checkpoint.json`, `summary.json`, and `events.jsonl` first.
9. Completion requires 10 viewed items, zero unresolved failures, foreground and return-to-Feed verification for every item, verified action-state evidence, and a final Feed screenshot.

## Human-final handoff

Require the operator to show only one phone in Xiaowei and confirm group synchronization is off. Then use `xhs.cmd handoff review` with one candidate ID, one machine number, and `--confirm-single-device-and-sync-off` to navigate and pause. Treat an absent, ambiguous, or identity-mismatched candidate as `human_required`; never open a generic first result. Generate a comment draft only after an explicit human request; never fill or send it.

## Hard boundaries

- Automated like and favorite are permitted only inside the explicitly approved, physically supervised `trusted-10` mode above. Following, comments, replies, messages, shares, publishing, deletion, login verification, payments, and all other external communication remain human-final.
- Never bypass CAPTCHAs, risk controls, platform limits, identity checks, membership restrictions, or system permission prompts.
- Never implement random dwell time, simulated-human behavior, automated account warming, or device/network identity manipulation.
- Never share coordinates across phones or upload sensitive screens to a model.
- Never reuse another device's IME mode, subtype, or coordinate profile, and never silently fall back to an unverified bridge keyboard.
- Never call raw ADB, internal scripts, or the Xiaowei WebSocket directly for device actions; use `xhs.cmd` so preflight, evidence, and idempotency gates remain active.
- Never commit `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, tokens, SSH keys, or real device/account identifiers.
