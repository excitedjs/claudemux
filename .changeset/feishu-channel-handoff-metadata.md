---
"claude-channel-feishu": minor
---

Channel proxies now self-report a neutral `metadata` bag at registration, surfaced in `feishu_channel_status().sessions[]`, so a coordinator can locate a session by a readable key (a claudemux teammate reports `metadata.teammate_name` and `metadata.cwd`) instead of reverse-engineering it from `pid`. `feishu_channel_acquire` and `feishu_channel_grant` accept a `match` selector that targets a proxy by its metadata, with clear errors on no match or an ambiguous match. The core schema stays orchestrator-neutral; a feishu-only install carries an empty-or-cwd-only bag. Backward compatible: older proxies omit the field and the selector simply finds nothing for them.
