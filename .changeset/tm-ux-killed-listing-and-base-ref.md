---
"@excitedjs/tm": minor
---

`tm` usability and teammate-launch hardening.

- `tm ls --all` / `tm states --all` now also list killed teammates (STATE `killed`) from the kill-time identity archive, so a killed session is discoverable and resumable by name without hand-scraping `/tmp`.
- `tm spawn` prints a `base:` line on a fresh launch — the repo HEAD branch + short sha the worktree branches from, plus a best-effort ahead/behind against the remote default branch — so a repo parked on a non-trunk branch is obvious instead of a silent wrong baseline (best-effort and read-only; a non-git repo or any failing git probe drops the line and never fails the spawn).
- Teammates suppress Claude Code's "Resume from summary vs full session" startup prompt by launching with `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` set far above any real context window. A headless teammate cannot answer that modal, and the next `tm send`'s Enter would pick the default summary option (running `/compact`) and discard the context a resume restores. The `tm resume` help and dispatcher guide keep the "confirm with `tm status`" note as a fallback for builds that ignore the knob.
- Teammates launch with `EnterPlanMode` / `ExitPlanMode` joining `AskUserQuestion` on the disabled-tools list — each opens a modal that holds a turn open waiting for a human a teammate does not have.
