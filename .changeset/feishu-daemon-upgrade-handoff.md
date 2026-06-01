---
"claude-channel-feishu": patch
---

Fix the feishu-channel daemon handoff across plugin reloads by advertising the real plugin version, evicting older daemons, and reconnecting proxies after daemon restarts.
