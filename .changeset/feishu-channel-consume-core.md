---
"claude-channel-feishu": patch
---

Consume `@excitedjs/feishu-transport@0.0.2` for all engine-agnostic Feishu platform I/O (the 长链/分发/解析/编码 boundary), deleting the in-tree duplicates (`content`/`render`/`pairing`/`json`/`types`). Also migrates the #17 bot-discovery parse onto the shared core: `bot-member` now consumes core's `normalizeBotMemberAddedEvent` + `BOT_MEMBER_ADDED_EVENT_TYPE`, and `im-message` uses core's `mentionName` instead of an inline lookup. Host policy/stores/UX (observe/baseline/delta, identity-store, chat-bots-store, gate) stay in claudemux. No behavior change; resolves the #13↔#17 conflict on current main.
