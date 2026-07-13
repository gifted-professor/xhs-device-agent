---
name: xhs-device-operator
description: Safely inventory, diagnose, and run deterministic read-only Xiaohongshu topic research across multiple Android phones through Xiaowei projection and ADB. Use for device preflight, per-device semantic navigation, search/suggestion/trending/recommendation collection, page recovery, human-review handoff, and approved Feishu result mirroring; never use it for automated engagement or publishing.
---

# XHS device operator

## Run the workflow

1. Read `docs/RESEARCH_AUTOMATION.md` for task and result contracts. Load `config/local.psd1` without displaying or committing real identifiers.
2. Run `scripts/Matrix-Preflight.ps1`. Treat Xiaowei as projection, grouping, and human takeover; use ADB as the production execution channel. Keep the Xiaowei API disabled unless its probe and the exact action have been formally validated. Read the `windowsCapture` result before using Computer Use: when `computerUseWindowScreenshotCompatible=false`, do not request or retry its Xiaowei desktop screenshot because Windows build 19045 does not expose `GraphicsCaptureSession.IsBorderRequired`. Use ADB screenshots plus fresh UI hierarchy for phone content. When a Xiaowei desktop image is genuinely needed, activate only its window with Computer Use, then run `scripts/Capture-VisibleWindow.ps1` for that foreground, fully visible window. Keep the image under the ignored `data/windows-capture` folder and never use this helper for keyboard or pointer input.
3. Refuse formal topic assignment until every currently online phone has a stable alias and an explicit group, and the requested group is non-empty. Both the PowerShell wrapper and Node entry must inventory ADB independently. Never substitute sorted serials for business device numbers.
4. Accept only tasks with `mode=research_read_only` and `interactionPolicy=human_final`. Reject any field or value requesting likes, favorites, follows, comment sending, messages, publishing, deletion, or payment.
5. Run `scripts/Run-TopicResearch.ps1 -TaskPath <task.json>`. Let Hermes only drop task files; keep validation, allocation, budgets, idempotency, and failure handling inside the research runner.
6. Resolve every phone independently through its fresh UI hierarchy. Prefer resource ID, then text/content description, then stable node relations. Use a device override only for its calibrated alias, resolution, DPI, and exact Xiaohongshu version.
   Never use generic group `TapText` or a full-screen `Swipe` for research. Scroll only a semantic list or image-note content container; never swipe a video canvas.
7. Require two matching normalized UI fingerprints 500 ms apart within 8 seconds before acting. Verify the target state afterward; never replay an uncertain click.
8. Use ASCII ADB input only for ASCII. Probe Unicode input per device; a failed alias must not block an approved peer. Use Unicode input only on explicitly approved, calibrated aliases, then verify exact search-box echo. Otherwise return `human_required` for Xiaowei desktop paste. After human handling or adapter approval, continue with a new taskId so the original result remains idempotent.
9. Keep AI event-driven: topic planning once per uncached topic, page recovery at most twice after local failure, and result analysis once after at least five candidates. Expand bounded queries from platform suggestions and read-only trending terms. Enforce the task's total automatic-call cap of four.
10. For page recovery, run both Windows local-OCR privacy checks against the same screenshot file and require a SHA-256 attestation tying that exact file to the upload. A boolean safety flag alone is never sufficient. Block login, challenge, permission, order, account-privacy, payment, message, and contact screens. Require confidence at least 0.90, no coordinates, and re-resolution of the semantic target in a new UI dump; otherwise stop for a human.
11. Stop a device after two consecutive transitions fail and retain its current screenshot and hierarchy paths. Trigger the global fuse when two devices produce the same failure signature. Stop all devices on login, CAPTCHA, risk, payment, private-message, contact, or permission screens.
12. Report only device aliases and result artifact paths. Treat local JSON/JSONL as the source of truth; run `scripts/sync-research-review.mjs` only for an already approved Feishu table. The sync must pull unambiguous human review decisions into the local queue before mirroring rows back.

## Human-final handoff

Require the operator to show only one phone in Xiaowei and confirm group synchronization is off. Then use `scripts/Open-ReviewCandidate.ps1` with one candidate ID, one mapped device alias, and `-ConfirmSingleDeviceAndSyncOff` to navigate and pause. Treat an absent, ambiguous, or identity-mismatched candidate as `human_required`; never open a generic first result. Generate a comment draft only after an explicit human request; never fill or send it.

## Hard boundaries

- Never automate likes, favorites, follows, comments, replies, messages, shares, publishing, deletion, login verification, or payments.
- Never bypass CAPTCHAs, risk controls, platform limits, identity checks, membership restrictions, or system permission prompts.
- Never implement random dwell time, simulated-human behavior, automated account warming, or device/network identity manipulation.
- Never share coordinates across phones or upload sensitive screens to a model.
- Never commit `.env`, `config/local.psd1`, `data/`, screenshots, UI XML, tokens, or real device/account identifiers.
