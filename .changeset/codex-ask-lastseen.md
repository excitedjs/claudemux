---
"@excitedjs/tm": patch
---

修 `tm ask` 污染 codex teammate 的 `last-seen` 水位线、导致 `tm wait` 漏回收主线程 turn:`tm ask` 在 ephemeral 线程上跑完后不再 `touchLastSeen`。此前若一个 `tm send --timeout` 超时(主 turn 仍在 daemon 上跑)、随后一个 `tm ask` 借到同一 teammate 并在主 turn 完成后写了更新的全局 `last-seen`,`tm wait` 的 backfill 会把那条主 turn 当成「已收过」跳过(`completedAt <= last-seen`),而 live 订阅又只收未来事件,于是主 turn 永远收不回来 —— 破坏「`tm send` 超时返回 124 后用 `tm wait` 回收结果」的契约。`last-seen` 现在只由主线程的收集(`tm send` / `tm wait`)推进。
