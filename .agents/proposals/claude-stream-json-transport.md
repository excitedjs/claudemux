# Proposal: a stream-json stdio transport for the Claude engine

> **Status: IMPLEMENTED in 3.0.0-beta.0 (issue #49).** The Claude engine now
> drives every teammate over the stream-json stdio broker; the tmux
> `send-keys` / `capture-pane` bridge and the hook bundle are removed (clean
> switch, no dual path). This document is the design record and rationale; the
> code is in `plugins/claudemux/src/engines/claude/stream-json/` and the rewired
> `claude-engine.ts`. **As-built deviations from the design body below:**
> - **Permission posture is `--dangerously-skip-permissions`** (not a
>   `--permission-mode` value): the documented, unambiguously-headless bypass
>   flag (`--permission-mode bypassPermissions` can be gated by org policy). Same
>   unattended posture as Codex's `Never`. The `can_use_tool` allowlist-parity
>   path stays deferred.
> - **The hook bundle is removed, not retained.** on-busy/on-stop fired for every
>   `claude` session (including a headless `-p` child) and do not gate on the
>   teammate env, so they would have double-written the broker's signal. The
>   broker is the sole signal owner; the hooks were the old mechanism it
>   replaces.
> - **Deferred (accepted degradations):** the `can_use_tool` allowlist policy,
>   the read-write `tm attach` live viewer / interrupt-based takeover, and the
>   channels (`--channels`) handler. Live human observability is `tm last` /
>   `tm states` / `tm status` for now. Remote Control IS wired (broker sends the
>   `remote_control` control request — "plan A").
>
> Targets issue #49 and reassesses issue #48 (cross-platform portability).
>
> **Revision note (rev 2).** Rev 1 concluded stream-json could only be the
> default for a "plain headless-dispatch" class (too conservative). Rev 2
> corrected that toward full functional replacement — but overstated it as
> "fully replaces tmux now" and made one blocker-level factual error about
> permissions. This rev 3 fixes both: the target is a **full functional
> replacement, with the default switch *gated* behind explicit parity criteria**,
> and the permission model is rebuilt on the verified facts below. Corrections
> incorporated from an independent cross-engine review; each was re-verified
> against source before acceptance.
>
> **Protocol reference.** The wire-format facts below were verified against the
> public Claude Code CLI behavior, the published Agent SDK docs, and the publicly
> documented first-party IDE integration. claudemux ships its own clean
> implementation of the protocol; it does not vendor or copy any Claude Code
> source.

## Why

The Claude engine drives each teammate as an interactive `claude` REPL inside a
`tmux` pane: input is `tmux send-keys -l` + `Enter`, and turn state plus reply
text are recovered by polling `tmux capture-pane` and the per-session hook
markers. This is screen-scraping a TUI. The structured costs — pane-gone races,
turn state inferred from rendered text, ANSI/width coupling, no token / cost /
stop-reason metadata, and permission prompts answered as synthesized keystrokes
— are the subject of issue #49.

Claude Code ships a first-class programmatic transport — newline-delimited JSON
envelopes over stdio (`--output-format stream-json --input-format stream-json`),
with a bidirectional control plane on the same pipes.

## Existence proof: the first-party IDE integration already runs on this transport

Claude Code's own VS Code / JetBrains integration does **not** drive the model
through a terminal. It spawns the `claude` binary as an Agent SDK subprocess with
`--output-format stream-json --verbose --input-format stream-json
--include-partial-messages` and exchanges **both** data-plane envelopes and
control-plane RPC over the child's stdio. The complete interactive experience —
live token-streamed output, permission prompts as native dialogs, interrupt /
steering, model and permission-mode switching, IDE tools, resume — is delivered
over exactly the headless transport this proposal adopts. The IDE's `ide` tool
surface is itself an MCP server bridged over the stdio control plane; the public
IDE-integration docs describe it.

The consequence: **no teammate _agent_ capability is gated to tmux.** Anything
the model can do in the interactive REPL — run tools, take permission decisions,
be steered, resume, stream — a stream-json client plus the control plane can
drive, because that is how the first-party interactive client is built.

This must not be over-read into "tmux is already replaceable." Several **human-
operator** capabilities are live today and would be *degraded until rebuilt*, not
free: `tmux attach` hands a human a real keyboard-in-REPL with zero client code;
shared / SSH attach and terminal scrollback come for free; the raw TUI renders
slash-command menus and chords. claudemux uses some of these directly today —
`tm status` scrapes the pane (`claude-engine.ts:321-372`), `tm kill` drives
`/exit` + tmux teardown (`claude-engine.ts:447-538`). So the honest claim is:
**full functional replacement is achievable, but it is a build, and the default
switch is gated** behind the parity criteria in *Tradeoff: human observability*.
"degraded interim acceptable" is a decision the operator gets to make, not a
property to assert.

## What the tmux bridge does today (code map)

The pieces a new transport must either reuse or replace. Paths are under
`plugins/claudemux/`.

**Launch.** `src/engines/claude/spawn.ts`

- `teammateLaunchFlags` (`spawn.ts:122-125`) builds the launch flags:
  `--settings <mdExcludes> --disallowedTools AskUserQuestion,EnterPlanMode,ExitPlanMode`,
  plus `--remote-control` when requested.
- The settings blob (`spawn.ts:142-156`) carries `claudeMdExcludes` (shields the
  dispatcher's `CLAUDE.md`) and, for worktrees, `worktree.baseRef`.
- `launchCmd` (`spawn.ts:399-404`) selects `claude --session-id <uuid>` /
  `--resume <sid>` / `--continue` plus the flags.
- The teammate is started with `tmux new-session -d -s <session> -c <cwd> -e
  CLAUDEMUX_TEAMMATE_NAME=<name> -e CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=…`
  (`spawn.ts:370-384`), then `tmux send-keys … Enter` injects `launchCmd`
  (`spawn.ts:405`). Spawn then polls `readyFile(name)` for the SessionStart hook
  to fire (`spawn.ts:163-170`).

**Input (send).** `src/engines/claude/keys.ts` — `sendKeys` (`keys.ts:70-163`)
is the dual-send protocol: inline `send-keys -l` + `Enter` for short prompts
(`keys.ts:115-123`); `load-buffer` / `paste-buffer` + size-based settle gap +
`Enter` for larger or multi-line prompts (`keys.ts:126-151`). `src/engines/claude/send.ts`
(`send.ts:35-133`) orchestrates clear-baseline → send → confirm-submit →
wait-for-turn-end → recover reply.

**Turn detection & output recovery.** `src/engines/claude/wait-signals.ts`

- `confirmSubmit` (`wait-signals.ts:66-111`) checks the busy/idle markers or a new
  `type:"user"` entry in the transcript to confirm the REPL accepted the prompt;
  re-sends `Enter` up to three times.
- `waitForTurnEnd` (`wait-signals.ts:132-155`) blocks on either the idle marker
  `idleMarkerFor(sid)` **or** a settled terminal assistant entry in the
  transcript (`terminalAssistantAfter`, `src/engines/claude/turn-jsonl.ts:110-132`).
- Reply text comes from `<sid>.last` via `printLastOrEmpty`
  (`src/engines/claude/post-turn.ts:19-29`), with a transcript-scan fallback
  (`lastAssistantTextAfter`, `turn-jsonl.ts:146-165`).

**The hook-driven turn signal.** `hooks/on-busy.sh:39` writes `<sid>.busy` on
`PreToolUse`/`UserPromptSubmit`/…; `hooks/on-stop.sh` removes `.busy`
(`on-stop.sh:81`), extracts the final assistant turn into `<sid>.last`
(`on-stop.sh:237,246`), then **last** touches the idle marker
(`on-stop.sh:264`) — the documented write-ordering that lets a waiter racing the
marker still find `.last` in place. `hooks/on-session-start.sh:84,94` rotates the
sid file and touches `readyFile`. Wiring: `hooks/hooks.json`.

**Other scrape sites.** `tm status` capture-pane (`claude-engine.ts:321-372`);
`tm compact` refusal scrape `capture-pane … includes(COMPACT_REFUSAL_MARK)`
(`src/engines/claude/compact.ts:69-86`); graceful kill sends `/exit` + `Enter`
and watches the marker (`claude-engine.ts:447-538`).

**The seams a new transport plugs into (unchanged).**

- The `Engine` interface (`src/engines/engine.ts:54-88`), request/result unions
  (`src/engines/types.ts`), capability record (`claude-engine.ts:85-95`), and the
  registry (`src/engines/registry.ts`).
- Identity records: `reserve` / `read` / `archive` over `/tmp/teammate-<name>.json`
  (`src/persistence/identity-store.ts:123,151,175`), built by
  `ClaudeTeammateRecord` (`src/engines/claude/persistence.ts`).
- Named path builders (`src/persistence/paths.ts`): `idleMarkerFor:29`,
  `busyMarkerFor:34`, `lastFileFor:39`, `cwdFile:44`, `sidFile:49`, `readyFile:54`,
  `sendAtFile:59`, `tmuxSessionName:72`, `encodeProjectDir:136`.
- Transcript reading for `ctx` / `last` / `history`
  (`src/engines/claude/ctx.ts`, `history.ts`, `turn-jsonl.ts`).

**The Codex precedent.** A non-tmux engine already exists, and it is the exact
shape this transport reuses. The Codex driver spawns a **detached** long-lived
daemon (`src/engines/codex/supervisor.ts:376-386,490-531` — `spawn({detached:true})`
+ `child.unref()`), records it in a filesystem process registry, reconnects per
ephemeral `tm` invocation over a unix socket, pins the JSON-RPC schema and fails
loud on drift (`src/engines/codex/rpc.ts`), and runs a broker that serves
multiple clients from one daemon connection (`src/engines/codex/ipc-bridge.ts`).
Note the current process primitive `spawnCapture` (`src/proc.ts`) is
run-to-completion only; a streaming/persistent spawn is new surface.

## The stream-json protocol (verified wire facts)

**Launch.** `claude -p --output-format stream-json --input-format stream-json
--verbose [--include-partial-messages] [--channels <servers…>]`.

- `-p`/`--print` is required (stream-json is print-mode only).
- `--verbose` is **required** with `--output-format stream-json` under `-p`.
- `--include-partial-messages` adds the `stream_event`-wrapped incremental deltas
  (`message_start` → `content_block_delta` → `message_delta`/`message_stop`;
  delta types `text_delta`, `thinking_delta`, `input_json_delta`).
- Session selection composes: `--session-id <uuid>`, `--resume <sid>`,
  `--continue`, `--fork-session`, `--no-session-persistence`.
- Permissions: `--permission-mode <mode>`; `--permission-prompt-tool <tool>`.
  **Correction:** print mode does **not** default this to `stdio`. The CLI forces
  `stdio` only when `--sdk-url` is set; otherwise it uses the value passed, which
  has no default (`main.tsx:988` — no `.default()`; `print.ts:803-805` —
  `options.sdkUrl ? 'stdio' : options.permissionPromptToolName`). To route tool
  gating to the driver as `can_use_tool`, claudemux must **explicitly** pass
  `--permission-prompt-tool stdio` (`print.ts:4280` — only `'stdio'` selects
  `structuredIO.createCanUseTool`). See *Permissions*.
- **Channels:** `--channels <servers…>` registers the inbound push notifications
  of named MCP servers with the session, and **works in both interactive and
  print/SDK modes** (`main.tsx:1685-1694`, `:3845`).

**Output envelopes (stdout, one JSON object per line).** Top-level `type`:

| `type` | Carries |
|---|---|
| `system` / `subtype:"init"` | `session_id`, `model`, `tools[]`, `mcp_servers[]`, `permissionMode`, `cwd`, `memory_paths`, `slash_commands[]`, `claude_code_version`, `uuid` — turn-start metadata |
| `system` / `subtype:"status"` | explicit working / requesting signal |
| `system` / `subtype:"compact_boundary"` | compaction happened |
| `system` / `hook_started` · `hook_response` | hook lifecycle (with `--include-hook-events`) |
| `stream_event` | wraps a raw Anthropic streaming event in `event`; plus `session_id`, `parent_tool_use_id`, `uuid` |
| `assistant` | full assistant message snapshot in `message` (`content`, `usage`, `stop_reason`); `session_id` |
| `user` | echoed user message / tool-result reflow |
| `result` | terminal: `subtype` (`success` / `error_*`), `is_error`, `stop_reason`, `result`, `usage`, `total_cost_usd`, `num_turns`, `duration_ms`, `ttft_ms`, `session_id`, `permission_denials` |
| `control_request` / `control_response` / `control_cancel_request` | the bidirectional control plane (below) |

**Input messages (stdin, one JSON object per line).**

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

The process stays alive reading stdin: each user message produces one turn's
envelopes ending in `result`, and the session remains open for the next message
until **stdin EOF** or an `end_session`. One persistent process hosts many turns.

**The control plane.** A bidirectional RPC rides the same stdio. Each request
carries a `request_id`; responses are paired by it. `control_cancel_request`
aborts an in-flight request. Driver → binary subtypes include `initialize`
(handshake: hooks, sdkMcpServers, systemPrompt, agents), `interrupt` (steer /
cancel the current turn), `set_permission_mode`, `set_model`,
`set_max_thinking_tokens`, `mcp_set_servers`, `mcp_message`, `remote_control`.
Binary → driver subtypes include `can_use_tool` (the permission request:
`tool_name`, `input`, `tool_use_id`, `permission_suggestions`; the driver answers
`{behavior:"allow"|"deny"|"ask", updatedInput?, message?}`), `hook_callback`,
`mcp_message`, `elicitation`. `initialize` is optional — the first user message
implicitly initializes.

**Stability boundary.** The data-plane envelopes and the user-message input shape
are documented and reproducible from the public CLI. The control-plane RPC is the
supported interface the first-party IDE integration and the Agent SDK are built
on — maintained, not a private hack. But it is **broad and stateful**: the
request union is ~21 subtypes (`controlSchemas.ts` `SDKControlRequestInnerSchema`
— interrupt, permission, initialize, set_permission_mode, set_model,
set_max_thinking_tokens, mcp_status, get_context_usage, hook_callback,
mcp_message, rewind_files, cancel_async_message, seed_read_state, mcp_set_servers,
reload_plugins, mcp_reconnect, mcp_toggle, stop_task, apply_flag_settings,
get_settings, elicitation), plus `control_cancel_request`. A broker must track
pending requests by `request_id`, handle cancels, and not choke on an orphan or
unknown response (`structuredIO.ts` pending-map + cancel handling). The risk for
claudemux is twofold: it drives whatever `claude` the user installed (the IDE
integration bundles a version-locked binary), so it absorbs cross-version drift;
and the surface it must speak correctly is larger than permissions+RC. Mitigation:
pin the schema and fail loud on an unknown **control** subtype (Codex `rpc.ts`
discipline), be **forward-tolerant** on unknown **data-plane** envelopes (skip +
log, never crash a turn — the schema set is wider than any one snapshot, see
*PR1*), record a tested-version floor, and **soak the broker as opt-in before any
default switch** rather than assuming the surface is fully understood.

## Landing design

### Lifecycle: a persistent per-teammate session behind a detached broker

A stream-json session is one long-lived process holding stdin/stdout, and the
live / push features (Remote Control, channels, steering) require that the
session stays alive between `tm` calls. `tm` is stateless and ephemeral, so —
exactly as for Codex — the session lives behind a **detached per-teammate
broker**: the broker spawns the stream-json `claude` child, holds its pipes,
speaks the control plane, exposes a unix socket, and persists across `tm` calls.
Each `tm send` / `wait` connects to the socket, submits a turn, streams envelopes
back, and the broker writes the turn signal / reply / usage to disk.

A **per-turn** `claude -p --resume <sid>` (spawn → one turn → exit) is the one
shape that genuinely *cannot* host the live features — there is no persistent
session for a channel push or an RC bridge to attach to. It is therefore used
only as the **spike** (it proves the protocol end-to-end with the least
machinery); the persistent broker is the real architecture and the default.

Resume/lifecycle maps onto the existing teammate-record model unchanged: the
record already stores the engine checkpoint; the `session_id` from the
`init`/`result` envelope is the resume id, written back each turn; relaunch is
`--resume <session_id>`; a `/clear`-equivalent forks a new session id, updating
the record exactly as the tmux engine's sid rotation does today.

### Input / output handling

- **Input.** A turn is one `{"type":"user","message":{…}}` line on the child's
  stdin (forwarded from the socket client). This replaces the entire dual-send
  protocol (`keys.ts`) — no inline/paste split, no settle gap, no Enter timing,
  no submit re-confirmation.
- **Output.** The broker parses newline-delimited envelopes through a single
  pinned schema layer. Turn completion is the `result` envelope — explicit and
  unambiguous — replacing both the hook idle marker and the transcript-scan
  fallback. Reply text, token usage, cost, model, stop_reason, and session id come
  straight off `result` / `init`, so `tm ctx` and `tm last` read structured
  fields instead of scraping the transcript JSONL.
- **Turn signal for the fleet verbs.** The broker owns the signal it used to read
  from the hooks: it writes the same `/tmp` protocol files (busy on
  `status:working`, idle + `.last` on `result`, preserving the `.last`-before-idle
  ordering) through the existing named path builders, so `tm states` / `tm ls` /
  `tm wait` keep working with no hook dependency for this engine.
- **Unsolicited turns.** Because channels and Remote Control inject turns the
  broker did not originate (a `result` with no matching `tm send`), the broker
  treats the stream as the source of truth and surfaces such turns to the
  dispatcher, rather than assuming one `result` per `tm send`. This is a
  first-class property of the broker, not an add-on.

### Permissions

This section is rebuilt on verified facts; an earlier draft wrongly assumed print
mode routes permissions to the driver by default.

**Verified behavior.** `--permission-prompt-tool` has no default
(`main.tsx:988`); print mode forces `stdio` **only** under `--sdk-url`
(`print.ts:803-805`). The `can_use_tool` control callback is selected **only**
when the value is `'stdio'` (`print.ts:4280` → `structuredIO.createCanUseTool`).
With no prompt tool — the plain `claude -p --input-format stream-json` case — the
CLI uses its normal permission engine (`getCanUseToolFn` → `hasPermissionsToUseTool`),
which resolves from `--permission-mode` + the settings allowlist, and on a
would-ask decision with no interactive UI **falls through to auto-deny**, not a
hang (`utils/permissions/permissions.ts:394-398` "fallback auto-deny";
`:463` "fall through to auto-deny rather than crashing"; `dontAsk` converts
ask→deny at `:503-510`).

Today a tmux teammate launches with `--disallowedTools …`, no allowlist
injection, no skip-permissions, and **no** programmatic per-tool answer; in the
interactive pane a would-ask tool shows a modal the unattended teammate cannot
clear — a real stall risk. Headless stream-json is therefore *safer by default*
(auto-deny, no stall), but auto-deny also means an un-allowlisted tool silently
fails unless permissions are handled deliberately. The design must choose, per
teammate, among three explicit postures — each with stated security meaning:

- **(A) Structured callback — `--permission-prompt-tool stdio` + a broker
  `can_use_tool` handler.** The issue's vision and the only posture with real
  per-tool policy. The broker answers each request (`allow`/`deny`/`ask` +
  optional `updatedInput`) from a policy. Cost: the broker takes on this slice of
  the control plane and must implement the policy. **Recommended for the eventual
  default**, with the policy itself a deliberate choice (mirror the settings
  allowlist for parity, or auto-allow for an unattended fleet).
- **(B) Bypass — `--permission-mode bypassPermissions`.** Explicit "run anything"
  posture, matching the Codex teammate's `Never`. No control-plane handler needed.
  Security meaning is loud and must be opt-in, not a silent default.
- **(C) Allowlist + auto-deny — no prompt tool, rely on `--permission-mode` +
  settings/`--allowedTools`.** Safe (un-allowlisted → auto-denied, surfaced in
  `result.permission_denials`) but restrictive: the teammate cannot do
  un-allowlisted work, silently. Usable as a conservative interim before (A).

**Decision direction:** ship (A) as the structured permission path (PR2c), with
the default policy an explicit, documented choice; (C) is the safe interim while
(A) lands; (B) stays an explicit opt-in. The default-transport switch (PR2d) must
not flip until the chosen posture is implemented and documented — running the
default fleet on accidental auto-deny would silently break teammates.

## The four issue tradeoffs

### Human observability / takeover

This is the **only** dimension where tmux has a real edge, and the edge is "free
client code", not capability. Over stream-json:

- **Live view** is *more* than a pane scrape — the broker already parses
  `stream_event` token-deltas, `assistant` snapshots, and `system/status`; a
  `tm attach` / `tm watch` viewer renders the live turn structured (with token /
  cost / status the pane never had). Until that viewer exists, `tm last` /
  `tm states` give post-hoc visibility.
- **Takeover** is `tm send` (inject a user turn) plus, for a richer client, the
  control plane (`interrupt` to steer, `can_use_tool` answers to approve). The
  first-party IDE integration *is* such a client, so a full keyboard-takeover UX
  is buildable; what is genuinely lost is the **zero-code** form `tmux attach`
  gives for free.
- **tmux retirement criteria (explicit gate).** tmux is **not** describable as
  removable until a minimum-acceptable substitute for each live operator
  capability ships:
  1. a read-write `tm attach` viewer that renders the live turn from
     `stream_event` deltas + `assistant` snapshots;
  2. mid-turn **interrupt / steer** via the `interrupt` control_request;
  3. **permission-prompt handling** in attach (answer a `can_use_tool` from the
     human) — depends on posture (A);
  4. a usable substitute for **shared view + scrollback** (multi-watcher tail of
     the teammate's envelope stream).
  Until all four land, tmux stays as an **optional** human-attach seat — cheap
  insurance and zero-code takeover. It is retired only when the criteria are met,
  not on a fixed release count.

### Resume / lifecycle

Covered under *Lifecycle*: persistent session behind a detached broker;
`session_id` is the resume id, written back to the record each turn;
`--resume <session_id>` relaunches; fork-on-clear updates the record like sid
rotation does today.

### Control-plane stability

See *Stability boundary* above for the full position. In short: the control plane
is the maintained interface the first-party integration and the Agent SDK depend
on, but it is broad (~21 request subtypes) and stateful (pending/cancel/orphan),
and claudemux drives an un-bundled `claude`. So the mitigation is not "avoid it"
but: pin the schema (fail loud on unknown **control** subtypes, forward-tolerant
on unknown **data** envelopes), record a tested-version floor, and **soak the
broker opt-in before the default switch** so drift and failure modes are observed
on real traffic, not assumed away.

### Interactive features (slash commands, REPL affordances)

Headless `-p` is not a TUI, so purely-visual REPL rendering is gone (accepted).
The affordances claudemux drives map cleanly:

| claudemux use | tmux today | stream-json |
|---|---|---|
| turn submit | `send-keys` + `Enter` | `user` message on stdin |
| `/compact` | send `/compact`, scrape refusal | user-message `/compact`; `compact_boundary` confirms |
| `/clear` | send `/clear`, sid rotates | `--fork-session` / new session id; record updates |
| resume | `--resume`/`--continue` at launch | `--resume <session_id>` |
| interrupt / steer | not available | `interrupt` control_request + `control_cancel_request` |
| exit | send `/exit`, watch marker | close stdin or `end_session` |

## Feature support under `-p` — cron, channels, Remote Control

Raised on the issue. Re-verified against the CLI and the first-party
integration's transport; all three are supported under `-p`.

- **cron — `-p` is how cron already runs.** Claude Code's scheduled / cron work
  is executed by spawning `-p` subprocesses (the `--workload` tag exists for
  exactly that). Cron-scheduling tools run in-session like any other tool. A cron
  callback that must wake a **specific persistent teammate** needs that teammate's
  session alive — which the persistent broker provides.
- **channels — a first-class print-mode flag.** `--channels <servers…>`
  registers an MCP server's inbound push notifications with the session and
  **works in print/SDK mode** (`main.tsx:1690`). This is exactly claudemux's
  feishu-channel model (an MCP server delivering `<channel source="feishu">`
  pushes via `deliverToClaude`, `plugins/feishu-channel/src/proxy-client.ts:7-11`,
  `server.ts:520`). The push lands as an unsolicited turn the broker surfaces.
  The earlier "open question" is resolved: channels work headless.
- **Remote Control — enabled over the control plane on the persistent session.**
  In print mode RC is turned on by a `remote_control` control_request; the binary
  then owns the bridge connection, message forwarding, and inbound delivery
  (`print.ts:3892` → `initReplBridge`). The broker's job is to send the enable
  request, stay alive, and surface the unsolicited inbound turns it already
  handles for channels. claudemux ships RC today as `tm spawn --remote-control` →
  `claude --remote-control` on the interactive seat (`spawn.ts:122-125`); the
  stream-json path preserves the capability without tmux.

**Summary.**

| Feature | per-turn `-p` (spike) | persistent broker (default) |
|---|---|---|
| cron | compatible (this *is* cron's mode) | compatible |
| channels (feishu) | n/a (no live session) | compatible — `--channels`, surfaced as unsolicited turns |
| Remote Control | incompatible (no live session) | compatible — `remote_control` control_request + unsolicited turns |

The conclusion the issue asks for: **stream-json plus the control plane is a full
replacement for the tmux bridge, for every teammate, not a subclass.** The only
thing tmux still buys is zero-code human-terminal-attach, which is a convenience
to retire on a timeline, not a capability to preserve.

## PR decomposition

Each PR is self-contained and independently reviewable; later PRs depend on
earlier ones. Integration branch `next`, versioned `3.0.0-beta.0` (major bump —
transport architecture change). Each carries a Changesets fragment for
`@excitedjs/tm`.

**PR1 — protocol layer + per-turn session driver (spike).** A clean-room typed
schema for the data-plane and control-plane envelopes (pinned, fail-loud on
unknown subtype) and a per-turn driver: spawn `claude -p … stream-json …
--resume`, write one user message, parse the stream, resolve a structured
`TurnResult` (text, usage, cost, stop_reason, session_id) on `result`. A
streaming spawn primitive in `proc.ts`. Fixture-replay tests over recorded,
sanitized envelope sequences — no real `claude` binary in CI. A hidden diagnostic
verb (or `CLAUDEMUX_CLAUDE_TRANSPORT=stream-json` gate) to drive one teammate for
a manual fidelity comparison. Not the default; this lands the schema isolation
boundary and proves the protocol.

**PR2 — persistent broker + stream-json as the default transport.** A detached
per-teammate broker (mirroring `codex/supervisor.ts` + registry + socket) holding
the stream-json child, speaking the control plane, and serving ephemeral `tm`
clients. Turn signal / `.last` / usage written to the `/tmp` protocol via the
named builders (hook-independent for this engine). `tm ctx` / `tm last` read
structured fields. Non-blocking permission default with a per-teammate
opt-out. `--channels` passthrough, with the broker surfacing unsolicited push
turns. Resume via `--resume <session_id>`. **stream-json becomes the default seat;
`--seat tmux` is retained as an optional opt-in.** Engine capability record
updated (`events:"push"`, `contextUsage:"rpc-token-usage"`). Fleet verbs and kill
reap the broker.

**PR3 — richer control-plane features and the interactive client.** Remote
Control over the broker (`remote_control` + the inbound path, reusing PR2's
unsolicited-turn handling); the `can_use_tool` allowlist-parity policy; a
read-write `tm attach` viewer (live `stream_event` render + turn injection +
`interrupt`). With PR3 landed, tmux's last unique value (zero-code human attach)
is matched, and the tmux seat can be retired.

**PR4 — #48 reassessment** (below).

Ordering: PR1 → PR2 → PR3, with PR4 fed by PR1/PR2 outcomes. PR1+PR2 already make
stream-json the default transport for every teammate; PR3 closes the
human-attach gap and lets tmux be removed.

## Issue #48 (cross-platform portability) reassessment

#48 tracks Windows / cross-platform seams in the `tm` CLI: POSIX `column`/`grep`,
`/tmp` path assumptions, and tmux / unix-domain-socket dependencies in the
teammate runtime.

With the corrected conclusion (stream-json replaces tmux for *all* teammates, and
tmux is retired after PR3):

- **`tmux` binary dependency — removable.** No teammate needs `tmux`,
  `send-keys`, or `capture-pane` once the stream-json transport is the default and
  the optional tmux seat is retired (PR3). This is a clean removal of a whole
  portability seam, not a per-subclass reduction.
- **unix-domain-socket — relocated, not eliminated.** The broker re-introduces a
  unix socket for ephemeral `tm` to reach it, exactly as the Codex daemon already
  does. So the socket seam remains and is now shared by both non-tmux engines; a
  Windows port must address it once (named pipes / loopback TCP) for both.
- **`/tmp` path assumptions and `column`/`grep`** are transport-independent and
  unaffected — already injectable seams per the #44 review.

**Engineering conclusion: narrow #48 sharply, but do not close it.** stream-json
removes the `tmux` portability seam entirely (the largest one), but the
unix-socket seam survives — relocated to the broker and shared with Codex — and
`/tmp` and `column`/`grep` are untouched. PR4 rewrites #48's scope to: (a) `/tmp`
path abstraction, (b) `column`/`grep` adapters, and (c) the one unix-domain-socket
seam now shared by the Codex daemon and the stream-json broker. A Windows port
still has real work; stream-json removes its single biggest blocker.

## Open questions for review

- **Permission default.** Non-blocking-mode (or auto-allow) default vs
  `can_use_tool` allowlist parity, and the `tm spawn` per-teammate override.
- **tmux retirement timeline.** Retire the optional tmux seat at PR3, or keep it
  one release longer as insurance.
- **Turn-signal path reuse.** Whether the broker reuses the sid-keyed marker
  paths or adds stream-json-keyed builders in `persistence/paths.ts`.
- **Version floor.** Which `claude` version range the pinned control-plane schema
  is tested against, and how drift is surfaced.

## See also

- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the CLI/engine architecture this extends.
- [decisions/multi-engine-tui-architecture.md](/.agents/decisions/multi-engine-tui-architecture.md) — the engine interface and capability model.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` turn-signal protocol the broker must honor.
- [domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md) — the channels delivery design (MCP push, `--channels`-registered).
- [components/hooks.md](/.agents/components/hooks.md) — the hook-driven signal this engine replaces with a broker-written signal.
