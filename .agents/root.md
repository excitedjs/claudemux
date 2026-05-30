# claudemux — Agent Knowledge Base

This is the `.agents/` knowledge base for **claudemux**. It records the
background, architecture, and decisions a future agent needs to work in this
repo but cannot quickly reconstruct from the code alone. Read this file
first, then route to the component, domain, or decision document that
matches your task.

## What this KB is — and is not

- The repo-root `CLAUDE.md` holds the **binding repository instructions**:
  audience boundaries for every Markdown surface, the cross-process /
  cross-platform invariants, the versioning rule, and the commit-author
  rule. It is always loaded. When this KB and `CLAUDE.md` disagree,
  `CLAUDE.md` is authoritative and this KB has drifted — fix the KB.
- This KB is the **navigation, architecture, and decision layer** on top of
  `CLAUDE.md`. It explains how the pieces fit, why they are shaped the way
  they are, and where to start for a given task. It is read on demand.
- The KB never copies a contract that already lives in an executable. The
  source of truth for `tm`'s verbs is `tm --help`; for the plugin version,
  `plugins/claudemux/.claude-plugin/plugin.json`; for hook wiring,
  `plugins/claudemux/hooks/hooks.json`. The KB points at these and explains
  the surrounding mechanics.

## What claudemux is

claudemux is a **multi-repo Claude Code orchestrator**, shipped as a Claude
Code plugin. The model:

- A **dispatcher** — one Claude Code session running in the parent directory
  of several sibling git repos. It talks to the user and routes work. It is
  not a product repo; it is a coordination workspace.
- A **teammate** per repo — a real `claude` REPL living in its own `tmux`
  session, with its working directory set to that repo.
- The **`tm` CLI** — the bash script the dispatcher uses to spawn, message,
  wait on, inspect, and kill teammates.
- The **hook bundle** — three hook scripts that fire on every Claude Code
  session and maintain a file-based BUSY/idle signal that `tm` blocks on.
- Two **skills** — `dispatcher` (the teammate-coordination operations
  manual) and `optimize` (periodic self-review of the dispatcher's own
  history).

The user orchestrates the whole fleet in plain language; the `dispatcher`
skill turns that language into `tm` calls.

The central coupling is that `tm` (run inside the dispatcher) and the hooks
(run inside every teammate) never call each other directly — they
communicate **only through files** under `/tmp`. That file protocol is the
heart of the system; see [the cross-process protocol](/.agents/domains/cross-process-protocol.md).

## Repository layout

| Path | What it is |
|---|---|
| `plugins/claudemux/` | The claudemux plugin: `bin/tm`, `src/` (the TypeScript CLI), `third_party/` (vendored `ws`), `hooks/`, `skills/`, `templates/`, `commands/`, `test/` |
| `plugins/feishu-channel/` | Second plugin — a Feishu channel for Claude Code (TypeScript on Node), shipped independently from this repo |
| `scripts/` | Repo-level governance scripts — `check-author` (the author-email rule, shared with CI) |
| `.github/workflows/ci.yml` | CI — shellcheck + bats for the Bash surface, plus pnpm/Node jobs for the TypeScript core and feishu-channel |
| `.claude-plugin/marketplace.json` | Marketplace manifest listing the plugins |
| `.agents/` | This knowledge base |

## Navigate the KB

**Components** — start here when your task touches one piece of the system:

| Working on | Read |
|---|---|
| The `tm` CLI — verbs, helpers, dispatch | [components/tm.md](/.agents/components/tm.md) |
| The hook scripts — BUSY/idle signal, sid rotation | [components/hooks.md](/.agents/components/hooks.md) |
| The `dispatcher` skill, its references, the dispatcher template, `/claudemux:setup` | [components/dispatcher-skill.md](/.agents/components/dispatcher-skill.md) |
| The `optimize` skill — periodic dispatcher self-review | [components/optimize-skill.md](/.agents/components/optimize-skill.md) |
| The `feishu-channel` plugin | [components/feishu-channel.md](/.agents/components/feishu-channel.md) |
| The orchestration core — the `tm` CLI's TypeScript modules, the Claude/Codex engines, persistence and identity | [components/claudemux-core.md](/.agents/components/claudemux-core.md) |
| Repo tooling — versioning, lint, CI, tests | [components/repo-tooling.md](/.agents/components/repo-tooling.md) |

**Domains** — cross-cutting contracts that span more than one component:

| Working on | Read |
|---|---|
| Anything that reads or writes a `/tmp` protocol file, or a `tm`↔hook seam | [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) |
| The Feishu Worker-scoped subscription design — holder/endpoint split, the `routes/`+`inbox/` protocol | [domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md) |
| The Node CLI orchestrator — the CLI model, the Claude and Codex teammate drivers, and the architecture contract | [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) |

**Decisions** — why the system is shaped the way it is:

- **Start here for the design intent.** [dispatcher-teammate-model](/.agents/decisions/dispatcher-teammate-model.md) is the foundational record — *why* claudemux is a dispatcher orchestrating per-repo `tmux` teammates rather than using Agent Teams. The other load-bearing *why*s: [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) (why a Node CLI, not a resident MCP core), [zero-install-type-stripping](/.agents/decisions/zero-install-type-stripping.md) (why zero-dependency, `ws` vendored), [hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md) (why the turn signal is hook-driven), and [atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md) (why the verb contract is shaped this way).
- [decisions/README.md](/.agents/decisions/README.md) — the full register of decision records (browsable **by theme** and alphabetically) and how to add one.

**Research archive** — the investigation behind the decisions:

- [research/index.md](/.agents/research/index.md) — frozen, point-in-time research snapshots (Feishu channel survey, `tm` architecture audits). Read them as history: dated, not maintained, and not authoritative where they disagree with a decision record.

**Proposals** — current design proposals that have not become decisions:

- [Codex multi-client live sync](/.agents/proposals/codex-multiclient-live-sync.md) — options for making claudemux Codex teammates visible to Desktop and VS Code clients.
- Archived input drafts also live under `proposals/` — the two multi-engine architecture drafts and the phase-1 bug audit — reachable from the decision they fed, [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md). Each carries a status banner.

**Rules & meta:**

- [CONTRIBUTING.md](/.agents/CONTRIBUTING.md) — how to use and extend this KB; the knowledge-delta protocol.
- [rules/knowledge-maintenance.md](/.agents/rules/knowledge-maintenance.md) — when a future agent must update the KB.

## Before you finish a task

Run the knowledge-delta check (see [CONTRIBUTING.md](/.agents/CONTRIBUTING.md)): if your change moved a component boundary, the cross-process protocol, the `tm` verb set, hook wiring, or recorded a non-obvious decision, update the matching KB document in the same change. Then run `bash .agents/scripts/check.sh` to confirm no links broke.
