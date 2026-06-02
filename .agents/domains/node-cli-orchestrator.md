# Domain: the Node CLI orchestrator

> **Status:** the architecture contract for `tm`, claudemux's Node CLI
> orchestrator. **Decision record:**
> [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md), which supersedes the
> MCP-native design of [mcp-native-orchestration-core](/.agents/decisions/mcp-native-orchestration-core.md).
>
> Read [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) first for *why*
> the resident MCP-native core was dropped; this document is the contract for
> *what replaced it*.
>
> **Versioning:** plugin metadata comes from
> [`plugins/claudemux/.claude-plugin/plugin.json`](/plugins/claudemux/.claude-plugin/plugin.json)
> and [`plugins/claudemux/package.json`](/plugins/claudemux/package.json).
> Feature-class changes still carry changeset fragments as described in
> [decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md).

---

## 1. What this is

claudemux's orchestrator is **`tm`** — the CLI the dispatcher runs to spawn,
message, wait on, inspect, and kill teammates ([components/tm.md](/.agents/components/tm.md)).
`tm` is written in **TypeScript and run on Node** — a command-line tool, not a
resident process and not an MCP server.

[Decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) chose this
shape, retiring the resident MCP-native core that
[decision mcp-native-orchestration-core](/.agents/decisions/mcp-native-orchestration-core.md)
had planned; node-cli-orchestrator carries the rationale. The orchestrator is a CLI: the
dispatcher runs `tm` and reads its result, with no resident process between
them.

Two things define it: the Node/TypeScript implementation (native verbs and a
real test surface) and **Codex as a teammate** (§5). The Claude-teammate
mechanism (§4) is the long-standing one.

---

## 2. The CLI model — stateless per invocation

`tm` is invoked once per command and exits. It holds no state between
invocations and runs no background process of its own.

Every verb is a short-lived process: parse arguments → read the world → act →
print a `{stdout, stderr}` pair and an exit code → exit — the atomic
round-trip verbs and the deliberate stdout/stderr split of
[decision atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md).

The consequence shapes everything below: all cross-invocation state lives
**outside** `tm`, in the stores of §3. `tm` is the code that reads and mutates
those stores; it is never their owner and never their cache.

---

## 3. Where the state lives

| Store | Holds | Owner |
|---|---|---|
| **tmux sessions** | each Claude teammate's live `claude` REPL — one session per repo | tmux |
| **the `/tmp` file protocol** | the BUSY/idle turn signal, sid files, the cwd / ready / send-at markers | the hooks and `tm` jointly — see [cross-process-protocol](/.agents/domains/cross-process-protocol.md) |
| **`~/.claude/projects/<encoded>/`** | each teammate's transcripts and auto-memory | Claude Code |
| **the Codex `app-server` daemon** | each Codex teammate's persisted thread(s) | a `codex app-server` process claudemux spawns (§5) |
| **the Codex-daemon process registry** | each spawned `app-server`'s socket path, pid, and last-seen liveness | `tm` (§5) |
| **`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`** | each Codex thread's append-only rollout log, including assistant text, token counts, and recent activity mtime | Codex CLI |

A `tm` invocation reconstructs everything it needs from these stores on every
call. There is no in-memory teammate registry; the live teammate set is
enumerated from tmux for Claude teammates and from the daemon process registry
for Codex teammates.

---

## 4. The Claude teammate driver — stream-json broker

> **Changed in 3.0.0-beta.0 (issue #49).** The Claude engine was driven through
> a tmux REPL (`tmux send-keys` for input, `capture-pane` + the hook bundle for
> output/turn state). That bridge is removed; the driver below replaces it. The
> design and trade-offs are in the
> [Claude stream-json transport proposal](/.agents/proposals/claude-stream-json-transport.md).

A Claude teammate is a persistent `claude -p --output-format stream-json
--input-format stream-json --verbose` child held by a **detached per-teammate
broker** (`src/engines/claude/stream-json/`), launched in the teammate's cwd.
`tm` is stateless and ephemeral, so the broker outlives any one `tm` call — the
same detached-supervisor shape as the Codex daemon (§5). `tm` reaches the broker
over a per-teammate unix socket (`claudeStreamSocket(name)`); the broker
demultiplexes the child's stdout envelopes through a forward-tolerant parser,
drives one turn at a time, and resolves a structured `TurnResult` (text, usage,
cost, stop_reason, session_id) from the `result` envelope — no pane scraping.

The broker is the **sole owner** of the `/tmp` turn signal the fleet verbs read
(`<sid>` idle / `<sid>.busy` / `<sid>.last`), written through the same named path
builders the hooks used to. The hook bundle is removed
([components/hooks.md](/.agents/components/hooks.md)); the path-builder and
cross-platform discipline of
[decision cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md)
still binds every `/tmp` path. Turn completion is the explicit `result`
envelope, not an inferred marker, so the empty-`.last` race the hook driver had
no longer applies.

The broker re-enters `tm`'s own entrypoint under the hidden `__claude-broker`
subcommand, reconstructed from `process.execArgv` + `process.argv[1]`, so it runs
under the identical Node runtime as `tm` (type-stripped source or `dist/tm.mjs`).
Remote Control is enabled by the broker sending a `remote_control` control
request and surfacing the returned claude.ai session URL; the broker tolerates
the unsolicited turns RC and channels inject.

---

## 5. The Codex teammate driver — `codex app-server`

Codex ships a first-class bidirectional JSON-RPC protocol, `codex app-server`
(`turn/start`, `turn/interrupt`, `turn/steer`, `turn/completed`, thread
persistence). A Codex teammate uses it directly — no tmux, no screen-scraping.

- **Transport.** claudemux spawns `codex app-server --listen unix://<path>`
  itself, **detached**, and connects with a **WebSocket JSON-RPC client**. The
  `daemon` and `proxy` subcommands were evaluated and rejected
  ([node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md)): `daemon` requires
  an OpenAI-hosted installation; `proxy` is a raw byte tunnel and cannot carry
  the `app-server` listen socket, which itself speaks WebSocket frames.
- **`approval_policy: Never`.** A claudemux teammate runs unattended; the
  non-interactive posture is a requirement of being a teammate — the same
  reasoning as [decision teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md),
  generalized from Claude to Codex.
- **Process supervision.** The `app-server` is long-lived and outlives any
  single `tm` invocation — the daemon's thread state *is* the Codex teammate.
  With no resident process to hold it, `tm` owns the daemon lifecycle through
  the **Codex-daemon process registry** (§3): a filesystem file set recording
  each daemon's socket path, pid, and last-seen liveness. Each `tm` invocation
  that targets a Codex teammate reads the registry, checks the daemon is alive,
  spawns or restarts it if not, connects, runs its verb, and exits. The daemon
  persists; the `tm` process is ephemeral.
- **Codex UI IPC bridge.** After a Codex teammate daemon is ready, claudemux
  starts an optional bridge process for that teammate. The bridge connects to
  the Codex.app / VS Code UI bus at `${TMPDIR}/codex-ipc/ipc-$(id -u).sock`
  when the socket exists; if no UI is running, it quietly retries. The bridge is
  not a replacement for the teammate app-server. It keeps a separate
  app-server connection, broadcasts `thread-stream-state-changed` snapshots for
  the active thread, rebroadcasts when new UI clients connect, and proxies
  supported `thread-follower-*` requests back to the same per-teammate
  app-server. Its pid and logs live beside the daemon registry as
  `ipc-bridge.pid`, `ipc-bridge.stdout.log`, and `ipc-bridge.stderr.log`, and
  `tm kill` reaps it with the daemon.
- **Liveness surfaces.** `tm status`, `tm ls`, and `tm states` combine the
  registry's pid/socket record, a short socket reachability probe, the Codex
  `thread/read` status when available, and the current thread's rollout mtime.
  STATE is `borrowed` when a `tm` process has borrowed the daemon for an
  in-flight turn, `busy` when the thread is active or the rollout file was
  modified inside the short activity window, `idle` when the daemon is alive
  and available, and `unknown` when reachability is inconclusive. In the
  states table, Codex LAST / PREVIEW come from the current thread's latest
  assistant text in the rollout JSONL, matching Claude's `.last`-backed row
  semantics.
- **Durable inspection.** `tm last` reads the latest assistant final answer or
  commentary from the current thread's rollout JSONL. `tm ctx` reads the latest
  token-count event from the same rollout file and reports used tokens,
  context-window tokens, and percentage. `tm history` is flag-only and merges
  the forward tm-owned history index with Codex rollouts and Claude transcripts
  into bounded JSON by default; rows carry full ids and a `resumeCommand` when
  repo/cwd and engine anchors are known.
- **Thread resume.** `tm resume <name> [<thread-id>]` for Codex starts a fresh
  per-teammate `app-server`. With an explicit thread id it writes that id back
  to `/tmp/teammate-codex/<name>/thread` and calls `thread/resume`; with no id
  it first asks Codex for `thread/list(limit=1, sortKey=updated_at, cwd=<repo>)`
  and then resumes the returned latest thread. When `tm kill` has removed the
  base identity record for a non-`codex-*` name and the user passes an explicit
  thread id, the resume verb uses the matching rollout filename under
  `~/.codex/sessions/YYYY/MM/DD/` as the durable hint that the checkpoint
  belongs to Codex.
- **Schema pinning.** `codex app-server` is marked `[experimental]` end to end,
  and its JSON-RPC messages omit the `jsonrpc` version field — they are not
  strict JSON-RPC 2.0. The WebSocket client pins the message schema explicitly
  and ships schema tests, so an upstream protocol change fails loudly at a
  known seam rather than corrupting a turn silently.

---

## 6. Two interaction modes — teammate and ask

Codex is hosted in two modes — two distinct call contracts that share the §5
driver:

- **Teammate mode** — a hosted, long-running teammate, dispatched and waited on
  like a Claude teammate.
- **Ask mode** — Codex as a **cross-model reviewer / advisor**: a blocking call
  that returns a structured result inline, for a `/simplify` reviewer or a
  second opinion during plan negotiation. This is the headline use case the
  Codex integration is tuned for.

Ask mode wants structured output (`app-server`'s `output_schema`), model and
effort selection, and a fast cold start — keep an `app-server` warm rather than
paying a REPL boot per ask. The detailed two-mode design lives with the Codex
driver ([decision codex-driver](/.agents/decisions/codex-driver.md)); it is
recorded here so the driver serves both modes.

---

## 7. Completion-awareness

"The teammate's turn finished" reaches the dispatcher like this: a `tm` atomic
verb (`spawn` / `send` / `wait` / …) blocks until the turn signal fires, then
prints the teammate's reply. The dispatcher issues that `tm`
call inside `Bash(run_in_background)` so its own agent loop is not frozen, and
the harness's task-notification wakes it when `tm` exits.

- For a **Claude teammate** the turn signal is the `/tmp` idle marker the hooks
  write (§4).
- For a **Codex teammate** it is the `app-server` `turn/completed` event,
  observed by the blocking `tm` process over its WebSocket connection to the
  daemon.

[Decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) records why
this is the model rather than an MCP push notification.

---

## See also

- [decisions/node-cli-orchestrator.md](/.agents/decisions/node-cli-orchestrator.md) — the decision and the *why*.
- [decisions/mcp-native-orchestration-core.md](/.agents/decisions/mcp-native-orchestration-core.md) — the superseded MCP-native design.
- [components/tm.md](/.agents/components/tm.md) — the `tm` CLI.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the TypeScript orchestration code and its current modules.
- [components/hooks.md](/.agents/components/hooks.md), [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the Claude driver's `/tmp` protocol.
- [decision atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md), [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md), [teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md) — foundational `tm` design decisions.
