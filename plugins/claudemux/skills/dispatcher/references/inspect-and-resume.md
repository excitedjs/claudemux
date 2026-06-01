# Inspect history and resume a session (scenario reference)

Read this when you need to look back at a repo's past Claude sessions or Codex threads: pick the right id to resume, re-read what a teammate last said, or find an orphaned session/thread. Skip when you are sending fresh work (`dispatch-task.md`) or waiting for a still-live turn (`wait-and-readback.md`).

## Three verbs and their boundary

| Verb | Scope | When to use |
|---|---|---|
| `tm last <name>` | Current live teammate only. Claude reads `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. | Re-read the reply that `tm send` / `tm wait` already printed. |
| `tm history [--repo <path>] [--id <id>] ...` | tm-owned session index enriched with Claude transcripts and Codex rollouts | Find a sid / thread id to resume; survey what has been done in this repo |
| `tm resume <name> [<sid-or-thread-id>]` or `tm resume --engine <e> --repo <path> --id <id>` | Starts a teammate process on a prior Claude session or Codex thread | Continue a task whose teammate died, including orphaned rows with no current name |

Run `tm last --help`, `tm history --help`, and `tm resume --help` for full flag/output contracts.

## Fleet snapshot: `tm states`

When several teammates are running and you want a one-shot "who's said what":

| Column | Meaning |
|---|---|
| `NAME` | Flat teammate identifier from `tm spawn` |
| `REPO` | Last path segment of the source repo (`identity.repo`) |
| `WORKTREE` | Worktree slug (`identity.worktreeSlug`), or `-` for `--no-worktree` teammates |
| `ENGINE` | `claude` or `codex` |
| `STATE` | `idle` / `busy` / `borrowed` / `unknown`, or `killed` for an archived teammate surfaced only by `--all` (see below). `borrowed` means a Codex daemon is live but currently held by a one-shot turn. Known Claude false-negative: TUI-only commands (`/help`, `/effort`, `/agents` dialogs, permission prompts) can fire no hooks, so STATE can read `idle` while the pane is blocked — use `tm status <name>` for ground truth. |
| `LAST` | Size and age of the last assistant reply, or `-` if no reply has ended yet |
| `PREVIEW` | First 50 chars of the last assistant reply, control chars stripped |

Claude `LAST` / `PREVIEW` come from `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. `tm states` is cheap enough for fleet scanning and avoids scraping every pane.

Both `tm states` and `tm ls` take `--all` to also list **killed** teammates (`STATE` `killed`, `LAST` / `PREVIEW` `-`) from the kill-time identity archive — use it to find a resumable name after a teammate was killed; see "Picking up that thing from yesterday" below.

## `tm history` query surface

`tm history` is flag-only and defaults to bounded JSON:

```bash
tm history --repo <path-or-leaf> --fields id,engine,name,state,intent,createdAt,resumeCommand
tm history --id <full-or-prefix>
tm history --repo <path> --since 2026-05-20T00:00:00Z --grep "short subject"
tm history --status abandoned --fields id,repo,intent,closeStatus,closeNotePreview
```

Use `--limit` / `--cursor` for pagination; do not ask the agent to read an unbounded blob. `--fields` accepts a comma-separated subset of the JSON fields and should be your default for broad scans. Use `--oneline` or `--table` only when a human needs a compact view.

The important fields for recovery:

| Field | Meaning |
|---|---|
| `id` | Full Claude sid or Codex thread id. `--id` accepts an unambiguous prefix. |
| `repo` / `cwd` | Anchor path for recovery. Orphaned transcript rows may have a repo/cwd even when `name` is null. |
| `name` | Attribution from tm's forward index, live identity, or last-killed identity. It is not a complete historical key; prefer repo/id/time for recovery. |
| `state` | `live`, `idle`, `busy`, `borrowed`, `killed`, `orphaned`, or `unknown`. |
| `intent` | Queryable short subject from `tm spawn --intent` / resume display name. |
| `topic` | Fallback first prompt preview when no explicit intent exists. |
| `lastAssistantPreview` | Bounded "where did it end up" preview; inspectable, not a queryable outcome. |
| `closeStatus` | Queryable close status from `tm kill --status`: `merged`, `done`, `shelved`, `abandoned`, or `blocked`. |
| `resumeCommand` | Ready command for rows with enough anchor data; prefer copying it over rebuilding the command by hand. |

Time filters (`--since`, `--until`) use the in-file session-created timestamp for transcripts/rollouts. If a source lacks that timestamp, `createdAtSource: "mtime"` marks the fallback.

The forward tm-owned history index starts empty and accrues from future `tm` lifecycle verbs. It never reads or imports retired Markdown ledger files. Claude transcripts and Codex rollouts are read-only enrichment/recovery sources.

## `tm resume` — prefer an explicit id

Two ways to call it:

- **With an explicit named teammate**: `tm resume <name> <full-or-prefix-sid-or-thread-id>`. Use this when the row has a reliable `name` or you intentionally want that handle.
- **With a history row**: `tm resume --engine <claude|codex> --repo <path> --id <full-or-prefix> [--name <fresh>] [--intent "..."]`. Use this for orphaned rows or when you want a fresh handle; this is the form `resumeCommand` emits.
- **Without id**: `tm resume <name>`. Claude delegates selection to `claude --continue`; Codex asks the app-server for the latest thread for that cwd. Use only when you lack an id clue or genuinely want the native/latest choice.

When no explicit id is supplied and both engines have resumable history for the cwd, `tm resume` refuses to guess. Pass `--engine claude|codex` or supply an explicit id. Prefixes are accepted only when they resolve to exactly one history row; ambiguous prefixes fail with candidate full ids.

Either way fails if a teammate for `<name>` is already alive (Claude tmux session or Codex daemon). `tm kill <name>` first if you intentionally want to replace it.

`--prompt "..."` sends a follow-up after relaunch (atomic, same shape as `tm spawn --prompt`). The resumed teammate keeps its original name.

### Large-session resume startup prompt (suppressed for teammates)

Resuming a big, hours-old Claude session can make Claude Code raise a "Resume from summary (recommended) / Resume full session as-is" startup selection that blocks until a choice is made. It fires when the resumed session is older than `CLAUDE_CODE_RESUME_THRESHOLD_MINUTES` (default 70) **and** larger than `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` (default 100k tokens). A teammate has no human to answer it, and a `tm send` fired right after resume delivers its Enter onto the selection — mis-picking the default "summary" option (which runs `/compact`) and swallowing both your message and the full context the resume was meant to restore.

Teammates suppress this at launch: `tm spawn` / `tm resume` start the tmux session with `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD` set far above any real context window, so the token condition never trips, the prompt never renders, and a resumed teammate loads its full session silently.

Fallback only: if a future Claude Code build ignores that env knob and the prompt reappears, confirm the REPL is at a normal input box with `tm status <name>` before the next `tm send`. A small or recent session never hits the prompt regardless.

## Picking up "that thing from yesterday"

User says: "继续昨天那个 X 任务" but there is no live teammate name in context.

If you know the repo, start with a bounded JSON query:

```bash
tm history --repo <repo> --fields id,engine,name,state,intent,topic,lastAssistantPreview,resumeCommand
```

If you know only an id fragment, use `tm history --id <prefix> --fields id,engine,repo,name,intent,resumeCommand`. If you know only the old teammate name, use `tm history --name <name>` as an attribution filter, but treat it as lossy and confirm with repo/id/time before acting.

Pick the row whose `intent`, `topic`, and `lastAssistantPreview` match what the user described, then copy `resumeCommand`. If `resumeCommand` is null, the row lacks enough anchor data; ask for a repo/id clue instead of guessing.

## Resuming with a caller-supplied sid: verify subject first

When the user hands the dispatcher a sid or thread-id with a phrase like "this is the X result, take over the scheduling", do not decide what "X" means from whatever is most contextually salient in the current chat (a PR the dispatcher just opened, a task the dispatcher just finished). The dispatcher did not witness the resumed conversation, so the actual content of that session — not the local chat's loudest event — is the authority on what it was about.

Before or after `tm resume ... --id <sid>`, verify the subject via at least one of:

- **`tm last <name>`** — usually names the subject when a `.last` file exists.
- **Check the suspected target on the side** — `gh pr view <suspected-PR> --json reviews,comments`; if the resumed session was a review and the PR you assumed has empty reviews/comments, you assumed wrong.
- **Ask the user one line** — the cost of a clarifying reply is much lower than the cost of dispatching invented work to a downstream teammate.

These three checks cover this case; pick whichever is fastest for the situation. Only after one of them lines up with your understanding of the subject should you brief the teammate.

The first turn sent to the resumed teammate should not contain a confident statement about the subject ("you reviewed PR #N"). Ask the teammate to surface its existing conclusions first ("summarize what you concluded in this session in dispatcher-friendly format"), and let its summary establish the subject — that way a wrong subject manifests as a push-back, not as invented compliance.

## Foot-gun: polling history by prompt-echo

If you build a custom wait around `tm history` or `tm poll`, match expected result keywords (`merged`, `done`, `Cancelled`, anticipated error codes), never words from the prompt you just sent. The prompt itself appears in the user turn, so prompt-word grep returns instantly.

## Boundary recap

- `tm last` is current-live only; it dies once the teammate is killed unless the engine can resolve the current thread.
- `tm history` is the tm-owned query surface; it survives kills and includes past sessions/threads.
- `tm resume` is state-mutating; it starts a process and claims the teammate name. `tm history` is read-only.
