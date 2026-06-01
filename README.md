**English** · [简体中文](./README.zh-CN.md)

# claudemux

> `claude` + `tmux`. One dispatcher Claude Code session talks to you. One
> teammate Claude Code per repo runs in its own `tmux` session. You
> orchestrate the fleet in plain language.

> **Worktree default + name decoupling (1.0 cut).** `tm spawn <path>` now
> takes a filesystem path; the teammate name is a flat identifier
> (`--name`, or auto `<basename>-<rand4>`). Every other verb takes that
> name. Teammates run inside a git worktree at
> `<path>/.claude/worktrees/<name>/` by default; `--no-worktree` opts
> out. Pre-upgrade teammates must be `tm kill`-ed and respawned (schema
> 1 → 2; no silent migration). `.worktreeinclude` for the Codex path
> is a TODO — copy `.env` etc. into the Codex worktree by hand for
> now. See [`.agents/decisions/worktree-default-and-name-repo-decoupling.md`](./.agents/decisions/worktree-default-and-name-repo-decoupling.md)
> for the why.

## Architecture

```mermaid
flowchart TB
    user(["You<br/>(terminal · web · mobile)"])

    subgraph dispatcher_dir["dispatcher directory · the parent of your repos"]
        dispatcher["dispatcher<br/>(claude in tmux, talks to you)"]
        repoA[("repo-a/")]
        repoB[("repo-b/")]
        repoC[("repo-c/")]
    end

    subgraph teammates["teammates · one tmux session per repo"]
        tA["teammate-repo-a<br/>(claude in repo-a/)"]
        tB["teammate-repo-b<br/>(claude in repo-b/)"]
    end

    user <-->|chat| dispatcher
    user -.->|optional: direct drive<br/>via Remote Control| tA
    dispatcher -->|tm spawn / send / wait| tA
    dispatcher -->|tm spawn / send / wait| tB
    tA -.cwd.-> repoA
    tB -.cwd.-> repoB
```

## Drive teammates from anywhere

Every teammate is a real `claude` REPL with a Remote Control URL. Open the
URL in a browser or the mobile app and you're talking to that teammate
directly — no terminal needed.

- Check on a long-running teammate from your phone on the subway.
- Hand a teammate the next task from a laptop in a cafe while the
  dispatcher keeps coordinating the rest of the fleet.
- Three devices, three windows, one fleet — in parallel.

Enable Remote Control in whichever scope you want:

- **Per teammate (scoped).** `tm spawn <path> --remote-control` turns it on for
  just that teammate; `--no-remote-control` forces it off. Set
  `CLAUDEMUX_REMOTE_CONTROL=1` in the dispatcher's `.claude/settings.json` env
  block to make it the default for every `tm spawn`. This keeps the dispatcher
  and any unrelated `claude` sessions off Remote Control — a per-spawn flag
  always overrides the config (precedence: explicit flag > config > off).
- **Everything (global).** `/claudemux:setup` can flip on Claude Code's
  user-global `remoteControlAtStartup`, so every `claude` session — dispatcher
  and teammates alike — registers a URL the moment it starts.

## Install

In any Claude Code session:

```
/plugin marketplace add excitedjs/claudemux
/plugin install claudemux@claudemux
/reload-plugins
```

Then `cd` to the parent of your sibling repos and start the dispatcher:

```bash
cd ~/path/to/your/dev-dir
claude
```

In the REPL:

```
/claudemux:setup
```

`/claudemux:setup` also seeds a `.workspace/` directory in your dispatcher dir holding three personalization files (`persona.md`, `user-profile.md`, `principles.md`) that get imported into every dispatcher session, plus `notes/` and `artifacts/` for long-term notes and dispatcher-generated intermediate output. The setup walks you through filling them in; you can skip and edit later. See `.workspace/README.md` in your dispatcher dir after setup for full layout.

## Quick start

Talk in plain language — the `dispatcher` skill picks up the intent:

> 派一个 teammate 去 repo-a 跑测试
>
> 看看 repo-b 现在在干啥
>
> 让 repo-a 跑 lint,同时让 repo-b 升级 react 到 19

Or call `tm` directly:

```bash
tm spawn repo-a --name testbot --prompt 'run yarn test in unit-test'   # atomic: spawn + send + wait + print
tm send  testbot --prompt 'now lint'                                   # sync send: returns the reply on stdout
tm states                                                              # fleet snapshot
tm kill  testbot                                                       # done
```

The first positional is a `<path>` (here `repo-a`, a sibling of the
dispatcher). The teammate identifier is whatever you pass via `--name`,
or — when you omit `--name` — the auto-generated `<basename>-<rand4>`
that spawn prints on stderr (`spawned: repo-a-7d3a`). Every other verb
takes that flat identifier.

## The `tm` script

`tm` is on `PATH` inside any Claude Code session. To use it from a regular
terminal, see [Outside Claude Code](#using-tm-outside-claude-code).

`tm spawn` is the normal launch verb that takes a filesystem path.
Follow-up verbs address the flat `<name>` returned by spawn — capture it
from the spawn stderr (`spawned: <name>`) and reuse it. `tm resume
--repo <path> --id <id>` is the recovery form for sessions whose name is
missing or stale. Names match `^[A-Za-z0-9][A-Za-z0-9_-]*$` and are
globally unique.

| Subcommand | What it does |
|---|---|
| `tm ls` | List teammates: `NAME REPO WORKTREE ENGINE STATE`. |
| `tm states` | Fleet snapshot: `NAME REPO WORKTREE ENGINE STATE LAST PREVIEW` — `state` reports `idle` / `busy` / `borrowed` / `unknown`. |
| `tm spawn <path> [--name <id>] [--intent "…"] [--engine claude\|codex] [--prompt "…"] [--no-worktree] [--remote-control] [--no-preamble] [--timeout N]` | Launch a teammate in `<path>` (absolute or relative to the dispatcher dir). Default places the teammate inside a git worktree at `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base ref `HEAD`); `--no-worktree` runs in `<path>` itself. `--name <id>` sets the explicit identifier (globally unique); omit it for an auto-generated `<basename(path)>-<rand4>`. `--intent` records a short queryable subject for `tm history`. `--remote-control` / `--no-remote-control` enables/disables Claude Remote Control for just this teammate (overriding the `CLAUDEMUX_REMOTE_CONTROL` config default; Claude-only). When a [prompt preamble](#prompt-preamble) profile is configured, a fresh `--prompt` spawn prepends the matching repo's standing reminder; `--no-preamble` opts that spawn out. With `--prompt`, atomic bootstrap: spawn + send + wait + print the first-turn reply on stdout. |
| `tm resume <name> [<sid-or-thread-id>] [--prompt "…"] [--engine claude\|codex]` / `tm resume --engine <e> --repo <path> --id <id> [--name <fresh>]` | Resume a prior conversation by teammate name, or resume an orphaned `tm history` row by repo/id. `--id` accepts a full id or an unambiguous prefix. `--prompt` sends a follow-up after relaunch (atomic like `spawn --prompt`). |
| `tm send <name> --prompt "…" [--pane-quiet] [--timeout N]` | **Atomic round-trip**: send prompt + wait for the Stop hook + print the reply on stdout. The Stop-hook path also echoes the teammate's post-turn ctx to stderr (`ctx: N tokens · …`), eliminating the common "send, then `tm ctx`" follow-up; skipped on `--pane-quiet`. `--prompt` matches the calling form of `tm spawn --prompt` / `tm resume --prompt`; flag order is free. `--pane-quiet` fallback for TUI-only commands (`/help`, `/effort`, permission prompts) that fire no hook. Exit codes: `0` reply landed; `124` sync wait expired and the teammate is still running (re-collect with `tm wait <name>`; do NOT respawn — the name is taken); `1` real failure (no session, sid marker missing, …). |
| `tm wait <name> [timeout=600] [--fresh] [--pane-quiet] [--timeout N]` | Block until the teammate's next Stop event and print the reply (ctx echo on stderr, same as `tm send`). Use when an external actor (Remote Control, mobile app, cron) drove the turn. `--fresh` waits for the NEXT Stop instead of returning on a stale marker (no-op under `--pane-quiet`). `--timeout N` is equivalent to the positional `[timeout]`. Same exit codes as `tm send`. |
| `tm compact <name> [timeout=600] [--timeout N]` | Send `/compact` and verify PostCompact fired. Prints `compacted` on success. Default 600s — large contexts (~300k+) routinely take 3-4 minutes. Exit codes: `0` PostCompact fired; `1` `/compact` refused with "Not enough messages to compact"; `124` PostCompact never fired within `--timeout`. |
| `tm last <name> [--verbose]` | Print the full text of the teammate's last reply. Fresh-spawn sentinel: dies with "no reply yet" when called before any turn has settled. `--verbose` prints the raw Codex turn JSON for Codex teammates. |
| `tm kill <name> [--status <merged\|done\|shelved\|abandoned\|blocked>] [--note "…"]` / `tm kill --id <id> --status <status> [--note "…"]` | Graceful `/exit` (clean worktree auto-removed by Claude); dirty worktree preserved with a stderr note pointing at `git worktree remove --force`. Falls back to `tmux kill-session` (SIGHUP) when graceful exit times out. `--status` records queryable close metadata for `tm history --status`; `--id` records close metadata for an already-dead session without stopping a process. |
| `tm ctx <name>… \| --all [--window 200k\|1m]` | Real context-window usage per teammate, read from the jsonl `usage` block. More accurate than the TUI percentage. |
| `tm history [--repo <path>] [--name <glob>] [--id <id>] [--since <time>] [--until <time>] [--state <state>] [--status <status>] [--grep <text>] [--limit N] [--cursor N] [--fields a,b,c] [--oneline\|--table]` | Query past and live teammate sessions. Default output is bounded JSON with full ids, timestamps, close status, bounded previews, and `resumeCommand` when recoverable. Legacy `tm history <name>` is removed; use flags. |
| `tm mem <name>` | Cat the parent repo's auto-memory `MEMORY.md` (feature-gate names, branch names, in-progress projects). Worktree teammates share their parent repo's AutoMemory — `tm mem` resolves through `identity.repo`, not the runtime cwd. Missing memory → stderr notice + exit 0 + empty stdout. |
| `tm reload <name>… \| --all` | Fan out `/reload-plugins` to teammates after a plugin update. |

Diagnostic-only (use when the verbs above don't fit): `tm status <name>` to
capture the live pane, `tm poll <name> <regex>` for intermediate-state polling.

Behavior contracts and the on-disk state are documented in
[`plugins/claudemux/skills/dispatcher/SKILL.md`](plugins/claudemux/skills/dispatcher/SKILL.md).

## `/claudemux:optimize` — periodic self-review

A bundled skill that scans the dispatcher's recent conversations, spots
recurring foot-guns or undocumented conventions, and writes them into
your `CLAUDE.md` or project memory. Runs in a forked context, returns a
short report. Invoke manually, or schedule it with `CronCreate` for a
weekly pass.

## Requirements

| Tool | Why |
|---|---|
| Claude Code CLI | The plugin attaches to it. |
| Node 22.7+ | The `tm` CLI runs the orchestration core (TypeScript) through Node's experimental type-transform pipeline directly from source — no `npm install`, no build step. 22.7 is the version that introduced `--experimental-transform-types`. |
| `tmux` | Teammates live in tmux sessions. |
| `jq` | The Stop hook parses harness JSON. |
| `bash` | Plugin scripts use Bash features. |
| macOS or Linux | Scripts use BSD `stat`; Windows is unsupported. |

## Configuration

No required configuration. The dispatcher directory is wherever you `cd`
and run `claude` — `tm` derives it from `$PWD` at invocation. Move it by
`cd`'ing elsewhere; there is no global state file.

### Prompt preamble

Opt-in. If you keep dispatching teammates into the same repo with the same
standing first-turn reminder, put it in one file instead of re-pasting it
into every `--prompt`. Create `.tm-preamble.json` in the dispatcher
directory:

```json
{
  "default": "Standing reminder for any repo without a specific entry.",
  "repos": {
    "/abs/path/to/repo-a": "Reminder prepended to spawns into repo-a.",
    "/abs/path/to/repo-b": "Reminder prepended to spawns into repo-b."
  }
}
```

On a fresh `tm spawn --prompt …`, `tm` looks up the entry for the resolved
repo path (the path `tm ls` shows for the teammate), falling back to
`default`, and prepends it to the prompt. Keys are matched after resolving
symlinks, so either a symlinked or canonical path works. With no file the
feature is a no-op; `--no-preamble` opts a single spawn out (even when the
file is present), and an explicit empty entry opts a single repo out.

## Using `tm` outside Claude Code

`tm` lives at `bin/tm` in the plugin. From a regular terminal, symlink
it once:

```bash
ln -sf ~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm ~/.local/bin/tm
```

Make sure `~/.local/bin` is on your `PATH`. Replace `<version>` with the
installed version.

## Known limitations

- **Single dispatcher root.** A relative `tm spawn <path>` resolves
  against `TM_DISPATCHER_DIR` (or `$PWD`), so sibling repos must share
  one parent. Absolute paths bypass that limit.
- **macOS / Linux only.** Scripts use BSD `stat`; GNU Linux needs
  `-c %Y` — PRs welcome.
- **Cron only fires inside an interactive TUI REPL.** The dispatcher session
  and `tm`-spawned Claude tmux sessions qualify; `claude -p` and Agent Teams
  subagents accept the `CronCreate` call but silently never fire.

## Local development

### One-off

```bash
git clone https://github.com/excitedjs/claudemux ~/src/claudemux
claude --plugin-dir ~/src/claudemux/plugins/claudemux
```

### Persistent (recommended)

```bash
claude plugin marketplace add ~/src/claudemux --scope local
claude
# in the REPL:
/plugin install claudemux@claudemux
```

`/reload-plugins` hot-reloads skills, commands, hooks, and `tm` — no
restart needed.

The pre-commit hook installs automatically when you run:

```bash
pnpm install
```

It rejects commits with an invalid author email. Claudemux release intent is
declared by writing a Changesets fragment directly at the repo root — do not
use the interactive CLI:

```bash
# Write .changeset/<slug>.md directly, e.g.:
cat > .changeset/my-change.md << 'EOF'
---
"claudemux": patch
---

Fix: describe the change here.
EOF
```

Feature PRs commit the generated `.changeset/*.md` file alongside the change;
release automation on `next`/`main` later consumes those fragments into the
plugin version and changelog.

## Uninstall

```
/plugin uninstall claudemux
```

Removes the plugin and its hooks. Your dispatcher directory's
`CLAUDE.md` is left in place — delete it by hand if you don't want it.

## License

MIT — see [LICENSE](LICENSE).
