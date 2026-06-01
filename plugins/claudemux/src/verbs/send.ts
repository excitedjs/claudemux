/**
 * `tm send <name> --prompt p` — atomic round-trip. Decision multi-engine-tui-architecture
 * §"Round-trips are atomic by default" makes wait the only path;
 * `--no-wait` is removed. The verb resolves the teammate through the
 * router and dispatches to `Engine.send`; the engine owns the
 * transport.
 */

import { readFileSync } from 'node:fs'

import { formatTurn } from './format'
import type { SendRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'
import { read as readIdentity } from '../persistence/identity-store'
import { recordHistorySession } from '../persistence/history-index'
import { sidFile, worktreeBranchFor } from '../persistence/paths'
import { codexThreadFile } from '../engines/codex/persistence'

export interface SendArgs {
  readonly name: TeammateName
  readonly prompt: string
  readonly timeoutMs: number | null
  readonly paneQuiet: boolean
}

function readMarker(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function sessionIdFor(engine: 'claude' | 'codex', name: string): string | null {
  return engine === 'codex' ? readMarker(codexThreadFile(name)) : readMarker(sidFile(name))
}

export async function sendVerb(args: SendArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  if (args.paneQuiet && engine.kind !== 'claude') {
    return { code: 1, stdout: '', stderr: 'tm: tm send: --pane-quiet is not supported for codex teammates\n' }
  }

  const req: SendRequest = {
    name: args.name,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
    paneQuiet: args.paneQuiet,
  }
  const turn = await engine.send(req, ctx.engineContext)
  if (turn.kind !== 'failed') {
    const identity = readIdentity(args.name)
    recordHistorySession({
      id: sessionIdFor(engine.kind, args.name),
      engine: engine.kind,
      name: args.name,
      repo: identity?.repo ?? null,
      cwd: identity?.cwd ?? null,
      worktreeSlug: identity?.worktreeSlug ?? null,
      branch: identity?.worktreeSlug === null || identity === null
        ? null
        : worktreeBranchFor(identity.worktreeSlug),
      baseRef: null,
      createdAt: new Date(ctx.engineContext.now()).toISOString(),
      intent: identity?.displayName ?? null,
    })
  }
  return formatTurn(turn)
}
