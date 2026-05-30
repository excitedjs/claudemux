# Domain: the cross-process file protocol

This is the contract that couples the two halves of claudemux. `tm` runs
inside the dispatcher; the hooks run inside every teammate. They are
separate processes in separate `tmux` sessions — they **never call each
other**. They communicate entirely through files in well-known locations.

If your task reads or writes any of these files, or changes a `tm`↔hook
seam, read this whole document first.

## Two keying schemes — and why

The protocol uses two namespaces, on purpose:

- **Repo-keyed** — `/tmp/teammate-<repo>.*`. Stable across a teammate's
  whole life. `<repo>` is the sibling directory name. `tm` owns these:
  they are how `tm` finds a teammate given a repo name the user typed.
- **Sid-keyed** — `/tmp/claude-idle/<sid>.*`. Keyed by Claude Code's
  `session_id`. The hooks own these: a hook only knows its own
  `session_id`, never a repo name. A `session_id` rotates on `/clear` and
  `/resume`.

The bridge between the two is `/tmp/teammate-<repo>.sid`, which stores the
current `<sid>` for `<repo>`. `tm` reads it to translate a repo name into
the sid-keyed marker paths the hooks maintain. The `SessionStart` hook
rewrites it when the session_id rotates — without that, `tm states` /
`last` / `wait` would all consult a dead sid.

## The protocol files

### Repo-keyed — `/tmp/teammate-<repo>.*`

| File | Builder (`tm`) | Contents | Writer | Reader |
|---|---|---|---|---|
| `.sid` | `sid_file` | UUID of the active session | `tm spawn`/`resume`; `on-session-start.sh` on rotation | `tm` (every verb, via `resolve_sid`) |
| `.cwd` | `cwd_file` | Physical cwd of the repo at spawn time | `tm spawn` | `on-session-start.sh` (the cwd-match identity gate) |
| `.ready` | `ready_file` | Empty marker — REPL is up | `on-session-start.sh` | `tm spawn` (poll loop) |
| `.send-at` | `send_at_file` | Empty; the *mtime* is the timestamp of the last send | `tm` (`_send_keys`) | `tm` (`_wait_pane_quiet`) |

### Sid-keyed — `/tmp/claude-idle/<sid>.*`

| File | Builder | Contents | Writer | Reader |
|---|---|---|---|---|
| `<sid>` | `idle_marker_for` | Empty marker — the session reached an idle/done event | `on-stop.sh` | `tm` waiting verbs (`send`, `wait`, `compact`, `spawn --prompt`) |
| `<sid>.busy` | `busy_marker_for` | Empty marker — the session is mid-turn | `on-busy.sh` (set), `on-stop.sh` (clear) | `tm` (`pane_busy`, `tm states`) |
| `<sid>.last` | `last_file_for` | Text of the last *assistant* turn | `on-stop.sh` (on `Stop` only) | `tm last`/`send`/`wait`/`states` |

### Other shared paths

| Path | Role |
|---|---|
| `/tmp/claude-idle/_on-stop.log` | `on-stop.sh` diagnostic log, one line per phase per fire |
| `/tmp/claudemux-sid-changes.log` | `on-session-start.sh` audit log of every sid rotation |
| `~/.claude/projects/<encoded>/*.jsonl` | Claude Code session transcripts; `tm history`/`ctx` and explicit-sid `tm resume` parse them |
| `~/.claude/projects/<encoded>/memory/` | AutoMemory; `tm mem` cats a sibling repo's `MEMORY.md` |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Codex thread rollouts; `tm last`/`ctx`/`history` parse them and `tm resume` accepts their thread id |

`/tmp/claude-idle/` files older than 7 days are swept by `on-stop.sh`
(~1/16 of fires, in the background) — `tm kill` only cleans up sessions it
spawned, so ad-hoc and orphaned sessions would otherwise accumulate forever.

## The two invariants this protocol depends on

These are repo-`CLAUDE.md` invariants; they exist *because of* this
protocol, and [decision cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md)
records the drift each one came from.

1. **Path-builder discipline.** Every path above is constructed by a named
   builder function — `sid_file`, `idle_marker_for`, `encode_project_dir`,
   … — never by raw string concatenation at a use site. This protocol is
   *the* coupling layer; spreading its shape across many string literals
   turns the next schema change into an un-atomic multi-file sweep. The
   hooks cannot `source` `tm`, so they re-declare the builders inline — the
   discipline is "a named function at every site", not "one definition".
2. **One source of truth for the project-dir encoding.** The map from a
   teammate cwd to `~/.claude/projects/<encoded>` replaces every `/` *and*
   `.` with `-`. It is an Anthropic-controlled contract. All code routes
   through `encode_project_dir` (and `project_dir_for_repo`); hand-coding
   it has already silently dropped dots and broken `tm resume`.

## Ordering rule inside `on-stop.sh`

`on-stop.sh` writes `<sid>.last` **before** it touches the `<sid>` idle
marker. A `tm` waiter races on the idle-marker touch and then immediately
reads `.last`; doing `.last` first guarantees the waiter never sees the
idle marker without the matching reply already in place.

## Event coverage rule

`on-busy.sh` is bound to all four idle→working events; `on-stop.sh` to all
four working→idle events. The sets are exhaustive on purpose: a `tm wait`
that only woke on `Stop` would hang forever on a `/compact` turn (ends on
`PostCompact`) or an API-error turn (`StopFailure`). See
[decision hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md).

## JSONL cross-check — submit confirmation and the no-hook wait fallback

The hook markers are the primary signal, but `tm send` also reads the
teammate's transcript jsonl directly (`src/engines/claude/turn-jsonl.ts`),
anchored to a byte offset snapshotted at send time so it only ever sees
the region THIS turn appends:

- **Submit confirmation** — after injecting a prompt + Enter, `tm send`
  confirms the REPL accepted it as a turn before committing to the wait:
  the `.busy`/idle marker appeared, or a new `type:"user"` entry landed
  past the offset. If none appears it re-sends Enter (≤3 attempts) and,
  failing that, warns and proceeds — never converting a slow-but-live
  send into a hard failure. This catches the "Enter swallowed by a
  modal" class (the resume-prompt race among them) instead of silently
  waiting to a 124.
- **No-hook wait fallback** — `waitForTurnEnd` unblocks on the idle
  marker OR a settled assistant entry appended past the offset (terminal
  `stop_reason` plus a `text`/`tool_use` block — the same predicate
  `on-stop.sh` applies). A session whose `Stop` hook never loaded still
  ends its wait on disk evidence rather than burning the full timeout.
  It reports which signal ended the turn (`via: 'marker' | 'jsonl'`):
  on `marker` the hook already wrote `<sid>.last` (it writes `.last`
  before touching the idle marker), but on `jsonl` no hook ran, so the
  reply lives only in the transcript.

The wait/confirm reads are a read-only supplement — they write no
protocol files, and when the transcript path cannot be resolved they
no-op, leaving the marker-based behavior exactly as above. The one
write this enables is downstream, in `tm send`: on the `via: 'jsonl'`
path it recovers the reply text from the turn's appended region
(`lastAssistantTextAfter`, scoped to the send offset) and writes it to
`<sid>.last` the same way `tm spawn --resume` seeds it — so stdout and a
later `tm last` / `tm states` all surface the reply instead of the
"(no text reply…)" sentinel. A textless (tool-only) turn writes an empty
`.last`, clearing any stale value.

## See also

- [components/tm.md](/.agents/components/tm.md) — the consumer side.
- [components/hooks.md](/.agents/components/hooks.md) — the producer side.
