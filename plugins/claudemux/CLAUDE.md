# claudemux plugin — dev entry

The multi-repo orchestrator: a **dispatcher** Claude session drives one **teammate** `claude` per repo through the **`tm` CLI**. The Claude engine drives each teammate over a **stream-json stdio broker** — a persistent `claude -p --input-format stream-json` child held by a detached per-teammate broker that `tm` reaches over a unix socket (issue #49). The Codex engine has its own daemon. A thin bash launcher fronts the Node CLI.

Depth lives in the KB (repo-root `.agents/`, not shipped to users): start at `.agents/root.md`, then the matching `components/*.md` / `domains/*.md`. This file is the entry index — the per-dir map plus the traps that bite when editing here. It deliberately does not restate the KB.

## Where things live (this plugin dir)

- `bin/tm` — thin bash launcher; in a source plugin checkout it execs `node` against `src/main.ts` under `--experimental-transform-types` (no build step, no `node_modules`); in an npm package install it delegates to `dist/tm.mjs`.
- `src/` — the `tm` CLI source: verbs, dispatch, help, the Claude and Codex engines, persistence, identity. The Claude stream-json transport lives in `src/engines/claude/stream-json/` (protocol, broker, client, registry, launch, wire). → `.agents/components/tm.md`, `.agents/components/claudemux-core.md`.
- `skills/dispatcher/SKILL.md` — teammate-coordination ops manual (the verbs the dispatcher drives); `skills/optimize/SKILL.md` — periodic dispatcher self-review.
- `commands/setup.md` + `scripts/setup.sh` + `templates/CLAUDE.md.template` — the `/claudemux:setup` onboarding flow and the dispatcher seed.

## The load-bearing seam (read before touching `/tmp` or a `tm`↔broker path)

`tm` is stateless and ephemeral; the Claude teammate's persistent stream-json session lives behind a **detached broker** that outlives any one `tm` call. `tm` reaches it over the per-teammate unix socket (`claudeStreamSocket`), and the broker writes the `/tmp` turn signal (`<sid>` idle / `<sid>.busy` / `<sid>.last`) the fleet verbs read — it is the signal's sole owner (the old hook bundle that wrote it is removed). Every protocol path comes from a named builder; the project-dir encoding has one source of truth. → `.agents/domains/cross-process-protocol.md`; the binding form is in the repo-root `CLAUDE.md`.

## Traps (won't infer these from the code)

- **A spawned teammate shields the dispatcher's `CLAUDE.md`** — the broker launches `claude --settings` with a `claudeMdExcludes` list, so the teammate loads its own repo's `CLAUDE.md`, never the dispatcher's. (Mechanism: `src/engines/claude/stream-json/launch.ts` — `teammateSettingsJson` / `buildClaudeArgs`.)
- **The broker re-enters `tm`'s own entrypoint** under the hidden `__claude-broker` subcommand (`src/main.ts`), reconstructed from `process.execArgv` + `process.argv[1]`, so it inherits the same Node runtime (type-stripped source or `dist/tm.mjs`) with no second launcher.
- **Teammate permission posture is `--dangerously-skip-permissions`** — an unattended teammate has no human at a prompt; a non-bypass headless session would auto-deny any un-allowlisted tool and silently stall. Matches the Codex `Never` posture.

## Versioning

A feature change to `bin/*`, `hooks/*`, `scripts/*`, `templates/*`, a `skills/*/SKILL.md`, or the `src/` CLI source needs a Changesets fragment for `@excitedjs/tm`, not a `version` edit. KB and docs are exempt. → repo-root `CLAUDE.md`, `.agents/components/repo-tooling.md`.

## Update this file when

A component boundary in this dir shifts, the `/tmp` seam changes, the spawn-shield or identity-gate mechanism changes, or a new top-level trap appears. Follow the Knowledge Delta Protocol in `.agents/CONTRIBUTING.md`.
