# The `next` line replaces `tm` with an MCP-native orchestration core hosting multiple agent families

- **Status:** Superseded by [decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md)
- **Date:** 2026-05-22
- **Affects:** the whole claudemux orchestrator — [`bin/tm`](/plugins/claudemux/bin/tm) (retired), the `hooks/` bundle (kept, behind a driver), a new resident orchestration core. Lands on the **`next`** branch, version line **`1.0.0-beta.0`** (parallel to `main`'s 0.x).

## Context

Today's claudemux drives teammates with [`bin/tm`](/plugins/claudemux/bin/tm)
— a ~2200-line Bash CLI — plus a hook bundle that reconstructs a turn signal
from `/tmp` marker files. That design is correct *for Claude Code*, which
exposes no first-class programmatic control surface; claudemux hand-builds one
from tmux, `tmux send-keys`, and lifecycle hooks.

The goal of hosting **OpenAI Codex** as a teammate breaks that premise. Codex
ships a first-class bidirectional JSON-RPC protocol (`codex app-server`) —
`turn/start`, `turn/interrupt`, `turn/steer`, `turn/completed`, thread
persistence. Everything `tm` hand-rebuilds for Claude Code, Codex provides
natively; forcing Codex through tmux-and-scrape would discard its protocol.

A three-round design debate between two analyst teammates (a claudemux-side
and a Codex-side), each round reviewed by an independent architecture-review
agent, plus a final review of the spec, converged on the architecture below.
This record states *that* it was chosen and the load-bearing rulings. The full
MCP-native design contract was a domain spec retired with this decision — see
[decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) and
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md)
for the architecture that replaced it.

The headline use case that the architecture is tuned for: **Codex as a
cross-model reviewer / advisor** — a different model family's judgement during
plan negotiation and review — not a long-running coding teammate.

## Decision

The `next` line retires `tm` for a **resident, MCP-native orchestration core**
with **per-agent teammate drivers**. The load-bearing rulings:

- **MCP-native core, model-agnostic dispatcher.** The core is a resident
  process exposing an MCP server. Any MCP-host dispatcher connects — the
  dispatcher may be Claude Code *or* Codex; the `main`-line assumption that the
  dispatcher is Claude Code is dropped. The core is not Bash (a Bash process
  cannot be an MCP server or hold resident subscriptions).
- **Per-agent teammate driver.** Claude driver = tmux + hooks + the `/tmp`
  protocol. Codex driver = `codex app-server` (`turn/interrupt`/`turn/steer`
  in v1, `approval_policy: Never`, a light client over the core's residency).
  The core↔driver seam carries no protocol — MCP is the dispatcher↔core face
  only.
- **Asymmetric dispatcher adapter.** A Claude Code dispatcher reaches the core
  through a thin Bash shim — its harness cannot hold a tool call open, so MCP
  is hidden inside one `Bash(run_in_background)` call. A Codex dispatcher
  connects to the core's MCP server directly with a long-poll. One invariant,
  two ends: an agent family is uniform neither as a *server* (→ teammate
  driver) nor as a *host* (→ dispatcher adapter).
- **Completion-awareness = mechanism (a)** — non-blocking MCP verbs plus a
  per-dispatcher harness completion adapter. Mechanism (b) — an MCP push
  notification waking the dispatcher — is **refuted on both agent families**:
  on Claude Code an MCP notification does not wake an idle session
  (`anthropics/claude-code#44380`, open); on Codex the MCP client's
  notifications are log-only with no notification→turn path.
- **Two interaction modes are two call contracts.** *Teammate mode* —
  non-blocking dispatch + asynchronous completion delivery. *Ask mode* —
  blocking call + inline typed return; it is a separate call contract, not a
  lifecycle profile, because a cross-model review is a synchronous data
  dependency whose result must land in the same reasoning context that asked.
- **Failure semantics are core design.** Because an ask-mode reviewer is a
  blocking dependency, the core owns a timeout SLA (typed "reviewer
  unavailable", never a silent hang), exactly-once completion delivery (a
  per-turn delivery token resolving the interrupt/completion race), and
  warm-pool checkout/return discipline. Metrics M1–M5 are specified.
- **Strangler migration, not a flag-day rewrite.** The resident core stands up
  first shelling out to the unmodified `tm`, then verbs migrate into the core
  one at a time against a conformance harness (Phases A–D in the spec). `tm`
  works at every point of the migration.

## Consequences

- **`tm` is retired** as the orchestrator — but only at the *end* of the
  strangler migration; during it, `tm` is a subprocess of the resident core,
  progressively hollowed. The retirement is a destination, not a flag-day.
- **The core is a resident TS/Bun process** — a new long-lived component, the
  first in claudemux that is not a per-invocation CLI. It reuses the
  feishu-channel TS+Bun precedent.
- **The hook scripts stay in Bash** (Claude Code runs them). The `/tmp` marker
  protocol between a resident TS core and the Bash hooks becomes an explicit,
  versioned cross-language IPC contract — the path-builder discipline of
  [decision cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md)
  binds every path in it.
- **The Claude driver's turn-completion signal is lossy, not merely late** —
  `on-stop.sh` carries a documented
  open race (an empty `.last` on a thinking-then-text turn). Metrics must
  measure the Claude driver's `turn/completed` *correctness*, not only its
  latency.
- **A go/no-go gate stands before "Codex as dispatcher":** a Codex dispatcher
  is real for v1 only if it has a working non-blocking completion path
  (verification item V2 in the spec). If V2 fails, v1 ships a Claude Code
  dispatcher only.
- **Enforcement** the implementation must ship: a conformance harness that
  regression-tests each migrated verb against `tm` behavior, behavior-preservingly
  — the lossy turn signal is reproduced, not fixed in passing (Phase B); the
  open verification gates V2 and V3 cleared before the code they gate; the
  M1–M5 metrics, calibrated in the spec phase, then used as measured acceptance
  criteria. There is no `scripts/check.sh`-style mechanical guard for an
  architecture this size — the conformance harness is the guard.
- **Versioning:** this record and the spec are pure docs — no version bump
  ([decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md);
  the `1.0.0-beta.0` number is realized by the release flow when
  implementation lands). The implementation will be feature-class and will
  carry its own changesets.
- The `main` 0.x line and the `next` 1.0-beta line develop in parallel until
  `next` is ready to take over.

## References

- [decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) — the pivot that supersedes this decision: the MCP-native design recorded here was retired in favor of a pure Node CLI, specified in [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md).
- [components/tm.md](/.agents/components/tm.md), [components/hooks.md](/.agents/components/hooks.md) — the components this supersedes / re-homes.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` marker protocol that becomes a versioned cross-language contract.
- [decision hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md), [atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md), [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md), [teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md) — the Claude-side design this builds on and carries forward.
- [decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md) — why this pure-docs change touches no `version` field.
