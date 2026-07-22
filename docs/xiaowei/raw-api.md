# Xiaowei raw Agent API

The raw API is the first full-control surface. It intentionally does not use an action allowlist and does not require an action to exist in `capability-inventory.json`.

## Start

```powershell
npm.cmd run device-api
```

Defaults:

- bind: `127.0.0.1:17910`;
- Xiaowei transport: `ws://127.0.0.1:22222/`;
- selected canary alias: `01`, freshly resolved from the unique visible device with `sort=1` before every raw call.

Override the HTTP bind when a supervisor process or the existing dashboard is ready to expose it:

```powershell
$env:XIAOWEI_DEVICE_API_HOST = "0.0.0.0"
$env:XIAOWEI_DEVICE_API_PORT = "17910"
npm.cmd run device-api
```

## Discover the API

```http
GET /device/v1/manifest
```

The response explicitly reports:

```json
{
  "raw": {
    "method": "POST",
    "path": "/device/v1/raw",
    "allowAnyAction": true,
    "actionAllowlist": null,
    "data": "any JSON value",
    "canaryDeviceAlias": "01"
  }
}
```

The same API is also mounted by the existing dashboard on port `17900`. The `/device/v1/*` routes are independent of the dashboard's older `/agent/takeover` protocol.

## Agent endpoints

- `GET /device/v1/devices` returns aliases and non-sensitive device metadata only.
- `POST /device/v1/invoke` calls a typed capability with `{deviceAlias, capability, params}`.
- `POST /device/v1/raw` passes any action and JSON payload through unchanged.
- `POST /device/v1/operations` executes a typed or raw request with an idempotency key.
- `GET /device/v1/operations/:id` reads operation state.

Neither typed calls nor raw calls require an agent takeover or lab session. A lab-session object remains available to internal callers as optional metadata, but is not an API gate.

## Invoke any Xiaowei action

```http
POST /device/v1/raw
content-type: application/json

{
  "deviceAlias": "01",
  "action": "vendorActionName",
  "data": {
    "anyVendorField": "preserved"
  },
  "timeoutMs": 12000
}
```

The service performs a fresh Xiaowei `list`, resolves `01`, adds the runtime device identifier internally, sends the action unchanged, and returns the untouched parsed vendor response:

```json
{
  "ok": true,
  "deviceAlias": "01",
  "action": "vendorActionName",
  "vendorResponse": {
    "code": 10000,
    "message": "SUCCESS",
    "data": {}
  }
}
```

## What is deliberately not restricted

- action name;
- action membership in the capability inventory;
- vendor-specific fields under `data`;
- action maturity or test-order classification.

The only current constraints are transport requirements: a non-empty action string, a uniquely resolved canary alias, valid JSON, one serialized Xiaowei WebSocket request at a time, a finite timeout, and a 1 MiB HTTP envelope limit.

## Windows CLI

`xhs.cmd` exposes the same surface for an Agent running on the Xiaowei host:

```powershell
xhs.cmd device list
xhs.cmd device capabilities --json
xhs.cmd device discover --device 01 --read-only
xhs.cmd device invoke --device 01 --capability input.key.home --params "{}"
xhs.cmd device raw --device 01 --action vendorActionName --data "{}"
```

The public CLI accepts device alias `01`, not a runtime device serial.

Current live-effect results and unresolved vendor schemas are tracked in [`CERTIFICATION.md`](CERTIFICATION.md). Windows runtime handoff instructions are in [`HANDOFF.md`](HANDOFF.md).
