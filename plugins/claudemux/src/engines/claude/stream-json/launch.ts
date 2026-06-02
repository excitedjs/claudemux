/**
 * Launch-argv construction for the Claude stream-json transport — both the
 * `claude` child the broker spawns and the detached broker process `tm` spawns.
 *
 * Two argv builders live here so the flag contract has one source of truth:
 *
 *  - `buildClaudeArgs` — the headless stream-json flags. This is the contract
 *    that replaces the interactive `claude … -n … --worktree …` launch the
 *    tmux bridge built with `tmux send-keys`.
 *  - `buildBrokerSpawnArgv` — how `tm` re-invokes its own entrypoint as the
 *    detached broker. It reconstructs the exact `node` invocation that launched
 *    this `tm` (`execPath` + `execArgv` + the entry script), so the broker runs
 *    under the same runtime — type-stripped source in a checkout, `dist/tm.mjs`
 *    in an npm install — with no second launcher to keep in sync.
 */

/** The hidden subcommand `tm`'s entrypoint routes to the broker loop. */
export const BROKER_SUBCOMMAND = '__claude-broker'

/**
 * Resolve the `claude` binary. `CLAUDEMUX_CLAUDE` overrides for tests and for
 * a pinned install; otherwise the plain name is found on `PATH`, matching how
 * the tmux bridge launched `claude`.
 */
export function claudeBinary(env: NodeJS.ProcessEnv): string {
  const override = env['CLAUDEMUX_CLAUDE']
  return override !== undefined && override.length > 0 ? override : 'claude'
}

/** Settings JSON shielding the dispatcher's memory from the teammate. */
export function teammateSettingsJson(dispatcherDir: string): string {
  return JSON.stringify({
    claudeMdExcludes: [`${dispatcherDir}/CLAUDE.md`, `${dispatcherDir}/CLAUDE.local.md`],
  })
}

export interface ClaudeArgsOptions {
  /** Dispatcher dir whose `CLAUDE.md` must be shielded from the teammate. */
  readonly dispatcherDir: string
  /** A fresh session id (UUID) to pin, for a new teammate. */
  readonly sessionId: string | null
  /** An existing session id to resume; mutually exclusive with `sessionId`. */
  readonly resumeSid: string | null
  /** Emit the `--include-partial-messages` deltas. Defaults on (live view). */
  readonly includePartial?: boolean
}

/**
 * The headless stream-json flag set.
 *
 * Permission posture — **`--dangerously-skip-permissions`**: the teammate runs
 * every tool without a permission check, the same unattended posture as a Codex
 * teammate's `approval_policy: Never`. This is a deliberate, loud choice: a
 * claudemux teammate has no human at a prompt, and a non-bypass headless session
 * would auto-deny any un-allowlisted tool and silently stall the work. The
 * operator opts in by running teammates in repos they trust. Per-tool
 * allowlist parity (via `--permission-prompt-tool stdio` and a broker
 * `can_use_tool` handler) is the planned refinement; this is the usable floor.
 */
export function buildClaudeArgs(opts: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
  ]
  if (opts.includePartial !== false) args.push('--include-partial-messages')
  args.push('--dangerously-skip-permissions')
  args.push('--disallowedTools', 'AskUserQuestion,EnterPlanMode,ExitPlanMode')
  args.push('--settings', teammateSettingsJson(opts.dispatcherDir))
  if (opts.resumeSid !== null) {
    args.push('--resume', opts.resumeSid)
  } else if (opts.sessionId !== null) {
    args.push('--session-id', opts.sessionId)
  }
  return args
}

/** Inputs the detached broker needs, passed as its argv. */
export interface BrokerSpawnParams {
  readonly name: string
  readonly repo: string
  readonly cwd: string
  readonly worktreeSlug: string | null
  readonly dispatcherDir: string
  readonly projectsDir: string
  readonly sessionId: string | null
  readonly resumeSid: string | null
  readonly remoteControl: boolean
}

/**
 * Reconstruct the `node` invocation that re-runs this `tm` entrypoint as the
 * broker. `process.execArgv` carries the `--import …/resolver-register.mjs
 * --experimental-transform-types --no-warnings` flags in a source checkout and
 * is empty for the compiled `dist/tm.mjs`; `process.argv[1]` is the entry
 * script either way. The broker inherits the same runtime with no separate
 * launcher.
 */
export function buildBrokerSpawnArgv(params: BrokerSpawnParams): { command: string; args: string[] } {
  const entry = process.argv[1] ?? ''
  const flags = [
    BROKER_SUBCOMMAND,
    '--name', params.name,
    '--repo', params.repo,
    '--cwd', params.cwd,
    '--dispatcher-dir', params.dispatcherDir,
    '--projects-dir', params.projectsDir,
  ]
  if (params.worktreeSlug !== null) flags.push('--worktree-slug', params.worktreeSlug)
  if (params.sessionId !== null) flags.push('--session-id', params.sessionId)
  if (params.resumeSid !== null) flags.push('--resume', params.resumeSid)
  if (params.remoteControl) flags.push('--remote-control')
  return { command: process.execPath, args: [...process.execArgv, entry, ...flags] }
}

/** Parse the broker's own argv (the half after `__claude-broker`). */
export function parseBrokerArgv(argv: readonly string[]): BrokerSpawnParams | { error: string } {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] ?? null : null
  }
  const name = get('--name')
  const repo = get('--repo')
  const cwd = get('--cwd')
  const dispatcherDir = get('--dispatcher-dir')
  const projectsDir = get('--projects-dir')
  if (name === null || repo === null || cwd === null || dispatcherDir === null || projectsDir === null) {
    return { error: 'broker argv missing one of --name/--repo/--cwd/--dispatcher-dir/--projects-dir' }
  }
  return {
    name,
    repo,
    cwd,
    worktreeSlug: get('--worktree-slug'),
    dispatcherDir,
    projectsDir,
    sessionId: get('--session-id'),
    resumeSid: get('--resume'),
    remoteControl: argv.includes('--remote-control'),
  }
}
