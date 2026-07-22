# Xiaowei capability API baseline

Date: 2026-07-22

## Runtime

- Windows host identity: `DESKTOP-3I1EVHE`.
- Xiaowei Android Casting file/product version: `9.10.113`.
- Local Xiaowei WebSocket: `ws://127.0.0.1:22222/`.
- Observed vendor success code: `10000` with message `SUCCESS`.
- Device canary: public alias `01`, resolved at runtime from the unique online Xiaowei device with `sort=1`.
- Real device serials are runtime-only and must not be committed.
- Xiaowei device inventory and the bundled ADB inventory are independent. At baseline, Xiaowei listed four devices while its bundled `adb devices` output was empty.

## Repository truth

- Remote: `https://github.com/gifted-professor/xhs-device-agent.git`.
- Authoritative `origin/main`: `5b508658068cc1544386ae84c40b603e532361d7`.
- Windows running checkout `main` and GitHub `origin/main` matched at the baseline.
- Development branch: `feat/xiaowei-full-device-api`.
- Development is isolated from the dirty GPFS reference checkout and from the Windows running checkout.
- The GPFS reference checkout had remained at initial commit `72a7e04967e7fb6c6e418540c55dd5e9284b0e9a` before its remote refs were refreshed. Its user-modified `AGENTS.md` and skill files were not changed.

## Existing adapter surface

Tracked `scripts/greenarrow-api.mjs` currently provides these command paths:

| CLI command | Vendor action |
|---|---|
| `list` | `list` |
| `home` | `pushEvent` type `2` |
| `back` | `pushEvent` type `3` |
| `start-xhs` | `startApk` |
| `tap` | `pointerEvent` down/up |
| `swipe-up` | `pointerEvent` type `6` |
| `swipe-down` | `pointerEvent` type `7` |
| `screenshot` | `Screen` |
| `shell` | `adb_shell` |

As of Task 12, this compatibility CLI is implemented through the shared `XiaoweiTransport` and `XiaoweiClient`. Its command names, `LVJIAN_DEVICE` input, vendor request bodies, successful JSON output, vendor-error output, and legacy connection/timeout messages are covered by compatibility tests. New Agent integrations should use `xhs.cmd` or `/device/v1/*`; the legacy entrypoint remains supported.

Additional action names already present in prior API documentation or project evidence, but not yet treated as live-verified typed APIs:

`adb`, `writeClipboard`, `uploadFile`, `pullFile`, `apkList`, `installApk`, `uninstallApk`, `stopApk`, `imeList`, `selectIme`, and `inputText`.

## Existing Agent surface

- Dashboard HTTP port: `17900`; Tailscale HTTPS surface: `17901`.
- Four per-device fast-operator serve ports: `17895` through `17898`.
- Current `/agent/manifest` exposes 31 Xiaohongshu business primitives.
- Current manifest lists 11 HTTP endpoints covering status, tasks, XHS primitives, and Agent takeover/heartbeat/release.
- It does not expose the full Xiaowei device-control surface.

## Primary product evidence

- Official help center: <https://www.xiaowei.xin/help/71>
- Official product feature description: <https://www.xiaowei.xin/docs/55.html>
- The official feature description names batch file transfer, APK install/uninstall, text distribution, quick replies, action recording, task management, device grouping, USB, and WIFI capabilities.

## Baseline constraints for implementation

- Keep existing `/primitive`, dashboard task routes, watcher, and 31 XHS primitives unchanged.
- Add a separate Xiaowei device layer under `/device/v1/*`.
- Keep optional lab metadata separate from production XHS workflow rules; it is not a required gate for the full-control raw or typed APIs.
- Use `01` as the only live canary until every single-device capability is classified and recoverable.
