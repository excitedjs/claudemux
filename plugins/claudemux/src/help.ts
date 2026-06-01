/**
 * `tm` CLI help text.
 *
 * Keep this surface terse. It is mostly read by dispatcher agents that need
 * flag shape, output shape, and the few operational caveats that change the
 * next command.
 */

/** Top-level synopsis: `tm`, `tm help`, `tm --help`, `tm -h`. */
export const OVERVIEW_HELP = `tm - teammate manager for dispatcher agents

Usage:
  tm <verb> [args]
  tm help [verb]
  tm <verb> --help

Core:
  tm spawn <path> [--name <id>] [--intent "..."] [--prompt "..."]
  tm send <name> --prompt "..."
  tm wait <name> [--fresh]
  tm resume <name> [<sid/thread-id>]
  tm resume --engine <claude|codex> --repo <path> --id <sid/thread-id>
  tm kill <name> [--status <s>] [--note <text>]
  tm kill --id <id> --status <s> [--note <text>]

Inspect:
  tm ls [--all]
  tm states [--all]
  tm last <name> [--verbose]
  tm ctx <name>... | --all
  tm history [filters] [--fields a,b,c]
  tm mem <name>

Maintenance:
  tm compact <name>
  tm reload <name>... | --all
  tm ask "<prompt>"

Diagnostics:
  tm status <name> [lines=80]
  tm poll <name> <regex> [timeout=180]
  tm doctor

Names are flat teammate ids. \`tm spawn <path>\` records the repo; follow-up
verbs use \`<name>\`, not paths. Relative paths resolve against
TM_DISPATCHER_DIR (or $PWD fallback).

Remote Control default: CLAUDEMUX_REMOTE_CONTROL=1/true/yes/on.
`

/** Per-verb help text: `tm <verb> --help` and `tm help <verb>`. */
export const HELP_TEXTS: Readonly<Record<string, string>> = {
  ls: `tm ls [--all]

List teammates:
  NAME REPO WORKTREE ENGINE STATE

States: idle, busy, borrowed, unknown. With --all, include killed teammates
from the kill-time identity archive.
`,

  states: `tm states [--all]

Fleet snapshot:
  NAME REPO WORKTREE ENGINE STATE LAST PREVIEW

States: idle, busy, borrowed, killed, orphaned, unknown. With --all, include
killed teammates; LAST/PREVIEW are '-' for killed rows.
`,

  spawn: `tm spawn <path> [--name <id>] [--intent "..."] [--engine claude|codex] [--prompt "..."] [--no-worktree] [--remote-control|--no-remote-control] [--no-preamble] [--timeout N]

Launch a teammate in <path>. Relative paths resolve against TM_DISPATCHER_DIR.
Default name is <repo-leaf>-<rand4>; explicit names must match
^[A-Za-z0-9][A-Za-z0-9_-]*$ and be globally unique.

Default cwd is <path>/.claude/worktrees/<name>/ on branch worktree-<name>.
Use --no-worktree to run in <path> itself.

--intent stores a short queryable task subject for tm history.
--prompt sends the first turn and prints the reply.
--engine defaults to claude.
--remote-control is Claude-only; explicit flag beats CLAUDEMUX_REMOTE_CONTROL.

Prompt preamble (opt-in): if <dispatcherDir>/.tm-preamble.json exists, a
fresh --prompt spawn prepends the entry for the resolved repo (else the
"default" entry) to the prompt. Shape: { "default": "...", "repos": {
"<repo>": "..." } }; keys match the repo path tm records. --no-preamble
opts a single spawn out.

Exit codes on --prompt: 0 reply printed; 124 wait expired but teammate is
still running; 1 failure.
`,

  send: `tm send <name> --prompt "..." [--pane-quiet] [--timeout N]

Send one turn, wait for completion, print reply text on stdout. Status and ctx
lines go to stderr.

--pane-quiet waits for pane quiet instead of the Stop hook; use for TUI-only
commands. --timeout defaults to 1800s.

Exit codes: 0 reply printed; 124 wait expired but teammate is still running;
1 failure. Re-collect 124 with tm wait <name> or inspect with tm status <name>.
`,

  wait: `tm wait <name> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]

Wait for the next teammate completion and print reply text on stdout.

Use --fresh when no tm send reset the baseline for this turn. --pane-quiet uses
pane quiet instead of the Stop hook. If both positional timeout and --timeout
are present, the later parsed value wins.

Exit codes match tm send.
`,

  compact: `tm compact <name> [timeout=1800] [--timeout N]

Send /compact and wait for PostCompact. Prints:
  compacted

Exit codes: 0 compacted; 1 Claude refused (usually too few messages);
124 timeout but teammate may still be compacting.
`,

  resume: `tm resume <name> [<sid-or-thread-id>] [--prompt "..."] [--engine claude|codex]
tm resume --engine <claude|codex> --repo <path> --id <sid-or-thread-id> [--name <fresh>] [--intent "..."] [--prompt "..."]

Resume a prior conversation. Name form uses the existing or archived teammate
identity. Id form resumes a tm history row; --id accepts a full id or
unambiguous prefix, and --repo anchors cwd/project lookup.

Claude ids are transcript sids. Codex ids are thread ids. Without an explicit
id, name form probes history and uses --engine to break ties.

Fails if <name> is already running. --prompt sends a follow-up after relaunch.
If a large Claude resume ever shows a summary/full-session selector, inspect
with tm status <name> before sending; pressing Enter there chooses summary.
`,

  last: `tm last <name> [--verbose]

Print the last assistant reply. For Codex, --verbose prints the raw saved turn
JSON instead of the assistant-text summary.
`,

  mem: `tm mem <name>

Print the teammate repo's AutoMemory MEMORY.md. Missing memory is exit 0 with
empty stdout and a one-line stderr notice. Treat memory as hints; verify before
prompting a teammate with it.
`,

  kill: `tm kill <name> [--status <merged|done|shelved|abandoned|blocked>] [--note <text>]
tm kill --id <full-or-prefix> --status <merged|done|shelved|abandoned|blocked> [--note <text>]

Stop a teammate and clear live markers. Dirty worktrees are preserved with a
stderr note; clean worktrees are removed when the engine can do so safely.

--status records queryable close metadata for tm history --status. --note
stores a bounded note preview; it is not a query index. The --id form only
records close metadata for an existing history row; it does not stop a process.
`,

  ask: `tm ask "<prompt>"

Run a one-shot turn on an idle Codex teammate from the pool and print the turn
JSON. The borrowed teammate's persistent thread is not polluted.

Fails when no Codex teammate exists, all are dead, or all are borrowed.
`,

  reload: `tm reload <name>... | --all

Send /reload-plugins to one or more teammates. --all enumerates live teammates;
missing/dead targets are skipped with stderr notes.
`,

  ctx: `tm ctx <name>... | --all [--window 200k|1m]

Print context-window usage from transcript JSONL. A peak above ~210k implies a
1M window; otherwise 200k is assumed unless --window overrides it.
`,

  history: `tm history [--repo <leaf|path>] [--name <glob>] [--id <full-or-prefix>] [--engine claude|codex] [--since <time>] [--until <time>] [--state <state>] [--status <status>] [--grep <text>] [--limit N] [--cursor N] [--fields a,b,c] [--json|--oneline|--table]

Query past and live teammate sessions. Grammar is flag-only; legacy
\`tm history <name>\` is removed.

Default output is bounded JSON:
  { "items": [...], "nextCursor": "N" | null }

Use --limit/--cursor for paging. --fields selects JSON fields. Valid fields:
id, engine, name, repo, cwd, worktreeSlug, branch, baseRef, createdAt,
createdAtSource, lastSeenAt, state, intent, closeStatus, closeNotePreview,
lastAssistantPreview, resumeCommand, source, topic, path, sizeBytes.

Sources: forward tm history index, live/archived identity records, Claude
transcripts, Codex rollouts. The index starts empty and never imports old
Markdown ledgers.

Time filters use the first in-file event timestamp; createdAtSource exposes
mtime fallback. --name matches only indexed/live/last-killed attribution; for
robust recovery prefer repo/id/time.

States: idle, busy, borrowed, killed, orphaned, unknown.
Close statuses: merged, done, shelved, abandoned, blocked.
`,

  status: `tm status <name> [lines=80]

Diagnostic capture-pane. Use when send/wait cannot tell you the live TUI state.
`,

  poll: `tm poll <name> <regex> [timeout=180]

Diagnostic pane wait. Match the expected result, not text from the prompt you
just sent.
`,

  doctor: `tm doctor

Read-only environment check: tm path/version, dispatcher dir, tmux status,
idle dir, and active teammates. Always exits 0; read the printed lines.
`,
}

/**
 * Removed verbs keep specific migration hints instead of falling through to
 * "unknown subcommand".
 */
export const REMOVED_VERB_MESSAGES: Readonly<Record<string, string>> = {
  'wait-idle': `tm wait-idle was renamed to 'tm wait'.
`,
  'wait-quiet': `tm wait-quiet was folded into --pane-quiet. Use 'tm wait <name> --pane-quiet' or 'tm send <name> --prompt "..." --pane-quiet'.
`,
  archive: `tm archive was removed with the manual dispatcher Markdown ledger. Use 'tm kill <name> --status <merged|done|shelved|abandoned|blocked> [--note <text>]' and query with 'tm history --status <status>'. Existing ledger .md files are abandoned in place; tm does not migrate them.
`,
}
