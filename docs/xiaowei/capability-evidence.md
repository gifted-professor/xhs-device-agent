# Xiaowei capability evidence ledger

This ledger separates observed facts from implementation claims. The machine-readable source is `capability-inventory.json`.

## Evidence classes

- `live response`: current Xiaowei 9.10.113 returned a structured result.
- `existing adapter`: tracked project code already sends the action.
- `documented candidate`: the action name appeared in prior Xiaowei API documentation notes and still requires a 9.10.113 probe.
- `UI observed`: the operation is present in the current Xiaowei menu, but the protocol action/schema is not yet known.
- `official feature`: Xiaowei's official product page names the function without publishing a machine-readable schema.

## Current counts

The initial inventory contains 49 canonical capabilities. It intentionally includes unknown actions so the absence of a wrapper is visible rather than silently omitted.

## Live/runtime evidence

| Evidence | Result | Interpretation |
|---|---|---|
| Xiaowei executable version | `9.10.113` | Version pin for all current claims |
| Local WebSocket listener | `127.0.0.1:22222` listening | Transport available in the interactive Windows session |
| Vendor device list | 4 devices | Xiaowei inventory is live |
| Bundled ADB list | 0 devices at the same observation | Do not use bundled ADB membership as proof of Xiaowei membership |
| Dashboard manifest | 31 XHS primitives, 11 HTTP endpoints | Business API exists but is not a full device API |
| `apkList` on alias `01` | code `10000`, one device key, 55 entries | Current-version read-only action and response container are verified |
| `imeList` on alias `01` | code `10000`, one device key, 6 entries | Current-version read-only action and response container are verified |
| `actionTask.list` / `autojsTask.list` | code `10001`, invalid action | Binary strings are internal clues, not current OpenAPI action names |

Real serials and raw inventory payloads are deliberately excluded from Git.

## Existing tracked action evidence

| Vendor action | Current tracked caller | Initial claim |
|---|---|---|
| `list` | `scripts/greenarrow-api.mjs` | Existing adapter |
| `pushEvent` | `scripts/greenarrow-api.mjs` | Home/Back existing adapter |
| `pointerEvent` | `scripts/greenarrow-api.mjs` | tap/swipe existing adapter |
| `Screen` | `scripts/greenarrow-api.mjs` | screenshot existing adapter |
| `startApk` | `scripts/greenarrow-api.mjs` | app start existing adapter |
| `adb_shell` | `scripts/greenarrow-api.mjs` | arbitrary shell existing adapter |
| `selectIme` | `scripts/fast-operator.mjs` | schema requires extraction/live confirmation |
| `inputText` | `scripts/fast-operator.mjs` | schema requires extraction/live confirmation |

## Documentary action candidates

`adb`, `writeClipboard`, `uploadFile`, `pullFile`, `apkList`, `installApk`, `uninstallApk`, `stopApk`, and `imeList` are discovery seeds. They are not promoted beyond D1 until current-version probes prove request and response shapes.

The installed `xiaowei.exe` SHA-256 observed on 2026-07-22 is `2f9011172d8ec7d0176ab3cb602400cfc34217f1e529d0befc678150a8c73af7`. Static strings expose internal command families including app/file/clipboard/IME, mode switching, accessibility, HID, ROOT, action playback, and AutoJS execution. These names are evidence of product implementation surface, not automatically OpenAPI action names.

## UI-only gaps to resolve

- large-screen open/close;
- device number/name/tag mutation;
- import/export semantics and clipboard export direction;
- phrase list/use;
- action record/list/run/stop;
- task list/run/stop/result;
- wallpaper generation;
- WIFI, ROOT, accessibility, USB, HID, and OTG mode transitions;
- screen off/on and resolution controls.

## Primary links

- <https://www.xiaowei.xin/help/71>
- <https://www.xiaowei.xin/docs/55.html>

## Promotion rule

An inventory row moves from D0/D1 only when evidence records the exact Xiaowei version, sourced action name, request shape, raw vendor status, normalized result, visible/device postcondition, and restoration outcome where applicable.
