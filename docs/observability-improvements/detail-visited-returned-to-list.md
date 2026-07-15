# 可观测性改进项

## 背景
2026-07-14 单机验收任务 `hermes-single-device-smoke-20260714-02` 中，完整只读链路（搜索 → 识别 → 进入详情 → 返回列表）已通过 checkpoint 中的派生字段确认成功闭合，但判断依据依赖以下间接证据：

- `commentMetadata` 字段存在（由详情采样逻辑生成）
- 最终 `pageState=SEARCH_RESULTS`
- `failureSignature=null` 且 `humanReview=[]`
- `maxNoteScrolls=1` 已触发

## 建议
在正式结果中增加显式布尔字段，避免依赖派生字段推断：

```json
{
  "detailVisited": true,
  "returnedToList": true,
  "detailPageState": "IMAGE_NOTE",
  "listPageState": "SEARCH_RESULTS"
}
```

## 收益
- 降低验收时的人工判断成本
- 避免 `noteId=null` 或 `commentMetadata.panelOpened=false` 被误解为未进入详情
- 为 future 的自动化验收报告提供明确信号

## 优先级
非阻塞（P2）。当前链路已验收通过，本改进仅作为可读性增强。
