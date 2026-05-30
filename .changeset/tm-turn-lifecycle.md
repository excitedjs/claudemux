---
"@excitedjs/tm": minor
---

`tm send` turn-lifecycle robustness, both anchored to a transcript byte offset snapshotted at send time so they only ever read what the current turn appends.

- **Submit confirmation.** After injecting a prompt + Enter, `tm send` confirms the REPL accepted it as a turn — the on-busy/idle marker appeared, or a new user entry landed in the transcript jsonl — and re-sends Enter up to 3 times if not. An Enter swallowed by a modal now surfaces a stderr warning instead of a silent wait-to-124. It is warn-and-proceed: a slow-but-live send is never converted into a hard failure (the wait still expires to 124 if the turn truly never runs). Tunable via `CLAUDEMUX_CONFIRM_SUBMIT_MS` (0 disables).
- **No-hook wait fallback.** The default wait now unblocks on the Stop-hook idle marker OR a settled assistant entry in the transcript jsonl (terminal `stop_reason` plus a `text`/`tool_use` block — the same predicate `on-stop.sh` uses). A teammate whose Stop hook never loaded ends its wait on disk evidence rather than burning the full timeout to a 124. On that no-hook path `tm send` recovers the reply from the turn's appended region (scoped to the send offset) and writes it back to `<sid>.last` the same way `tm spawn --resume` seeds it, so stdout and a later `tm last` / `tm states` all surface the reply instead of the "(no text reply…)" sentinel — a textless tool-only turn clears `.last` to empty. Offset-anchored throughout, so a prior turn's settled entry (or a stale `.last`) is never mistaken for this turn's completion.
