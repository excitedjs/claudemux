/**
 * `tm kill <name>` — release the teammate. Decision multi-engine-tui-architecture amend lines
 * 163-169 fix the default impl: resolve through the router, ask the
 * engine to kill, remove the identity JSON on success. The "remove
 * identity" step is what frees the name for a subsequent `tm spawn`.
 *
 * The engine's `kill` is the single place that decides what "stop the
 * teammate" means for that engine (tmux session kill / Codex daemon
 * SIGTERM / etc); the verb owns identity bookkeeping and exit code.
 */

import { existsSync, readFileSync } from 'node:fs'

import { formatKill } from './format'
import { identityFile, read as readIdentity } from '../persistence/identity-store'
import {
  recordHistoryClose,
  type HistoryCloseStatus,
} from '../persistence/history-index'
import { sidFile } from '../persistence/paths'
import { codexThreadFile } from '../engines/codex/persistence'
import type { TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

/**
 * `tm kill` is idempotent: a missing teammate still has to clear stale
 * markers and return "not running" with exit 0. When the router cannot
 * resolve a name, the verb falls through to the Claude engine — its
 * `kill` is the only one that knows the tmux + on-disk marker layout the
 * legacy `cmd_kill` cleaned up unconditionally. A registered Codex
 * teammate would have been resolved by the router on the JSON path; if
 * neither router resolves a name, it cannot be a live Codex daemon.
 *
 * Schema-1 record recovery: a legacy identity JSON whose engine has
 * long-since died (no tmux session, no Codex daemon) leaves
 * `engine.kill()` returning `not-found`. The verb still has to clear
 * the stale `/tmp/teammate-<name>.json` so the next `tm spawn` is not
 * blocked by an `O_EXCL` collision — `tm kill` is the documented
 * recovery action for the schema-1 → schema-2 migration. The
 * existence probe runs against the raw on-disk file (independent of
 * schema parse), so a record this build cannot parse still gets
 * swept.
 */
export interface KillOptions {
  readonly status: HistoryCloseStatus | null
  readonly note: string | null
}

function readMarker(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function closeIdFor(name: string, engine: string | null): string | null {
  if (engine === 'codex') return readMarker(codexThreadFile(name))
  if (engine === 'claude') return readMarker(sidFile(name))
  return readMarker(sidFile(name)) ?? readMarker(codexThreadFile(name))
}

export async function killVerb(
  name: TeammateName,
  ctx: VerbContext,
  opts: KillOptions = { status: null, note: null },
): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  const engine = resolved?.engine ?? ctx.engines.get('claude')
  if (engine === undefined) return formatKill(name, { kind: 'not-found' })
  const hadIdentityFile = existsSync(identityFile(name))
  const identity = readIdentity(name)
  const closeId = closeIdFor(name, resolved?.engine.kind ?? identity?.engine ?? null)
  const result = await engine.kill({ name }, ctx.engineContext)
  // Archive before remove: a later `tm resume <name> <sid>` /
  // `tm history --name <name>` reads the snapshot to recover the killed
  // teammate's cwd / repo / worktreeSlug / displayName, so the agent
  // never has to scrape `/tmp` directly.
  if (result.kind === 'killed' || (result.kind === 'not-found' && hadIdentityFile)) {
    if (opts.status !== null) {
      recordHistoryClose({
        id: closeId,
        engine: resolved?.engine.kind ?? identity?.engine ?? null,
        name,
        repo: identity?.repo ?? null,
        cwd: identity?.cwd ?? null,
        status: opts.status,
        note: opts.note,
      })
    }
    await ctx.identity.archive(name)
    await ctx.identity.remove(name)
  }
  if (result.kind === 'not-found' && hadIdentityFile) {
    return {
      code: 0,
      stdout: `killed: ${name}\n`,
      stderr: `tm kill: ${name}: cleared stale identity record (engine had no live process)\n`,
    }
  }
  return formatKill(name, result)
}
