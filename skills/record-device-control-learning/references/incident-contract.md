# Incident contract

> **编辑必读**：本文件是事件记录的契约规范。新增字段、修改字段语义或调整状态定义前，必须在此文档中说明。禁止在 `config/device-control-incidents.json` 中写入未在本文档中定义的字段，除非同步更新本文件和校验脚本 `record-learning.mjs`。

## 字段扩展与变更规则

1. **新增字段必须说明**：新增字段必须在此文档中说明语义、取值类型和范围，并同步更新 `record-learning.mjs` 校验逻辑。
2. **不删除已有字段**：只能标记为 `deprecated` 后保留，不能删除，防止历史记录断裂。
3. **不修改已有字段语义**：修改字段语义属于破坏性变更，必须新建字段替代。
4. **执行者字段（建议）**：建议在每个 incident 中记录执行者信息，以便区分人工、Agent、Codex、Claude Code 等角色：
   - `discoveredBy`: 谁发现 / 首次验证（如 `hermes-agent`）
   - `fixedBy`: 谁修复（如 `codex`、`claude-code`、人工账号）
   - `verifiedBy`: 谁最终验证（如 `hermes-agent`）
5. **执行者取值约定**：使用短标识，如 `hermes-agent`、`codex`、`claude-code`、具体人工账号名。避免使用模糊词如“我”、“他”。
6. **历史记录保护**：修改已有 incident 时，只能在末尾追加更新说明，不能删除或覆盖原始发现。

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
