# claudemux

## 2.4.1

### Patch Changes

- f54c72e: 修 `tm ask` 污染 codex teammate 的 `last-seen` 水位线、导致 `tm wait` 漏回收主线程 turn:`tm ask` 在 ephemeral 线程上跑完后不再 `touchLastSeen`。此前若一个 `tm send --timeout` 超时(主 turn 仍在 daemon 上跑)、随后一个 `tm ask` 借到同一 teammate 并在主 turn 完成后写了更新的全局 `last-seen`,`tm wait` 的 backfill 会把那条主 turn 当成「已收过」跳过(`completedAt <= last-seen`),而 live 订阅又只收未来事件,于是主 turn 永远收不回来 —— 破坏「`tm send` 超时返回 124 后用 `tm wait` 回收结果」的契约。`last-seen` 现在只由主线程的收集(`tm send` / `tm wait`)推进。

## 2.4.0

### Minor Changes

- 17a63b5: `tm send` to a busy codex teammate now supersedes the in-flight send instead of hard-failing with "busy", matching the Claude engine. A second `tm send` steers its prompt into the running turn and collects the merged result, while the earlier send exits early (exit 0) with the supersede note. Turns that cannot be steered (a `review`/`compact` turn, or a teammate whose lock is held by a `tm ask` ephemeral turn) fall back to a clear recoverable "busy".

## 2.3.1

### Patch Changes

- 8b0bafa: Harden the dispatcher SessionStart recall hook against PATH drift. The hook now resolves `tm` via `${CLAUDE_PLUGIN_ROOT}/bin/tm` first (the version-coherent path Claude Code re-resolves at every launch) and falls back to `tm` on PATH only when that is missing. Previously a PATH-only lookup let the hook silently inject nothing whenever a session started while the plugin's `bin/` had dropped off PATH — a drift seen after a plugin version change reloads plugins mid-session.

## 2.3.0

### Minor Changes

- cb0860e: Dispatcher sessions now auto-recall recent teammate work. A new SessionStart hook injects `tm history --since 3d --oneline` into the dispatcher's context on the startup, resume, and compact sources — so the recall refreshes after every compaction, not just on a cold start — restoring the "recent work loads itself into context" behavior the retired hand-written Markdown ledger used to provide via a `CLAUDE.md` `@import`. The hook is dispatcher-only (gated on `TM_DISPATCHER_DIR` set and `CLAUDEMUX_TEAMMATE_NAME` unset, so it never injects into a teammate session), ships in the plugin's `hooks.json` with no change to the dispatcher's `settings.json`, and degrades to a silent no-op on any failure.

  Supporting this, `tm history --since`/`--until` now accept relative durations (`30m`, `12h`, `3d`, `1w` — minutes/hours/days/weeks ago) in addition to absolute dates, so the hook passes `--since 3d` directly without any cross-platform date arithmetic.

## 2.2.1

### Patch Changes

- c1c3109: Make the `tm send` supersede note honest about merge timing. The note no longer promises that a superseded send's result "merges into the later send's turn" unconditionally; instead it says the prompt was delivered and queued, and points at `tm wait` / `tm last` to collect the result. A live repro showed the merge only happens when the steering send lands at a mid-task pause (e.g. the teammate is running a tool); on a pure-generation turn the queued prompt runs as a separate turn and the surviving send can even return empty. Wording and docs only — the supersede logic is unchanged.

## 2.2.0

### Minor Changes

- 5ae3a8a: `tm send` now auto-supersedes: when a newer `tm send` to the same teammate arrives while an earlier one is still waiting, the earlier send returns early (exit 0) with a note instead of hanging to its timeout, and only the latest send waits for the merged reply. This makes "guide the model with a second send" a supported pattern. A plain single send is unchanged, and there is no opt-out flag. Claude teammates only; `--pane-quiet` sends and Codex teammates do not participate.

## 2.1.2

### Patch Changes

- 2f2f7bf: Refactor `tm history` storage discovery into engine-owned source helpers and remove the unused engine history contract.

## 2.1.1

### Patch Changes

- 28a0352: Publish the npm CLI as compiled JavaScript so `npx @excitedjs/tm` runs from `node_modules` on Node 22.x without relying on runtime TypeScript type stripping.

## 2.1.0

### Minor Changes

- 2d70d9e: `tm spawn`: opt-in per-dispatcher prompt preamble. When `<dispatcherDir>/.tm-preamble.json` exists, a fresh `tm spawn --prompt` prepends the entry matching the resolved repo path (else a dispatcher-wide `default`) to the operator's prompt, so a standing first-turn reminder no longer has to be hand-pasted into every dispatch. Profile keys are matched after resolving symlinks. A missing file is a no-op, a malformed file fails the spawn loudly, and `--no-preamble` opts a single spawn out.

## 2.0.1

### Patch Changes

- 7b70486: Make Codex history intent previews skip Codex bootstrap AGENTS instructions and use the first real user prompt when no explicit `--intent` is provided.

## 2.0.0

### Major Changes

- bed10ba: Replace the manual dispatcher Markdown ledger with the `tm history` query surface: `tm history` is now flag-only JSON by default, lifecycle verbs record forward session and close metadata, `tm resume` can recover sessions by repo and id, `tm kill --status` records close status, and the removed `tm archive` and legacy `tm history <name>` contracts no longer operate.

## 1.4.0

### Minor Changes

- 81a5078: per-teammate Remote Control for `tm spawn`

  Add a per-teammate way to enable Claude Remote Control (claude.ai/code web +
  mobile), independent of the user-global `remoteControlAtStartup` — so RC can be
  scoped to claudemux teammates while the dispatcher and any unrelated `claude`
  sessions stay off.

  - `tm spawn --remote-control` injects `claude --remote-control` into that one
    teammate's launch flags; `--no-remote-control` keeps claudemux from
    injecting it (it cannot override a user-global `remoteControlAtStartup`,
    which `claude` still honors).
  - `CLAUDEMUX_REMOTE_CONTROL` (truthy: `1` / `true` / `yes` / `on`), read once
    per invocation, is the dispatcher-set default for every `tm spawn`. Set it in
    the dispatcher's `.claude/settings.json` env block.
  - Precedence: explicit `--remote-control` / `--no-remote-control` > config > off.
  - Claude-only: an explicit `--remote-control` is rejected for `--engine codex`;
    the config default is silently inert on that path.

  The dispatcher skill now passes `--remote-control` when the user asks for RC in
  natural language, and `tm spawn --help` documents the flag and config.

## 1.3.2

### Patch Changes

- 45b8192: Mark the release bot's version-bump commit with `[skip ci]` so it no longer starts a redundant second round of CI, secret scanning, and the release workflow. The bump commit is pushed with a GitHub App token, which would otherwise re-trigger every `push`-based workflow on a commit that only changes the version and changelog; publishing already runs in the same workflow run as the bump. This changeset also exercises the release → publish pipeline end to end to confirm the change.

## 1.3.1

### Patch Changes

- 610daf8: Add a `repository` field to the package manifest so npm provenance verification passes. npm checks the published `package.json`'s `repository.url` against the source repository recorded in the OIDC provenance statement; with no field it reads as empty and the publish is rejected with E422. The manifest now points at `git+https://github.com/excitedjs/claudemux.git` with `directory: plugins/claudemux` for the monorepo layout, matching the provenance source URL.

## 1.3.0

### Minor Changes

- aacb71e: `tm send` turn-lifecycle robustness, both anchored to a transcript byte offset snapshotted at send time so they only ever read what the current turn appends.

  - **Submit confirmation.** After injecting a prompt + Enter, `tm send` confirms the REPL accepted it as a turn — the on-busy/idle marker appeared, or a new user entry landed in the transcript jsonl — and re-sends Enter up to 3 times if not. An Enter swallowed by a modal now surfaces a stderr warning instead of a silent wait-to-124. It is warn-and-proceed: a slow-but-live send is never converted into a hard failure (the wait still expires to 124 if the turn truly never runs). Tunable via `CLAUDEMUX_CONFIRM_SUBMIT_MS` (0 disables).
  - **No-hook wait fallback.** The default wait now unblocks on the Stop-hook idle marker OR a settled assistant entry in the transcript jsonl (terminal `stop_reason` plus a `text`/`tool_use` block — the same predicate `on-stop.sh` uses). A teammate whose Stop hook never loaded ends its wait on disk evidence rather than burning the full timeout to a 124. On that no-hook path `tm send` recovers the reply from the turn's appended region (scoped to the send offset) and writes it back to `<sid>.last` the same way `tm spawn --resume` seeds it, so stdout and a later `tm last` / `tm states` all surface the reply instead of the "(no text reply…)" sentinel — a textless tool-only turn clears `.last` to empty. Offset-anchored throughout, so a prior turn's settled entry (or a stale `.last`) is never mistaken for this turn's completion.

## 1.2.0

### Minor Changes

- b2255e5: `tm` usability and teammate-launch hardening.

  - `tm ls --all` / `tm states --all` now also list killed teammates (STATE `killed`) from the kill-time identity archive, so a killed session is discoverable and resumable by name without hand-scraping `/tmp`.
  - `tm spawn` prints a `base:` line on a fresh launch — the repo HEAD branch + short sha the worktree branches from, plus a best-effort ahead/behind against the remote default branch — so a repo parked on a non-trunk branch is obvious instead of a silent wrong baseline (best-effort and read-only; a non-git repo or any failing git probe drops the line and never fails the spawn).
  - Teammates suppress Claude Code's "Resume from summary vs full session" startup prompt by launching with `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` set far above any real context window. A headless teammate cannot answer that modal, and the next `tm send`'s Enter would pick the default summary option (running `/compact`) and discard the context a resume restores. The `tm resume` help and dispatcher guide keep the "confirm with `tm status`" note as a fallback for builds that ignore the knob.
  - Teammates launch with `EnterPlanMode` / `ExitPlanMode` joining `AskUserQuestion` on the disabled-tools list — each opens a modal that holds a turn open waiting for a human a teammate does not have.

## 1.0.0

### Major Changes

- 7d79110: worktree default + name/repo decoupling (schema 2)

  **Breaking changes — `tm kill` and respawn any live teammate before
  upgrading.** The on-disk identity layout, the spawn CLI shape, and the
  SessionStart env var rename are all incompatible with pre-cut state.

  CLI:

  - `tm spawn <path>` now takes a filesystem path (absolute or
    dispatcher-relative). The teammate name is a flat opaque identifier
    controlled by `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`) or
    auto-generated as `<basename(path)>-<rand4>`.
  - Every other teammate verb (`tm send` / `tm wait` / `tm kill` /
    `tm status` / `tm last` / `tm mem` / `tm resume` / etc.) takes
    the flat `<name>` returned by `tm spawn`. No path coupling.
  - `--task <slug>` is removed; use `--name <id>` instead.
  - `--no-worktree` opts a teammate out of worktree mode.

  Default behaviour:

  - Claude teammates launch with `claude --worktree <name>`, landing in
    `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base
    ref `HEAD`). The settings JSON Claude inherits sets
    `worktree.baseRef: "head"`.
  - Codex teammates use claudemux-managed `git worktree add` at the
    same `<path>/.claude/worktrees/<name>/` layout.
  - `tm kill` sends `/exit` to the REPL, waits 5s for `SessionEnd`
    (Claude auto-removes a clean worktree), then sends `Enter` (default
    "Keep worktree" on the dirty-worktree TUI prompt) and waits 3s
    more, falling back to `tmux kill-session` (SIGHUP) only when
    graceful exit times out. Codex `tm kill` removes a clean worktree
    via `git worktree remove --force`, preserves dirty worktrees with
    a stderr warning.

  On-disk surfaces:

  - Identity schema bumped 1 → 2. New fields: `repo`, `worktreeSlug`.
    Schema 1 records are rejected — kill + respawn.
  - `tmux` session name is `teammate-<name>` directly; the `/` → `__`
    encoding (nested-name support) is removed.
  - SessionStart env identity gate is `CLAUDEMUX_TEAMMATE_NAME`
    (previously `CLAUDEMUX_TEAMMATE_REPO`).

  `tm ls` / `tm states` now emit `NAME / REPO / WORKTREE / ENGINE /
STATE` (and the runtime cells for `tm states`).

  `.worktreeinclude` is not yet supported on the Codex self-managed
  path; copy any required gitignored files (`.env`, etc.) into the
  worktree manually for Codex teammates. Claude teammates inherit
  Claude Code's native `.worktreeinclude` handling.

  Research: (internal design doc)

### Minor Changes

- 7d79110: add Codex UI IPC bridge for live Desktop and VS Code visibility
- 7d79110: migrate release pipeline to Changesets

### Patch Changes

- 0822262: Fix dispatcher skill docs to match live `tm` CLI: correct `<repo>`/`<name>` confusion (post-spawn verbs take `<name>`; spawn takes `<path>`), fix `tm wait <name> --fresh` flag order in two places, remove the deleted `--task <slug>` spawn flag, and clean up associated historical commentary.
- 05377ec: docs: clarify that the "AutoMemory directory" in the dispatcher template and skill references is `~/.claude/projects/<encoded-cwd>/memory/`, not a project-local path
- 7d79110: fix Codex UI IPC discovery for follower control requests
- 7d79110: fix Codex UI IPC follower interrupt and steering controls
- 9ceed4e: Collapse the `plugins/claudemux/core/` subdirectory into the plugin root so the plugin has a single `package.json` (the same shape `plugins/feishu-channel` already uses). `src/`, `test/`, `third_party/`, `resolver*.mjs`, `tsconfig.json`, `vitest.integration.config.ts`, `knip.json`, and `core/scripts/*` move up one level; the inner `core/package.json` and its `package-lock.json` are removed and the outer manifest absorbs the Node project fields (`type`, `engines`, `imports`, devDeps, test/typecheck/lint scripts). `bin/tm`'s `ROOT` resolution, `.changeset/config.json`'s `changedFilePatterns`, the CI job (switched from `npm ci` to workspace pnpm install), and the KB docs that describe current state are updated accordingly. Runtime behavior of `tm` is unchanged.

  Also: move `bin/check-author` to `scripts/check-author` (it is a repo governance tool, not a user-facing executable) and remove two stale regression scripts (`bin/test-tm-mem`, `bin/test-tm-prompt-splat`) that targeted the pre-TypeScript Bash `tm` and no longer execute against current code.

- 7d79110: add next beta release automation workflow
- 7d79110: dispatcher skill: add MUST/MUST-NOT prompt-composition checklist for `tm spawn/send --prompt` and a default-to-parallel dispatch posture for fan-out across teammates
- 7d79110: fix Codex UI IPC live snapshot broadcasts by sending the method schema version
- 7d79110: fix: correct cron host rule — `tm`-spawned Claude tmux sessions can also host CronCreate jobs; only `claude -p` and Agent Teams subagents silently fail to fire
- cebbfa7: sync-plugin-version now mirrors the feishu-channel plugin manifest version as well, so `plugins/feishu-channel/.claude-plugin/plugin.json` stays in lockstep with its package.json after `changeset version` instead of drifting.
- 7d79110: Fix two beta.10 worktree-mode regressions:

  - `tm kill` now treats the teammate's idle marker
    (`/tmp/claude-idle/<sid>`) being touched as a positive SessionEnd
    signal — on-stop.sh fires SessionEnd before tmux reaps the pane, so
    the kill returns graceful as soon as the marker advances instead of
    paying the full process-teardown wall-clock. The combined budget is
    bumped 8s → 20s (15s exit + 5s keep) so a slow Opus 4.7 box on
    Linux no longer SIGHUPs every clean kill and leaks
    `claude --worktree` worktrees. Override via `CLAUDEMUX_KILL_GRACE_MS`.

  - `tm kill` now archives the live identity record before deleting it.
    `tm resume <name> <sid>` and `tm history <name>` consult the
    archive when the live record is gone, so they recover the killed
    teammate's worktree cwd / repo / worktreeSlug instead of falling
    back to the dispatcher's directory. The agent never has to read or
    write under `/tmp` directly — the standard verbs cover the
    post-kill recovery path.

- 7d79110: `tm kill`: tear down the tmux session on graceful exit too. The
  idle-marker SessionEnd signal fires while Claude's REPL is still
  unwinding, so the shell that hosted Claude was left holding the
  tmux session alive as a bare prompt — the teammate appeared
  `unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
  reported "already running". The graceful branch now issues a
  best-effort `tmux kill-session` after the marker signal, matching
  the SIGHUP-fallback path.
- 9ceed4e: Fix the plugin-root path walk after the `core/` collapse moved the source tree up one level. `tmWrapperPath`/`pluginJsonPath` (`src/plugin-root.ts`) and `resolveTmBinary` (`src/tm.ts`) still walked up two directories from their module, resolving to `plugins/bin/tm` and `plugins/.claude-plugin/plugin.json` instead of the real files under `plugins/claudemux/`. Each now walks up one level. A new `test/paths.test.ts` block pins all three helpers to files that must exist on disk under a `claudemux` plugin root, so a future tree-depth change fails in CI instead of at teammate spawn or plugin.json read.
- 7d79110: fix next beta release workflow prerelease changeset consumption
- 7d79110: add promote-main and reset-next-pre release workflows
- 7d79110: switch the next beta release workflow direct push to the claudemux release GitHub App token
- 7d79110: switch next beta release workflow to direct push without GitHub App credentials
- cd49706: Rework the release pipeline onto direct-push beta + GA and drop the self-built workaround layer. release-next no longer rewrites pre.json internal state (the `prepare-prerelease-changesets` script is removed) and sets `HUSKY=0` so the bot's version-bump push is not blocked by the local pre-push changeset check — a check that misfires on the release commit because the bump touches a release-surface file (`package.json`) whose changeset is already consumed. GA moves off the never-run `workflow_dispatch` promote button onto a push-to-main workflow that exits pre mode, versions, and pushes the GA commit directly; `reset-next-pre` then fast-forwards next to main's GA state and re-enters beta pre mode so the next prerelease cycle versions from the GA base instead of re-consuming shipped changesets.
- 7d79110: add changeset-status CI gate

## 1.0.0-beta.18

### Patch Changes

- 9ceed4e: Collapse the `plugins/claudemux/core/` subdirectory into the plugin root so the plugin has a single `package.json` (the same shape `plugins/feishu-channel` already uses). `src/`, `test/`, `third_party/`, `resolver*.mjs`, `tsconfig.json`, `vitest.integration.config.ts`, `knip.json`, and `core/scripts/*` move up one level; the inner `core/package.json` and its `package-lock.json` are removed and the outer manifest absorbs the Node project fields (`type`, `engines`, `imports`, devDeps, test/typecheck/lint scripts). `bin/tm`'s `ROOT` resolution, `.changeset/config.json`'s `changedFilePatterns`, the CI job (switched from `npm ci` to workspace pnpm install), and the KB docs that describe current state are updated accordingly. Runtime behavior of `tm` is unchanged.

  Also: move `bin/check-author` to `scripts/check-author` (it is a repo governance tool, not a user-facing executable) and remove two stale regression scripts (`bin/test-tm-mem`, `bin/test-tm-prompt-splat`) that targeted the pre-TypeScript Bash `tm` and no longer execute against current code.

- 9ceed4e: Fix the plugin-root path walk after the `core/` collapse moved the source tree up one level. `tmWrapperPath`/`pluginJsonPath` (`src/plugin-root.ts`) and `resolveTmBinary` (`src/tm.ts`) still walked up two directories from their module, resolving to `plugins/bin/tm` and `plugins/.claude-plugin/plugin.json` instead of the real files under `plugins/claudemux/`. Each now walks up one level. A new `test/paths.test.ts` block pins all three helpers to files that must exist on disk under a `claudemux` plugin root, so a future tree-depth change fails in CI instead of at teammate spawn or plugin.json read.
- cd49706: Rework the release pipeline onto direct-push beta + GA and drop the self-built workaround layer. release-next no longer rewrites pre.json internal state (the `prepare-prerelease-changesets` script is removed) and sets `HUSKY=0` so the bot's version-bump push is not blocked by the local pre-push changeset check — a check that misfires on the release commit because the bump touches a release-surface file (`package.json`) whose changeset is already consumed. GA moves off the never-run `workflow_dispatch` promote button onto a push-to-main workflow that exits pre mode, versions, and pushes the GA commit directly; `reset-next-pre` then fast-forwards next to main's GA state and re-enters beta pre mode so the next prerelease cycle versions from the GA base instead of re-consuming shipped changesets.

## 1.0.0-beta.17

### Patch Changes

- cebbfa7: sync-plugin-version now mirrors the feishu-channel plugin manifest version as well, so `plugins/feishu-channel/.claude-plugin/plugin.json` stays in lockstep with its package.json after `changeset version` instead of drifting.

## 1.0.0-beta.16

### Patch Changes

- 0822262: Fix dispatcher skill docs to match live `tm` CLI: correct `<repo>`/`<name>` confusion (post-spawn verbs take `<name>`; spawn takes `<path>`), fix `tm wait <name> --fresh` flag order in two places, remove the deleted `--task <slug>` spawn flag, and clean up associated historical commentary.

## 1.0.0-beta.15

### Patch Changes

- 05377ec: docs: clarify that the "AutoMemory directory" in the dispatcher template and skill references is `~/.claude/projects/<encoded-cwd>/memory/`, not a project-local path

## 1.0.0-beta.14

### Major Changes

- 7d79110: worktree default + name/repo decoupling (schema 2)

  **Breaking changes — `tm kill` and respawn any live teammate before
  upgrading.** The on-disk identity layout, the spawn CLI shape, and the
  SessionStart env var rename are all incompatible with pre-cut state.

  CLI:

  - `tm spawn <path>` now takes a filesystem path (absolute or
    dispatcher-relative). The teammate name is a flat opaque identifier
    controlled by `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`) or
    auto-generated as `<basename(path)>-<rand4>`.
  - Every other teammate verb (`tm send` / `tm wait` / `tm kill` /
    `tm status` / `tm last` / `tm mem` / `tm resume` / etc.) takes
    the flat `<name>` returned by `tm spawn`. No path coupling.
  - `--task <slug>` is removed; use `--name <id>` instead.
  - `--no-worktree` opts a teammate out of worktree mode.

  Default behaviour:

  - Claude teammates launch with `claude --worktree <name>`, landing in
    `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base
    ref `HEAD`). The settings JSON Claude inherits sets
    `worktree.baseRef: "head"`.
  - Codex teammates use claudemux-managed `git worktree add` at the
    same `<path>/.claude/worktrees/<name>/` layout.
  - `tm kill` sends `/exit` to the REPL, waits 5s for `SessionEnd`
    (Claude auto-removes a clean worktree), then sends `Enter` (default
    "Keep worktree" on the dirty-worktree TUI prompt) and waits 3s
    more, falling back to `tmux kill-session` (SIGHUP) only when
    graceful exit times out. Codex `tm kill` removes a clean worktree
    via `git worktree remove --force`, preserves dirty worktrees with
    a stderr warning.

  On-disk surfaces:

  - Identity schema bumped 1 → 2. New fields: `repo`, `worktreeSlug`.
    Schema 1 records are rejected — kill + respawn.
  - `tmux` session name is `teammate-<name>` directly; the `/` → `__`
    encoding (nested-name support) is removed.
  - SessionStart env identity gate is `CLAUDEMUX_TEAMMATE_NAME`
    (previously `CLAUDEMUX_TEAMMATE_REPO`).

  `tm ls` / `tm states` now emit `NAME / REPO / WORKTREE / ENGINE /
STATE` (and the runtime cells for `tm states`).

  `.worktreeinclude` is not yet supported on the Codex self-managed
  path; copy any required gitignored files (`.env`, etc.) into the
  worktree manually for Codex teammates. Claude teammates inherit
  Claude Code's native `.worktreeinclude` handling.

  Research: (internal design doc)

### Minor Changes

- 7d79110: add Codex UI IPC bridge for live Desktop and VS Code visibility
- 7d79110: migrate release pipeline to Changesets

### Patch Changes

- 7d79110: fix Codex UI IPC discovery for follower control requests
- 7d79110: fix Codex UI IPC follower interrupt and steering controls
- 7d79110: add next beta release automation workflow
- 7d79110: dispatcher skill: add MUST/MUST-NOT prompt-composition checklist for `tm spawn/send --prompt` and a default-to-parallel dispatch posture for fan-out across teammates
- 7d79110: fix Codex UI IPC live snapshot broadcasts by sending the method schema version
- 7d79110: fix: correct cron host rule — `tm`-spawned Claude tmux sessions can also host CronCreate jobs; only `claude -p` and Agent Teams subagents silently fail to fire
- 7d79110: Fix two beta.10 worktree-mode regressions:

  - `tm kill` now treats the teammate's idle marker
    (`/tmp/claude-idle/<sid>`) being touched as a positive SessionEnd
    signal — on-stop.sh fires SessionEnd before tmux reaps the pane, so
    the kill returns graceful as soon as the marker advances instead of
    paying the full process-teardown wall-clock. The combined budget is
    bumped 8s → 20s (15s exit + 5s keep) so a slow Opus 4.7 box on
    Linux no longer SIGHUPs every clean kill and leaks
    `claude --worktree` worktrees. Override via `CLAUDEMUX_KILL_GRACE_MS`.

  - `tm kill` now archives the live identity record before deleting it.
    `tm resume <name> <sid>` and `tm history <name>` consult the
    archive when the live record is gone, so they recover the killed
    teammate's worktree cwd / repo / worktreeSlug instead of falling
    back to the dispatcher's directory. The agent never has to read or
    write under `/tmp` directly — the standard verbs cover the
    post-kill recovery path.

- 7d79110: `tm kill`: tear down the tmux session on graceful exit too. The
  idle-marker SessionEnd signal fires while Claude's REPL is still
  unwinding, so the shell that hosted Claude was left holding the
  tmux session alive as a bare prompt — the teammate appeared
  `unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
  reported "already running". The graceful branch now issues a
  best-effort `tmux kill-session` after the marker signal, matching
  the SIGHUP-fallback path.
- 7d79110: fix next beta release workflow prerelease changeset consumption
- 7d79110: add promote-main and reset-next-pre release workflows
- 7d79110: switch the next beta release workflow direct push to the claudemux release GitHub App token
- 7d79110: switch next beta release workflow to direct push without GitHub App credentials
- 7d79110: add changeset-status CI gate

## 1.0.0-beta.13

### Patch Changes

- 4d2f0f5: `tm kill`: tear down the tmux session on graceful exit too. The
  idle-marker SessionEnd signal fires while Claude's REPL is still
  unwinding, so the shell that hosted Claude was left holding the
  tmux session alive as a bare prompt — the teammate appeared
  `unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
  reported "already running". The graceful branch now issues a
  best-effort `tmux kill-session` after the marker signal, matching
  the SIGHUP-fallback path.

## 1.0.0-beta.12

### Patch Changes

- 0a0b2cd: Fix two beta.10 worktree-mode regressions:

  - `tm kill` now treats the teammate's idle marker
    (`/tmp/claude-idle/<sid>`) being touched as a positive SessionEnd
    signal — on-stop.sh fires SessionEnd before tmux reaps the pane, so
    the kill returns graceful as soon as the marker advances instead of
    paying the full process-teardown wall-clock. The combined budget is
    bumped 8s → 20s (15s exit + 5s keep) so a slow Opus 4.7 box on
    Linux no longer SIGHUPs every clean kill and leaks
    `claude --worktree` worktrees. Override via `CLAUDEMUX_KILL_GRACE_MS`.

  - `tm kill` now archives the live identity record before deleting it.
    `tm resume <name> <sid>` and `tm history <name>` consult the
    archive when the live record is gone, so they recover the killed
    teammate's worktree cwd / repo / worktreeSlug instead of falling
    back to the dispatcher's directory. The agent never has to read or
    write under `/tmp` directly — the standard verbs cover the
    post-kill recovery path.

## 1.0.0-beta.11

### Patch Changes

- a1f4930: dispatcher skill: add MUST/MUST-NOT prompt-composition checklist for `tm spawn/send --prompt` and a default-to-parallel dispatch posture for fan-out across teammates

## 1.0.0-beta.10

### Major Changes

- 01cd095: worktree default + name/repo decoupling (schema 2)

  **Breaking changes — `tm kill` and respawn any live teammate before
  upgrading.** The on-disk identity layout, the spawn CLI shape, and the
  SessionStart env var rename are all incompatible with pre-cut state.

  CLI:

  - `tm spawn <path>` now takes a filesystem path (absolute or
    dispatcher-relative). The teammate name is a flat opaque identifier
    controlled by `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`) or
    auto-generated as `<basename(path)>-<rand4>`.
  - Every other teammate verb (`tm send` / `tm wait` / `tm kill` /
    `tm status` / `tm last` / `tm mem` / `tm resume` / etc.) takes
    the flat `<name>` returned by `tm spawn`. No path coupling.
  - `--task <slug>` is removed; use `--name <id>` instead.
  - `--no-worktree` opts a teammate out of worktree mode.

  Default behaviour:

  - Claude teammates launch with `claude --worktree <name>`, landing in
    `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base
    ref `HEAD`). The settings JSON Claude inherits sets
    `worktree.baseRef: "head"`.
  - Codex teammates use claudemux-managed `git worktree add` at the
    same `<path>/.claude/worktrees/<name>/` layout.
  - `tm kill` sends `/exit` to the REPL, waits 5s for `SessionEnd`
    (Claude auto-removes a clean worktree), then sends `Enter` (default
    "Keep worktree" on the dirty-worktree TUI prompt) and waits 3s
    more, falling back to `tmux kill-session` (SIGHUP) only when
    graceful exit times out. Codex `tm kill` removes a clean worktree
    via `git worktree remove --force`, preserves dirty worktrees with
    a stderr warning.

  On-disk surfaces:

  - Identity schema bumped 1 → 2. New fields: `repo`, `worktreeSlug`.
    Schema 1 records are rejected — kill + respawn.
  - `tmux` session name is `teammate-<name>` directly; the `/` → `__`
    encoding (nested-name support) is removed.
  - SessionStart env identity gate is `CLAUDEMUX_TEAMMATE_NAME`
    (previously `CLAUDEMUX_TEAMMATE_REPO`).

  `tm ls` / `tm states` now emit `NAME / REPO / WORKTREE / ENGINE /
STATE` (and the runtime cells for `tm states`).

  `.worktreeinclude` is not yet supported on the Codex self-managed
  path; copy any required gitignored files (`.env`, etc.) into the
  worktree manually for Codex teammates. Claude teammates inherit
  Claude Code's native `.worktreeinclude` handling.

  Research: (internal design doc)

## 1.0.0-beta.9

### Patch Changes

- fe1b73e: fix next beta release workflow prerelease changeset consumption

## 1.0.0-beta.8

### Patch Changes

- 413b638: fix: correct cron host rule — `tm`-spawned Claude tmux sessions can also host CronCreate jobs; only `claude -p` and Agent Teams subagents silently fail to fire

## 1.0.0-beta.7

### Patch Changes

- 41a40a4: fix Codex UI IPC discovery for follower control requests

## 1.0.0-beta.6

### Patch Changes

- 2c59de8: fix Codex UI IPC follower interrupt and steering controls

## 1.0.0-beta.5

### Patch Changes

- 50ea451: fix Codex UI IPC live snapshot broadcasts by sending the method schema version
- 43791e5: switch the next beta release workflow direct push to the claudemux release GitHub App token
- d7515cf: switch next beta release workflow to direct push without GitHub App credentials

## 1.0.0-beta.4

### Minor Changes

- 78c5174: add Codex UI IPC bridge for live Desktop and VS Code visibility
- 85baeaf: migrate release pipeline to Changesets

### Patch Changes

- 50ab7a0: add next beta release automation workflow
- 7461c71: add promote-main and reset-next-pre release workflows
- 6013007: add changeset-status CI gate
