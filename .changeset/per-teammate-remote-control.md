---
"@excitedjs/tm": minor
---

per-teammate Remote Control for `tm spawn`

Add a per-teammate way to enable Claude Remote Control (claude.ai/code web +
mobile), independent of the user-global `remoteControlAtStartup` — so RC can be
scoped to claudemux teammates while the dispatcher and any unrelated `claude`
sessions stay off.

- `tm spawn --remote-control` injects `claude --remote-control` into that one
  teammate's launch flags; `--no-remote-control` forces it off.
- `CLAUDEMUX_REMOTE_CONTROL` (truthy: `1` / `true` / `yes` / `on`), read once
  per invocation, is the dispatcher-set default for every `tm spawn`. Set it in
  the dispatcher's `.claude/settings.json` env block.
- Precedence: explicit `--remote-control` / `--no-remote-control` > config > off.
- Claude-only: an explicit `--remote-control` is rejected for `--engine codex`;
  the config default is silently inert on that path.

The dispatcher skill now passes `--remote-control` when the user asks for RC in
natural language, and `tm spawn --help` documents the flag and config.
