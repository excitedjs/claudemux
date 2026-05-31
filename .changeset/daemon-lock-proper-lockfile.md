---
'claude-channel-feishu': patch
---

Single-instance daemon lock now rests on proper-lockfile (atomic mkdir steal +
background mtime refresh) instead of a hand-rolled writeFileSync/pid-death/unlink
reclaim, closing the stale-reclaim race where two concurrent starters could both
pass the judge-dead → unlink → recreate window. Adds a re-probe-after-acquire
guard so a lapsed-but-still-serving holder is detected and the new starter stands
down, with the unix-socket bind kept as a backstop arbiter.

The plugin entrypoint now starts as a thin MCP stdio proxy and lazily spawns the
standing daemon when the daemon socket is absent. The daemon owns the sole Feishu
WebSocket and opens the transport without the legacy per-session instance lock,
so ordinary Claude sessions no longer contend for the channel connection.

Adds the handoff skill documenting how Dispatcher and teammate sessions inspect,
grant, acquire, return, and reclaim explicit Feishu channel delivery ownership.
