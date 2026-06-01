/**
 * `tm spawn <name> --engine <k>` — atomic teammate spawn. Decision
 * multi-engine-tui-architecture §"Round-trips are atomic by default" makes a `--prompt` an
 * atomic first turn; `--no-wait` is gone. Engine selection is the
 * explicit `--engine` flag (decision codex-engine-flag §1, carried forward).
 *
 * Phase 1 lands the skeleton: parse a `SpawnRequest`, look the engine
 * up in the registry, dispatch. With the Phase 1 empty registry, the
 * verb falls through to `noEngineRegistered()`; Phase 2 registers the
 * concrete Claude / Codex engines and the spawn round-trip becomes
 * live.
 */

import { readFileSync } from 'node:fs'

import { noEngineRegistered } from './format'
import type {
  EngineKind,
  SpawnRequest,
  SpawnResult,
  TeammateName,
} from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { recordHistorySession } from '../persistence/history-index'
import { sidFile, worktreeBranchFor } from '../persistence/paths'
import { codexThreadFile } from '../engines/codex/persistence'

export interface SpawnArgs {
  readonly name: TeammateName
  readonly engine: EngineKind
  readonly repo: string
  readonly cwd: string
  readonly worktreeSlug: string | null
  readonly resumeCheckpoint: string | null
  readonly prompt: string | null
  readonly timeoutMs: number | null
  readonly displayName: string | null
  readonly baseRef: string | null
  readonly branch: string | null
  /** Resolved Remote Control opt-in (Claude-only; see SpawnRequest). */
  readonly remoteControl: boolean
}

function readMarker(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function sessionIdFor(engine: EngineKind, name: string): string | null {
  return engine === 'codex' ? readMarker(codexThreadFile(name)) : readMarker(sidFile(name))
}

export async function spawnVerb(args: SpawnArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = ctx.engines.get(args.engine)
  if (engine === undefined) return noEngineRegistered()
  if (engine.kind !== 'claude' && args.resumeCheckpoint !== null) {
    return {
      code: 1,
      stdout: '',
      stderr: 'tm: tm spawn: --resume is not supported for codex teammates\n',
    }
  }

  const req: SpawnRequest = {
    name: args.name,
    repo: args.repo,
    cwd: args.cwd,
    worktreeSlug: args.worktreeSlug,
    resumeCheckpoint: args.resumeCheckpoint,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
    displayName: args.displayName,
    remoteControl: args.remoteControl,
  }
  const result: SpawnResult = await engine.spawn(req, ctx.engineContext)
  if (result.kind === 'spawned') {
    recordHistorySession({
      id: sessionIdFor(args.engine, args.name),
      engine: args.engine,
      name: args.name,
      repo: args.repo,
      cwd: args.cwd,
      worktreeSlug: args.worktreeSlug,
      branch: args.branch ?? (args.worktreeSlug === null ? null : worktreeBranchFor(args.worktreeSlug)),
      baseRef: args.baseRef,
      createdAt: new Date(ctx.engineContext.now()).toISOString(),
      intent: args.displayName,
    })
  }
  if (result.tmResult !== undefined) {
    return result.tmResult
  }

  switch (result.kind) {
    case 'spawned':
      return { code: 0, stdout: `spawned: ${result.name}\n`, stderr: '' }
    case 'already-exists':
      if (args.engine === 'codex') {
        return {
          code: 1,
          stdout: '',
          stderr: `tm: codex teammate '${args.name}' already exists (engine=${result.existingEngine})\n`,
        }
      }
      return {
        code: 1,
        stdout: '',
        stderr: `tm: '${args.name}' already exists as a ${result.existingEngine} teammate\n`,
      }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: ${result.message}\n` }
  }
}
