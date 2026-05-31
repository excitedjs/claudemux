---
'claude-channel-feishu': patch
---

Single-instance daemon lock now rests on proper-lockfile (atomic mkdir steal +
background mtime refresh) instead of a hand-rolled writeFileSync/pid-death/unlink
reclaim, closing the stale-reclaim race where two concurrent starters could both
pass the judge-dead → unlink → recreate window. Adds a re-probe-after-acquire
guard so a lapsed-but-still-serving holder is detected and the new starter stands
down, with the unix-socket bind kept as a backstop arbiter.
