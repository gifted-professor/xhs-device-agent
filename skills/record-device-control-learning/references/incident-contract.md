# Incident contract

## Storage boundaries

- `config/device-control-playbook.json` is the stable runtime taxonomy and strategy catalog.
- `config/device-control-incidents.json` is the deduplicated lifecycle ledger.
- `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` explains the current general method.
- A session may update one, two, or all three. Never add history to the runtime taxonomy merely to preserve a conversation.

## Lifecycle

| State | Meaning | Minimum evidence |
| --- | --- | --- |
| `open` | The reusable blocker exists and has no bounded resolution. | Report or inspected artifact |
| `mitigated` | A bounded workaround exists, but the root condition or compatibility debt remains. | Workaround plus inspected artifact or live result |
| `resolved` | A general fix addresses a confirmed root cause. | Artifacts plus named regression tests |
| `verified` | The resolved fix also worked through the current named HTTP boundary. | Artifacts, tests, and fresh live acceptance |
| `reopened` | A prior mitigation or fix recurred in a new session. | New observation with a new session ID |

`evidenceLevel` is computed by the merge script: `reported`, `inspected`, `tests_passed`, or `live_verified`.

## Candidate shape

```json
{
  "sessionId": "2026-07-16-device-control-close",
  "sessionDate": "2026-07-16",
  "incidents": [
    {
      "fingerprint": "stable-kebab-case-fingerprint",
      "title": "Short reusable title",
      "scope": "navigation",
      "category": "perception",
      "failureCode": "OCR_MISS",
      "state": "resolved",
      "observation": "What failed, without device identity or private content.",
      "rootCause": {
        "status": "confirmed",
        "summary": "The verified general cause."
      },
      "resolution": {
        "kind": "general_fix",
        "strategyId": "OCR_SCALED_EXACT_NODE",
        "summary": "The reusable fix."
      },
      "evidence": {
        "artifacts": [
          { "path": "scripts/example.mjs", "claim": "Implements the bounded fix." }
        ],
        "tests": [
          { "path": "tests/example.test.mjs", "name": "rejects ambiguous targets" }
        ],
        "liveAcceptance": [
          { "command": "device.node.resolve", "outcome": "HTTP 200 with one unique redacted node." }
        ]
      }
    }
  ]
}
```

Use `failureCode: null` when the incident is a contract, documentation, or compatibility problem that does not correspond to one runtime failure class. Use `strategyId: null` when no catalog strategy owns the resolution.

## Classification examples

- A new API bypasses a still-failing input channel: keep the input incident `open`; optionally record the unrelated API fix separately.
- A generic node API works while an App-specific compatibility branch remains: mark the fragmentation incident `mitigated`, not fully resolved.
- Exact-key validation rejects coordinates and identifiers and named regression tests pass: mark the injection incident `resolved`.
- The same failure returns after a prior live acceptance: merge the same fingerprint as `reopened`; do not mint a second incident.

## Forbidden content

Never store absolute paths, runtime-data paths, local configuration paths, credentials, raw device identifiers, internal aliases, coordinates, screenshot/UI artifact paths, private message/contact/payment content, or raw OCR output. Use repository-relative source and test paths only.
