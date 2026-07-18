# P0 capability repair handoff

- Actor: Codex
- Date: 2026-07-16
- Device reservation: none; no phone was mutated
- Shared service impact: the primary gateway and its port were observed read-only and left running; no restart or replacement was performed

## Implemented

1. `device.input`
   - Added named HTTP, unified CLI, PowerShell adapter, and Xiaowei runtime routes.
   - Requires one focused `EditText` in the expected foreground package.
   - Uses the selected machine's approved text-input profile.
   - Clears once, sends text once, verifies exact UI or local-OCR echo, and restores the prior IME and temporary enablement state.

2. No-text icon resolution
   - Kept the existing closed `text`, `contentDesc`, `className`, `resourceId`, `clickable`, and `nearText` fields.
   - Added `screenRegion` plus `regionOrdinal` for no-text icons without caller coordinates or cloud vision.
   - Added regression coverage for a top-right icon and a bottom navigation control exposed only by content description.

3. Gateway lifecycle
   - The manager now recovers a healthy gateway process from the unique loopback listener when the PID file is absent or stale.
   - Added `xhs.cmd remote restart`, port-release waiting, and administrator delegation when termination is denied.
   - A read-only status check successfully recognized the currently running healthy gateway despite the missing PID file.

## Validation

- Syntax check: passed
- Full test suite: 488 passed, 0 failed
- Focused P0 regression suite after the final restoration hardening: 87 passed, 0 failed
- Repository policy scan: passed with zero violations
- Incident ledger validation: 35 valid incidents

## Incident transitions

The following incidents are `resolved` by code and named regression tests, but are not `verified` because this task performed no phone mutation and did not reload the shared gateway:

- `search-input-command-not-implemented`
- `local-icon-node-missing`
- `copy-post-link-from-share-panel`
- `bottom-nav-message-no-text-target`
- `local-gateway-old-process-unkillable`

## Hermes acceptance checklist

1. Coordinate a maintenance window, then run `xhs.cmd remote restart`.
2. Confirm `device.list` and `/health` remain healthy.
3. On one explicitly reserved suitable machine, focus a search editor and call `device.input`; verify exact echo and complete one search.
4. Resolve the message navigation control with its fresh exact `contentDesc`, activate once, and verify the message-center postcondition.
5. Inspect the current note-detail hierarchy, derive the fresh top-right icon ordinal, resolve and activate the share icon, then use exact text to select copy-link.
6. Promote each incident to `verified` only after fresh named-HTTP acceptance evidence.

## Remaining open capability gaps

- Topic tags embedded inside one `TextView` still need span/OCR sub-text targeting.
- Vision latency or timeout behavior still needs current-environment diagnosis.
- Sharing to an external app still requires a suitable installed and signed-in target app on the reserved machine.

## Resource release

- No device reservation remains.
- No temporary gateway or port remains.
- The existing primary gateway is still running the pre-restart in-memory code.
