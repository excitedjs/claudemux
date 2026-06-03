---
"claude-channel-feishu": minor
---

Add `feishu_channel_doctor`, a one-shot runtime diagnosis of the Feishu channel's known foot-guns — daemon/proxy version skew, a stale server holding the inbound lock, multiple daemons contending for the socket, channel ownership stolen by a teammate, and the broker handoff gap. It ships as a read-only, spawn-free MCP tool handled locally in the proxy (so it can diagnose a stale or unreachable daemon instead of forwarding to the subject) and as a `npm run doctor` CLI entry that registers no proxy and is the authoritative path for the daemon-unreachable / stale-socket cases. `feishu_channel_status` now also carries an authoritative `daemon` identity block (version, pid, generation, started_at, launch_path), and the proxy reports `metadata.transport` when the launcher injects `CLAUDEMUX_CHANNEL_TRANSPORT`.
