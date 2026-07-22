# Xiaowei full-control Agent handoff

## Runtime handles

- Windows host: `DESKTOP-3I1EVHE`
- Windows checkout: `C:\Users\windows 10\Desktop\coding\control_Test\xhs-device-agent-xiaowei-api`
- Branch: `feat/xiaowei-full-device-api`
- Xiaowei WebSocket: `ws://127.0.0.1:22222/`
- Standalone HTTP API: `127.0.0.1:17910`
- Dashboard mount: `/device/v1/*` on dashboard port `17900` when that process is running
- Live canary alias: `01`

The Xiaowei GUI must already be running in the interactive Windows desktop session. Starting the executable from a non-interactive SSH/session-0 process is not proof that port `22222` is usable.

## Start and inspect

```powershell
npm.cmd run device-api
xhs.cmd doctor
xhs.cmd device list
xhs.cmd device capabilities --json
xhs.cmd device discover --device 01 --read-only
```

## Typed and unrestricted raw calls

```powershell
xhs.cmd device invoke --device 01 --capability input.key.home --params "{}"
xhs.cmd device raw --device 01 --action anyVendorAction --data "{}"
```

HTTP equivalents are documented in `docs/xiaowei/raw-api.md`. Neither surface requires dashboard takeover or a lab session. Raw action names and `data` fields are not allowlisted.

## Important protocol facts

- Resolve alias `01` from a fresh Xiaowei `list`; never persist or expose the runtime serial.
- All access to port `22222` is serialized by the shared cross-process lock.
- Vendor pointer percentages must be strings on the wire. The typed API accepts numeric coordinates and performs this conversion.
- `Screen` returns before the image necessarily appears. Typed screenshot verification polls for a new stable file and hashes it.
- Vendor success/`executed` alone does not prove file transfer, clipboard write, install, or automation creation effects.
- The legacy `scripts/greenarrow-api.mjs` entrypoint remains compatible, but new Agents should use `xhs.cmd` or `/device/v1/*`.

## Current unresolved work

1. Recover the accepted `uploadFile`/`pullFile` payload schema from the installed frontend or a vendor example, then rerun a hash-verified round trip.
2. Resolve payload schemas for `actionCreate`, `autojsCreate`, `execAutojs`, and `writeClipboard` without treating route acceptance as effect success.
3. Map UI-only mode/metadata/phrase/action-recording functions to current WebSocket actions.
4. Establish an interactive-GUI recovery controller before certifying connection-mode switches.

See `CERTIFICATION.md` for the exact live/pass/unresolved matrix and `capability-inventory.json` for the machine-readable catalog.
