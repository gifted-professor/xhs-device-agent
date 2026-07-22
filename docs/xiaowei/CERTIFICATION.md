# Xiaowei device-control certification

Date: 2026-07-22  
Host: `DESKTOP-3I1EVHE`  
Product version: `9.10.113`  
Live canary: device alias `01`

This document separates API exposure from effect certification. The unrestricted raw route accepts any non-empty Xiaowei action and arbitrary JSON even when the capability is not listed below. A missing certification label is not an action block.

## Certified live on alias 01

| Surface | Result | Postcondition |
|---|---|---|
| WebSocket transport | verified | interactive-session listener on `127.0.0.1:22222` |
| Device inventory | verified | four online aliases returned; public API omitted runtime serials |
| Capability manifest | verified | 52 catalog rows, 20 typed wrappers, unrestricted raw route |
| App, IME, tag, action, AutoJS and clipboard reads | verified | all returned HTTP 200; clipboard content was not recorded |
| Home / Back | verified | Xiaowei success through typed API |
| Start / stop app | verified | Android Settings used as the reversible target |
| Swipe up / down | verified | typed pointer operations returned success |
| Tap | verified after correction | Xiaowei 9.10.113 requires percentage values as strings on the vendor wire |
| Screenshot | verified after correction | delayed image creation detected; non-zero bytes and SHA-256 verified; probe deleted |
| Select IME | verified without state change | current IME selected again and reread unchanged |
| Raw `adb_shell` | verified | unique echo marker returned |
| Resolution read | verified | `wm size` output returned |
| Screen sleep / wake | verified | `dumpsys power` changed to Asleep and back to Awake |
| Operation idempotency / lookup | verified | repeated key returned the same operation ID; GET lookup matched |
| Tag lifecycle | independently verified | add/list/attach/detach/remove all succeeded |
| Legacy Greenarrow CLI | verified | live `list` returned vendor success and four devices |

## Callable but not effect-certified

| Capability | Current truth |
|---|---|
| `file.push` | route exists; both full-target and directory-plus-file-name payload candidates returned HTTP 502; schema remains unresolved |
| `file.pull` | candidate request returned `executed`, but no file was produced when the source was absent; it is not certified until an independently verified source can be pulled and hashed |
| `writeClipboard` | route accepts some object payloads, but none changed `getClipboard` readback; original clipboard was preserved |
| `actionCreate`, `autojsCreate`, `execAutojs` | routes exist; current candidate payloads returned HTTP 502; accepted schemas remain unresolved |
| APK install / uninstall | typed and raw paths exist; no disposable APK artifact was used in this certification run |
| Text input | tracked working adapter evidence exists, but this run did not create a disposable focused field for independent readback |
| Resolution change | raw shell path is available; only non-mutating resolution read was certified in this run |

## UI/internal capabilities without a confirmed public action schema

Large-screen open/close, device number/name changes, phrase management, wallpaper generation, action recording UI, WIFI/ROOT/accessibility/USB/HID/OTG transitions, and some import/export semantics remain cataloged. Their installed implementation paths or UI labels are evidence that the product has the feature, not proof of a current WebSocket action schema.

Disconnecting mode transitions remain reachable through raw actions or installed UI commands where known. They were not live-switched because the SSH session cannot operate the interactive Xiaowei GUI if the control path disconnects; this is a recovery limitation, not an API allowlist.

## Restored state

- Android Settings was stopped and Home was issued.
- Screen was returned to Awake and Home.
- Screenshot and host temporary directories were deleted.
- Candidate phone file paths were checked and removed.
- The current IME remained unchanged.
- No XHS like, follow, comment, message, publish, delete, login, or payment action was performed.
