# Decision records

This directory holds claudemux's **decision records** — the *why* behind the
system's shape. Each record captures one design choice: the situation that
forced it, the choice made, and what the choice now costs or constrains. A
future agent reads these to avoid re-litigating a settled question.

## Browse by theme

A discovery layer grouped by topic. The [Index below](#index) is the
canonical, `check.sh`-enforced register (every record, alphabetical, with
status); these groups just make a topic easier to find. *(superseded)* marks a
record kept for history — open it and follow its Status link to the current one.

**Foundational & orchestration model**
- [dispatcher-teammate-model](/.agents/decisions/dispatcher-teammate-model.md) — the dispatcher + per-repo `tmux` teammate model (the architecture origins)
- [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) — the 1.0 line is a pure Node `tm` CLI, not a resident MCP core
- [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) — the `Engine` interface reshape so a new engine/TUI slots in
- [mcp-native-orchestration-core](/.agents/decisions/mcp-native-orchestration-core.md) — *(superseded)* the original resident MCP-native core

**Runtime & packaging**
- [zero-install-type-stripping](/.agents/decisions/zero-install-type-stripping.md) — run TypeScript directly, vendor `ws`, zero install
- [node-cli-committed-bundle](/.agents/decisions/node-cli-committed-bundle.md) — *(superseded)* the committed esbuild bundle

**`tm` verbs, cross-process protocol & teammate lifecycle**
- [atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md) — atomic round-trip verbs with a stdout/stderr split
- [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md) — path-builder + cross-platform invariants (promoted into `CLAUDE.md`)
- [hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md) — BUSY/idle from hooks, not pane scraping
- [teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md) — teammates launch with `AskUserQuestion` disabled
- [worktree-default-and-name-repo-decoupling](/.agents/decisions/worktree-default-and-name-repo-decoupling.md) — worktree-by-default; teammate `name` decoupled from the repo path

**Codex engine**
- [codex-driver](/.agents/decisions/codex-driver.md) — the Codex teammate driver (vendored protocol, FS supervision, ask-mode borrow)
- [codex-engine-flag](/.agents/decisions/codex-engine-flag.md) — *(superseded)* the `tm spawn --engine` flag

**Feishu channel**
- [feishu-channel-plugin](/.agents/decisions/feishu-channel-plugin.md) — a separate TypeScript plugin shipped from this repo
- [feishu-channel-event-registry](/.agents/decisions/feishu-channel-event-registry.md) — an extensible per-event handler registry
- [feishu-channel-group-pairing](/.agents/decisions/feishu-channel-group-pairing.md) — group authorization by @-mention pairing
- [feishu-channel-group-policy-modes](/.agents/decisions/feishu-channel-group-policy-modes.md) — the three-mode `groupPolicy` switch
- [feishu-channel-launch-without-session-proxy](/.agents/decisions/feishu-channel-launch-without-session-proxy.md) — the MCP server launched with the session proxy cleared
- [feishu-channel-orphan-detection-by-stdin-eof](/.agents/decisions/feishu-channel-orphan-detection-by-stdin-eof.md) — exited-parent detection by stdin EOF
- [feishu-channel-received-reaction-indicator](/.agents/decisions/feishu-channel-received-reaction-indicator.md) — the received-reaction indicator on inbound messages
- [feishu-channel-bot-discovery](/.agents/decisions/feishu-channel-bot-discovery.md) — auto-discovery of peer bots' Open IDs, one-shot injection, gate kept separate
- [feishu-doc-comment-enrichment](/.agents/decisions/feishu-doc-comment-enrichment.md) — SDK decode + fetched text/title enrichment
- [feishu-doc-comment-fetch-via-batch-query](/.agents/decisions/feishu-doc-comment-fetch-via-batch-query.md) — comment text via `fileComment.batchQuery`
- [feishu-worker-scoped-subscription](/.agents/decisions/feishu-worker-scoped-subscription.md) — Worker-scoped subscription via a co-hosted holder

**Release, quality & testing**
- [changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md) — versioning via changeset fragments consumed by a release step
- [npm-oidc-trusted-publishing](/.agents/decisions/npm-oidc-trusted-publishing.md) — `@excitedjs/tm` publishes to npm via OIDC trusted publishing; three in-repo preconditions each break it with a different misleading error
- [tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md) — CI, bats tests, lint, shared path/encoding helpers
- [live-teammate-integration-harness](/.agents/decisions/live-teammate-integration-harness.md) — live-teammate integration tests + directory-trust seeding

**Knowledge-base process**
- [research-hazard-dispositions](/.agents/decisions/research-hazard-dispositions.md) — every research hazard reaches a recorded disposition

## Index

Records are listed alphabetically by topic slug. There is no numbering — the
filename *is* the identifier — so two records added on parallel branches
never collide on a sequence number.

| Topic | Decision | Status |
|---|---|---|
| [atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md) | `tm`'s high-frequency verbs are atomic round-trips with a stdout/stderr split | Accepted |
| [changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md) | Versioning moves to changeset fragments consumed by a release step, so parallel PRs never collide on the version line | Accepted |
| [codex-driver](/.agents/decisions/codex-driver.md) | Codex teammates ship as a `codex-` prefixed driver with a vendored protocol schema, FS-backed supervision, and an ask-mode borrow on the named pool | Accepted |
| [codex-engine-flag](/.agents/decisions/codex-engine-flag.md) | The codex teammate kind moves from a `codex-` name prefix to an explicit `tm spawn --engine` flag, with one-minor deprecation | Superseded by [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) |
| [cross-process-cross-platform-invariants](/.agents/decisions/cross-process-cross-platform-invariants.md) | Three cross-process / cross-platform invariants were promoted into `CLAUDE.md` | Accepted |
| [dispatcher-teammate-model](/.agents/decisions/dispatcher-teammate-model.md) | The foundational architecture — a dispatcher session orchestrating per-repo `tmux` `claude` teammates via `tm`, chosen over Agent Teams (no cwd pin, no per-repo memory); the dispatcher role grew from launcher to coordinator | Accepted |
| [feishu-channel-bot-discovery](/.agents/decisions/feishu-channel-bot-discovery.md) | Peer bots' Open IDs are auto-discovered from messages + `/introduce`, surfaced via a one-shot baseline/delta and an MCP query tool; observing never widens the access gate | Accepted |
| [feishu-channel-event-registry](/.agents/decisions/feishu-channel-event-registry.md) | The Feishu channel handles events through an extensible registry of per-event handlers | Accepted |
| [feishu-channel-group-pairing](/.agents/decisions/feishu-channel-group-pairing.md) | A Feishu group is authorized by pairing — an @-mention posts a code the operator approves | Accepted |
| [feishu-channel-group-policy-modes](/.agents/decisions/feishu-channel-group-policy-modes.md) | Feishu group access is a three-mode `groupPolicy` switch — block / allowlist (decision feishu-channel-group-pairing) / follow-user | Accepted |
| [feishu-channel-launch-without-session-proxy](/.agents/decisions/feishu-channel-launch-without-session-proxy.md) | The Feishu channel's MCP server is launched with the session HTTP proxy cleared | Accepted |
| [feishu-channel-orphan-detection-by-stdin-eof](/.agents/decisions/feishu-channel-orphan-detection-by-stdin-eof.md) | The Feishu channel detects an exited parent by stdin EOF, not by polling `process.ppid` | Accepted |
| [feishu-channel-plugin](/.agents/decisions/feishu-channel-plugin.md) | A Feishu channel ships as a separate TypeScript plugin from this repo | Accepted |
| [feishu-channel-received-reaction-indicator](/.agents/decisions/feishu-channel-received-reaction-indicator.md) | The Feishu channel marks an inbound chat message with a reaction when it reaches the session, and clears it on reply | Accepted |
| [feishu-doc-comment-enrichment](/.agents/decisions/feishu-doc-comment-enrichment.md) | The Feishu doc-comment handler decodes via the SDK and enriches the event with fetched text and title | Accepted |
| [feishu-doc-comment-fetch-via-batch-query](/.agents/decisions/feishu-doc-comment-fetch-via-batch-query.md) | Feishu doc-comment text is fetched with `fileComment.batchQuery`, since `get` does not serve local-selection comments | Accepted |
| [feishu-worker-scoped-subscription](/.agents/decisions/feishu-worker-scoped-subscription.md) | Feishu Worker-scoped subscription routes through a single-app co-hosted holder onto a pure-derived workspace identity | Accepted |
| [hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md) | BUSY/idle detection is driven by Claude Code hooks, not pane scraping | Accepted |
| [live-teammate-integration-harness](/.agents/decisions/live-teammate-integration-harness.md) | Live-teammate integration tests seed directory trust by a targeted `~/.claude.json` write | Accepted |
| [mcp-native-orchestration-core](/.agents/decisions/mcp-native-orchestration-core.md) | The `next` line replaces `tm` with an MCP-native orchestration core hosting multiple agent families | Superseded by [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) |
| [multi-engine-tui-architecture](/.agents/decisions/multi-engine-tui-architecture.md) | The Node core is reshaped around an `Engine` interface, a single per-teammate JSON record, and an `engines/<kind>/` layout so a third TUI slots in without forking the verb layer | Accepted |
| [node-cli-committed-bundle](/.agents/decisions/node-cli-committed-bundle.md) | `tm` ships as a committed esbuild bundle + thin Node launcher | Superseded by [zero-install-type-stripping](/.agents/decisions/zero-install-type-stripping.md) |
| [node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) | The 1.0 line retires the MCP-native core for a pure Node `tm` CLI | Accepted |
| [npm-oidc-trusted-publishing](/.agents/decisions/npm-oidc-trusted-publishing.md) | `@excitedjs/tm` publishes to npm via OIDC trusted publishing; three in-repo preconditions (no setup-node `registry-url`, workflow-level `id-token: write`, a `repository` field) each break publishing with a different misleading error | Accepted |
| [research-hazard-dispositions](/.agents/decisions/research-hazard-dispositions.md) | Every research hazard reaches a recorded disposition before it leaves the research layer | Accepted |
| [teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md) | Teammates launch with the `AskUserQuestion` tool disabled | Accepted |
| [tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md) | `tm` was hardened with CI, bats tests, lint, and shared path/encoding helpers | Accepted |
| [worktree-default-and-name-repo-decoupling](/.agents/decisions/worktree-default-and-name-repo-decoupling.md) | Schema 2 cut: every teammate launches inside a git worktree by default, and the teammate `name` is a flat opaque identifier independent of the repo path | Accepted |
| [zero-install-type-stripping](/.agents/decisions/zero-install-type-stripping.md) | `tm` runs TypeScript sources directly under Node `--experimental-transform-types`; `ws` is vendored under `core/third_party/` so there is no `npm install` and no build step | Accepted |

## When to add a record

Add a record when a task settles a design question that the next agent
could otherwise re-debate: a trade-off, a reversal, a contract choice, or a
"we tried X and chose Y" outcome. A routine bug fix does not warrant a
record. See [rules/knowledge-maintenance.md](/.agents/rules/knowledge-maintenance.md).

## Adding a new record

There is no numeric sequence to claim, so a new record is just a new file
plus the index row. Follow these steps in order so the result lands valid
on the first run of `scripts/check.sh`:

1. Pick a descriptive kebab-case topic slug — the slug *is* the identifier;
   choose it so the filename alone tells a future reader what the decision
   is about.
2. Confirm the slug is free: `ls .agents/decisions/`. If a file with the
   same name already exists, pick a more specific slug rather than
   appending a suffix; collisions usually mean the topic was already
   decided.
3. Create `.agents/decisions/<topic-slug>.md` from the skeleton below and
   fill it in.
4. Insert a row into the `## Index` table above, keeping the table
   alphabetically sorted by slug (link target
   `/.agents/decisions/<topic-slug>.md`), and slot the record into the matching
   group under `## Browse by theme`. The Index is the canonical,
   `check.sh`-enforced register; the theme groups are a discovery aid.
5. If the new record supersedes an existing one, edit the superseded
   record's `**Status:**` line to point at the new file. The link to the
   real file is mandatory so a future agent does not have to grep for it:

   ```
   Superseded by [<topic-slug>](/.agents/decisions/<topic-slug>.md)
   ```
6. Run `bash .agents/scripts/check.sh`. The script verifies that the
   decisions directory and this README index agree, that no link is
   broken, and that no `decision NNNN` reference snuck in.

## Format

Name the file with a descriptive kebab-case topic slug — `topic-slug.md` —
chosen so the slug alone tells a future reader what the decision is about.
Use this skeleton:

```
# Short title

- **Status:** Accepted | In progress | Superseded by <topic-slug>
- **Date:** YYYY-MM-DD (or a range)
- **Affects:** the components this touches

## Context
The forces in play — what made a decision necessary.

## Decision
What was chosen, stated plainly.

## Consequences
What this now costs, constrains, or enables. Include the foot-guns.

## References
Commit hashes, files, related decision records.
```

When a record promotes a hazard into a binding constraint, its
**Consequences** names the enforcement that prevents silent regression — a
guard test, a hook, or a `scripts/check.sh` rule — or states why none is
mechanically possible. See [the research-hazard-dispositions decision](/.agents/decisions/research-hazard-dispositions.md).

Records are **append-only history**. When a decision is later overturned,
do not edit or delete the old record — add a new one and set the old
record's status to a Markdown link pointing at the new record:

```
Superseded by [<topic-slug>](/.agents/decisions/<topic-slug>.md)
```

The link is mandatory; it is the only thread connecting the two records,
since there is no sequence number to follow.
