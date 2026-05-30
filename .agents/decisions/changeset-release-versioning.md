# Versioning uses official Changesets fragments with direct-push automation

- **Status:** Accepted
- **Date:** 2026-05-21
- **Amended:** 2026-05-29
- **Affects:** repo tooling — `/.changeset/`,
  `plugins/claudemux/package.json`, `.github/workflows/ci.yml`,
  `.husky/pre-commit`, `CLAUDE.md`

## Context

The first version of this decision moved the repo away from "every feature PR
edits the plugin manifest version line" because that model made parallel
feature branches conflict on the same scalar. It introduced a local
changeset/release pair to record per-change semver intent and apply it later.

The conflict analysis still stands, but local release tooling is not the right
long-term owner for fragment parsing, semver arithmetic, changelog writing, or
pre-release channels. Those mechanisms are mature in the official Changesets
toolchain.

## Decision

Use official Changesets for claudemux release intent and versioning.

Claudemux is a plugin, not an npm-published package, so the Changesets package
manifest lives at `plugins/claudemux/package.json`. The Claude Code runtime
manifest remains `plugins/claudemux/.claude-plugin/plugin.json`; after
`changeset version` updates `package.json`, the `version-packages` script
mirrors the version into `.claude-plugin/plugin.json`.

### Feature commits add official Changesets fragments

Authors record claudemux release intent by writing a fragment directly to
`/.changeset/<slug>.md` — do not use the interactive CLI. The fragment
records the package, semver level, and release note text. The feature commit
carries that fragment instead of editing a version field.

### One unified pipeline; the branch fixes the channel

`claudemux-release.yml` publishes per branch by direct push — no intermediate
"Version Packages" PR. The branch fixes the channel; the semver level always
comes from the fragments:

- `main` → stable `X.Y.Z` (on push): `version-packages`
  (`changeset version` + plugin.json sync), commit, push to `main`.
- `next` → beta `X.Y.Z-beta.N` (on push): same `version-packages`; the
  committed `pre.json` on `next` makes `changeset version` emit `-beta.N`.
- any other branch → alpha `X.Y.Z-alpha-<sha>` (manual `workflow_dispatch`
  only — feature pushes never auto-release): `changeset version --snapshot
  alpha`, ephemeral, not pushed. How an alpha is delivered for a marketplace
  (git) plugin is an open decision.

On push the pipeline releases only when the push added a new `.changeset/*.md`
(the bot's own release commit adds none → no-op → loop break). The bot push
runs with `HUSKY=0`, because the local pre-push changeset hook (below) misfires
on a release commit: the bump touches a release-surface file (`package.json`)
whose changeset is already consumed.

### The branch is the channel SoT; pre.json is beta-only

Three channels by fixed branch map: `main`=stable, `next`=beta, any other
branch=alpha. The channel is decided by the branch — not by a single config
file. `pre.json` is **not** the channel source of truth: stable (`main`) and
alpha (feature) both have none, so it cannot distinguish them. `pre.json` exists
only on `next`, to persist the `-beta.N` counter; `main` and feature branches
carry none (alpha is a snapshot).

Branch↔channel alignment is enforced at PR time by the CI
`claudemux-channel-alignment` job (`main` must not be in pre mode; `next` must
be in beta pre mode), so a misaligned merge is blocked before it reaches the
release pipeline. The pipeline itself only publishes — it does not validate.

Entering pre mode (open a beta line on `next`) and exiting it (promote `next`
into `main` for a GA) are deliberate out-of-band `changeset pre enter` /
`changeset pre exit` acts, not per-push pipeline steps. `next` is re-cut from
`main` per major cycle, so its pre base stays current and a GA never
re-consumes shipped changesets.

### Changeset enforcement is CI-owned

The authoritative gate is the CI `claudemux-changeset-status` job: a PR that
touches a release surface without a changeset fails. The local `.husky/pre-push`
hook runs the same check as best-effort fast feedback, but it is advisory — it
does not fire in a fresh clone or worktree that has not run `pnpm install`, and
it is disabled (`HUSKY=0`) in the release job. The release surface for claudemux
is declared in `/.changeset/config.json` with `changedFilePatterns`.

## Why this keeps the version ↔ change mapping

- The semver level is still chosen per change, by the PR author, at PR time.
- The version line moves only in the bot's release commit, so parallel feature
  branches do not collide on it.
- The changelog is generated from the fragments that were actually consumed by
  the release commit.
- Pre-release and GA suffix handling come from Changesets pre mode rather than
  custom semver code.

## Alternatives considered

- **Keep local release scripts.** Rejected: fragment parsing, changelog
  writing, beta suffixes, and release automation are already solved by
  a mature toolchain.
- **Commit-message-driven release tools.** Rejected for claudemux because the
  desired author workflow is an explicit changeset fragment, not Conventional
  Commit inference.
- **Omit the version field entirely.** Rejected: installed users and release
  notes still need a visible semver.
- **Defer release level with no per-change record.** Rejected: it moves the
  breaking-vs-non-breaking judgment away from the author and into release-time
  archaeology.

## Consequences

- `/.changeset/` is now a standard Changesets directory at the workspace
  root, covering both `claudemux` and `claude-channel-feishu`.
- `plugins/claudemux/package.json` is the Changesets source for claudemux
  versioning; `.claude-plugin/plugin.json` is mirrored from it.
- `plugins/claudemux/CHANGELOG.md` is generated by Changesets and starts over
  under the official format. Earlier history remains in git.
- The local pre-commit hook no longer enforces changeset presence. CI owns
  that check.

## References

- `plugins/claudemux/package.json`
- `/.changeset/config.json`
- `plugins/claudemux/scripts/sync-plugin-version.mjs`
- `CLAUDE.md` → "Versioning"; [components/repo-tooling.md](/.agents/components/repo-tooling.md)
