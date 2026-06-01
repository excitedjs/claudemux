# Promotion Decision Tree (dispatcher-scoped)

For each finding (recurring foot-gun, undocumented convention, drifted skill instruction, missing memory), decide in priority order which carrier it should live in. The order matters — pick the highest-priority match.

All paths below are relative to the dispatcher directory (the dispatcher's `$PWD` at skill invocation — see `SKILL.md`). "AutoMemory" means `~/.claude/projects/<encoded-cwd>/memory/`.

## 1. → Project CLAUDE.md (the dispatcher's `CLAUDE.md`)

Eligible when the finding is a **behavioral rule** that should fire in EVERY dispatcher session, not gated on a specific skill being triggered. Examples:

- "Never grep across the dispatcher directory — too many repos"
- "Cron firing rules and limits"
- "Don't combine prompt + Enter in one tmux send-keys call"

Keep the CLAUDE.md addition short (1–3 sentences) and lead with the rule, then a one-line *why*. Concrete recall over taxonomy.

**Requires user confirmation** before any substantive change (rewrites, deletions, or any single addition > ~3 sentences). Small additions (≤ 3 sentences) under an existing section may be applied directly.

## 2. → Local dispatcher notes (`.claude/local-dispatcher-notes.md` under the dispatcher directory)

Eligible when the finding is **only relevant when the dispatcher is actively spawning/managing teammates** or running a specific orchestration flow, but does not warrant editing CLAUDE.md (too narrow) or project memory (not a fact, more like a procedural addition). Examples:

- "When sentinel-waiting for a teammate, do Y not Z"
- "Add a foot-gun bullet about a specific TUI dialog where `--pane-quiet` is needed"
- "Prefer `tm spawn --prompt` over `tm spawn` then a separate `tm send` for atomic bootstrap"

Apply directly only when the change is a small addition (≤ 5 lines, appended to the file). Anything larger requires user confirmation. **Never** rewrite the notes file from scratch.

This carrier exists because the dispatcher skill itself lives inside the claudemux plugin install directory, which is read-only and gets overwritten on plugin update. The notes file is user-owned and survives upgrades.

When a finding would benefit FUTURE plugin users (not just this dispatcher), surface it as a "propose to upstream the dispatcher skill" item in the report rather than writing to local notes — the user can then submit a plugin change.

## 3. → Plugin-level skill change — propose only (`${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/SKILL.md` or `bin/tm`)

Eligible when the finding would be valuable to ALL users of the claudemux plugin, not just this dispatcher. Examples:

- A new `tm` subcommand that solves a recurring pattern
- A foot-gun general enough that every dispatcher would benefit
- A correction to plugin-skill text that misleads in the general case

**Always requires user confirmation.** The plugin install dir is read-only; the proposal should be a concrete diff the user can apply manually in the claudemux source repo (or paste into a PR). When testing such a change, always sanity-check `bin/tm` with `bash -n` before declaring done — a broken `tm` paralyses every future dispatcher session.

## 4. → Project memory (any `*.md` file inside the AutoMemory directory)

The default storage for findings that are too **situational** to be a CLAUDE.md rule, too **dispatcher-internal** to belong in a sibling repo, and too **standalone** to fold into the dispatcher skill. Examples:

- "User prefers driving teammates directly via RC; dispatcher should not relay"
- "Use `tm history --repo <repo>` to recover prior teammate sessions"
- "Project acme-app is in Spike 1 phase; artifacts X, Y"

Memory writes are **auto-applied** (no user confirmation) for: new files, additions to existing files, and routine cleanups such as broken links. Deletions of an entire memory file require user confirmation.

Always update `MEMORY.md` (the index) when adding or removing files; never write content directly into `MEMORY.md`.

## 5. → Propose a new skill (report-only — never write skill files yourself)

Eligible when ≥ 5 memories cluster around the same domain AND are repeatedly retrieved together AND can't be cleanly absorbed into the dispatcher skill or local notes. Examples:

- A self-contained "release-pipeline watcher" workflow that runs across many tasks
- A repeatable multi-step ritual that has its own tools and references

**Always report-only — never create skill files directly.** Where the user puts the skill (project-scoped, user-scoped, or a separate plugin) depends on their setup and isn't this skill's call. Write a one-paragraph proposal containing the cluster of memories, the proposed skill name and scope, and a draft trigger description, and let the user create it with `skill-creator` (or whatever flow they prefer).

## 6. → Retain in memory

When density is insufficient (< 5 related memories) or the finding is too cross-cutting for any of the above, keep it as a project memory and observe. Re-evaluate next run.

## Out-of-scope (never touch)

- This plugin's install directory (`${CLAUDE_PLUGIN_ROOT}`) — read-only
- Global `~/.claude/CLAUDE.md`
- Global skills in `~/.claude/skills/`
- AutoMemory directories of sibling repo projects (each repo has its own encoded directory under `~/.claude/projects/`)
- Any file outside the three "in scope (modify)" roots listed in `SKILL.md`

Global promotion (machine-wide CLAUDE.md / global skills) is intentionally out of scope. If a finding genuinely warrants a global rule, surface it in the final report and let the user decide; do not write outside the dispatcher workspace.

## Anti-patterns

- A memory directly related to the dispatcher skill is sitting in `memory/` instead of in the local notes → absorb into notes, delete the original.
- Two near-duplicate memories about the same convention → merge into one.
- A remembered teammate session whose process no longer exists → query `tm history --repo <repo>` / `tm history --id <prefix>` and update local notes only if the finding is still useful.
- A foot-gun bullet repeated across multiple memories → promote to a single line in the local notes file's "Common foot-guns" section.
- Attempting to edit a file under `${CLAUDE_PLUGIN_ROOT}` → that's read-only; either propose the change for upstream or add to local notes instead.
