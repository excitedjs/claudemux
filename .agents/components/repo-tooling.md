# Component: repo tooling

The repo-level scripts, hooks, and CI that keep the codebase consistent.
None of these is shipped inside a plugin — they govern *this repository's*
workflow.

## Files

| Path | Role |
|---|---|
| [`/scripts/check-author`](/scripts/check-author) | Validate one git author email — the single source of truth for the author rule |
| [`/package.json`](/package.json) | pnpm workspace root — declares `packageManager`, root devDeps (`@changesets/cli`, `husky`), and the `prepare` script that installs hooks |
| [`/pnpm-workspace.yaml`](/pnpm-workspace.yaml) | Workspace package list: `plugins/claudemux`, `plugins/feishu-channel` |
| [`/.changeset/config.json`](/.changeset/config.json) | Changesets config: `main` base branch, private package versioning, release-surface globs for claudemux and feishu-channel |
| [`/plugins/claudemux/package.json`](/plugins/claudemux/package.json) | Claudemux package manifest — the `version-packages` release script (`changeset version` + plugin.json sync) |
| [`/plugins/claudemux/scripts/sync-plugin-version.mjs`](/plugins/claudemux/scripts/sync-plugin-version.mjs) | Mirror `package.json.version` into `.claude-plugin/plugin.json.version` after Changesets versions packages |
| [`/.husky/pre-commit`](/.husky/pre-commit) | Husky hook — checks the commit author email via `scripts/check-author` |
| [`/.husky/pre-push`](/.husky/pre-push) | Husky hook — runs `pnpm changeset status --since=origin/main` before push |
| [`/.github/workflows/ci.yml`](/.github/workflows/ci.yml) | CI — changeset-status gate + branch↔channel alignment check (both PR-only) + shellcheck/bats/TypeScript jobs on an Ubuntu/macOS matrix |
| [`/.github/workflows/claudemux-release.yml`](/.github/workflows/claudemux-release.yml) | Unified release pipeline. Branch fixes the channel: `main`→stable, `next`→beta (both auto on push), other branches→alpha (manual `workflow_dispatch` only). Publishes via `version-packages` + direct push (stable/beta) or an ephemeral `--snapshot alpha` |

## Versioning — official Changesets

The repo is a pnpm workspace (`pnpm-workspace.yaml`). Changesets operates
from the workspace root: the config lives at `/.changeset/config.json` and
fragments land in `/.changeset/<slug>.md`.

A feature commit never edits a `version` field. It declares release intent
by writing a fragment directly — do not use the interactive CLI:

```
---
"claudemux": patch
---

<one-paragraph description>
```

For `feishu-channel`, use package name `"claude-channel-feishu"` instead.
Commit the fragment alongside the change. Release automation later runs
`pnpm --dir plugins/claudemux version-packages`, which calls
`changeset version` (walks up to find `/.changeset/`) and then mirrors the
resulting package version into `.claude-plugin/plugin.json`.

Each feature commit therefore adds a new fragment rather than editing the
shared `version` line, so two parallel branches do not collide over versioning.
The per-change semver intent is not lost: the fragment records it, and
Changesets aggregates it (`major` > `minor` > `patch`) and writes it into the
generated changelog. See
[decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md).

`patch` = bug fix, no visible behavior change; `minor` = new
backward-compatible feature; `major` = breaking change to a documented
contract (a CLI flag, a file path, an on-disk format).

What counts as feature-class is per-plugin, because the plugins differ in
shape. The release surface is declared in `/.changeset/config.json` under
`changedFilePatterns`:

- `claudemux` — `bin/`, `hooks/`, `scripts/`, `templates/`, any
  `skills/*/SKILL.md`, `src/**`, `third_party/**`, `resolver.mjs`,
  `resolver-register.mjs`, and `package.json`.
- `claude-channel-feishu` — `src/**`.

Pure-docs commits (README, `CLAUDE.md`, KB files, any `*.md` that is not a
`SKILL.md`), CI/test changes, and manifest description/keyword edits are
**exempt**. The `.agents/` KB is not a feature-class path — KB changes never
need a changeset.

## Local hooks

The repo uses Husky (`/.husky/`) for local git hooks, installed automatically
when `pnpm install` runs the `prepare` script. Two hooks are active:

- **`.husky/pre-commit`** — runs `scripts/check-author` to validate the commit
  author email.
- **`.husky/pre-push`** — runs `pnpm changeset status --since=origin/main` to
  catch missing changeset fragments before a push lands in CI.

On a fresh clone, `pnpm install` sets `core.hooksPath=.husky/_` and installs
both hooks automatically. No manual `git config core.hooksPath` is needed.

## The author-email rule

`scripts/check-author` is the **one** definition of a valid author email,
shared by two callers: the `pre-commit` hook checks the identity the next
commit *would* use; `ci.yml` checks every commit a push or PR introduces. It
rejects an unparseable address or an mDNS/LAN suffix (`.local`,
`.localdomain`, `.lan`, `.home`, `.internal`) — the shape git fabricates as
`whoami@hostname` when `user.email` is unset. Any valid public email
passes; there is no per-person allowlist. See
[decision tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md).

To stop machine-default identities at the root, set once per machine:
`git config --global user.useConfigOnly true`.

## CI

`ci.yml` runs on every push to `main` and every pull request. It has five
jobs:

- **`claudemux-changeset-status`** (pull requests only) — installs the pnpm
  workspace, fetches the PR base, and runs
  `pnpm changeset status --since=origin/<base>` so a feature-class change that
  ships without a changeset fragment fails in CI rather than after merge. It
  runs on PRs into the release branches `main` (stable) and `next` (beta), and
  skips PRs targeting other (alpha) branches as well as the `next -> main`
  promotion (`head=next`).
- **`claudemux-channel-alignment`** (pull requests only) — the branch↔channel
  guardrail. The branch fixes the release channel (`main`=stable, `next`=beta,
  any other base=alpha); this job checks the PR base branch against the
  merge-result's `.changeset/pre.json` (main must not be in pre mode; next must
  be in beta pre mode), so a merge that would put a branch in the wrong channel
  is blocked here rather than misfiring in the release pipeline after merge.
- **`check`** — the Bash surface of the claudemux plugin, on an
  `ubuntu-latest` + `macos-latest` matrix (`fail-fast: false`). Steps: commit
  author check → install `tmux`/`bats`/`shellcheck`/`jq` → `shellcheck` on
  `tm`, the hooks, the scripts, `scripts/check-author`, and the husky hooks →
  the `.agents/` KB structural check (`.agents/scripts/check.sh`) → a
  `setup.sh` conformance check → `bats plugins/claudemux/test/cli/`
  (release-tooling and hook regression tests). The matrix is what makes the
  cross-platform invariant enforceable rather than aspirational.
- **`feishu-channel`** — the `feishu-channel` plugin, on `ubuntu-latest`
  only. It installs pnpm at the workspace root and runs typecheck and tests
  via `pnpm --filter claude-channel-feishu run typecheck` /
  `pnpm --filter claude-channel-feishu run test`. That suite is OS-agnostic
  TypeScript, so one OS is enough; it is a separate job so its toolchain stays
  off the bats lane. A final step runs `test/feishu-live.ts` against the real
  Feishu platform, using the `FEISHU_APP_ID` / `FEISHU_APP_SECRET` repository
  secrets; that test skips itself when the secrets are absent.
- **`claudemux-core`** — the TypeScript orchestration core, on an
  `ubuntu-latest` + `macos-latest` matrix across two Node 22 versions. It
  typechecks, runs a dead-code lint, asserts the vendored Codex protocol
  bindings are not stale, runs the unit + conformance suite, and smoke-tests
  that the `tm` launcher boots with no runtime `node_modules/`. Details are in
  [components/claudemux-core.md](/.agents/components/claudemux-core.md).

## See also

- [decisions/tm-quality-hardening.md](/.agents/decisions/tm-quality-hardening.md) — how CI, tests, and the lint hooks were introduced.
- [decisions/changeset-release-versioning.md](/.agents/decisions/changeset-release-versioning.md) — why versioning moved to Changesets fragments with direct-push beta/GA automation.
- [components/tm.md](/.agents/components/tm.md) — what shellcheck and the bats suite guard.
