/**
 * `tm history` — agent-facing teammate session lookup.
 *
 * The public grammar is flag-only. The retired `tm history <name> [id]`
 * shape is deliberately rejected so dispatchers learn to query by the
 * durable axes: repo, id, time, intent, state, and close status.
 */

import type { EngineKind } from '../engines/types'
import type { TmResult } from '../tm'
import type { NativeEnv } from '../env'
import type { VerbContext } from './context'
import {
  queryHistory,
  validateHistoryFields,
  type HistoryFormat,
  type HistoryQuery,
} from './history-query'
import type { HistoryCloseStatus, HistoryRuntimeState } from '../persistence/history-index'

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

function parseTimeFlag(flag: string, value: string): number | TmResult {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) return die(`tm history: ${flag} is not a parseable date/time: ${value}`)
  return parsed
}

function parsePageInt(flag: string, value: string): number | TmResult {
  const n = Number(value)
  const min = flag === '--limit' ? 1 : 0
  if (!Number.isInteger(n) || n < min) {
    return die(`tm history: ${flag} must be ${min === 0 ? 'a non-negative' : 'a positive'} integer`)
  }
  return n
}

function parseEngine(value: string): EngineKind | TmResult {
  if (value === 'claude' || value === 'codex') return value
  return die(`tm history: --engine must be 'claude' or 'codex' (got: '${value}')`)
}

function parseState(value: string): HistoryRuntimeState | TmResult {
  if (
    value === 'idle' ||
    value === 'busy' ||
    value === 'borrowed' ||
    value === 'killed' ||
    value === 'orphaned' ||
    value === 'unknown'
  ) return value
  return die(
    `tm history: --state must be one of idle,busy,borrowed,killed,orphaned,unknown ` +
      `(got: '${value}')`,
  )
}

function parseCloseStatus(value: string): HistoryCloseStatus | TmResult {
  if (
    value === 'merged' ||
    value === 'done' ||
    value === 'shelved' ||
    value === 'abandoned' ||
    value === 'blocked'
  ) return value
  return die(
    `tm history: --status must be one of merged,done,shelved,abandoned,blocked ` +
      `(got: '${value}')`,
  )
}

function needsValue(rest: readonly string[], index: number, flag: string): string | TmResult {
  if (index + 1 >= rest.length) return die(`tm history: ${flag} requires a value`)
  return rest[index + 1]!
}

export function parseHistoryArgs(rest: readonly string[]): HistoryQuery | { error: TmResult } {
  let repo: string | null = null
  let name: string | null = null
  let id: string | null = null
  let engine: EngineKind | null = null
  let sinceMs: number | null = null
  let untilMs: number | null = null
  let state: HistoryRuntimeState | null = null
  let closeStatus: HistoryCloseStatus | null = null
  let grep: string | null = null
  let limit = 50
  let cursor = 0
  let fields: readonly string[] | null = null
  let format: HistoryFormat = 'json'

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    const take = (flag: string): string | TmResult => {
      const value = needsValue(rest, i, flag)
      if (typeof value === 'string') i++
      return value
    }

    if (arg === '--repo') {
      const value = take('--repo')
      if (typeof value !== 'string') return { error: value }
      repo = value
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length)
    } else if (arg === '--name') {
      const value = take('--name')
      if (typeof value !== 'string') return { error: value }
      name = value
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (arg === '--id') {
      const value = take('--id')
      if (typeof value !== 'string') return { error: value }
      id = value
    } else if (arg.startsWith('--id=')) {
      id = arg.slice('--id='.length)
    } else if (arg === '--engine') {
      const value = take('--engine')
      if (typeof value !== 'string') return { error: value }
      const parsed = parseEngine(value)
      if (typeof parsed !== 'string') return { error: parsed }
      engine = parsed
    } else if (arg.startsWith('--engine=')) {
      const parsed = parseEngine(arg.slice('--engine='.length))
      if (typeof parsed !== 'string') return { error: parsed }
      engine = parsed
    } else if (arg === '--since') {
      const value = take('--since')
      if (typeof value !== 'string') return { error: value }
      const parsed = parseTimeFlag('--since', value)
      if (typeof parsed !== 'number') return { error: parsed }
      sinceMs = parsed
    } else if (arg.startsWith('--since=')) {
      const parsed = parseTimeFlag('--since', arg.slice('--since='.length))
      if (typeof parsed !== 'number') return { error: parsed }
      sinceMs = parsed
    } else if (arg === '--until') {
      const value = take('--until')
      if (typeof value !== 'string') return { error: value }
      const parsed = parseTimeFlag('--until', value)
      if (typeof parsed !== 'number') return { error: parsed }
      untilMs = parsed
    } else if (arg.startsWith('--until=')) {
      const parsed = parseTimeFlag('--until', arg.slice('--until='.length))
      if (typeof parsed !== 'number') return { error: parsed }
      untilMs = parsed
    } else if (arg === '--state') {
      const value = take('--state')
      if (typeof value !== 'string') return { error: value }
      const parsed = parseState(value)
      if (typeof parsed !== 'string') return { error: parsed }
      state = parsed
    } else if (arg.startsWith('--state=')) {
      const parsed = parseState(arg.slice('--state='.length))
      if (typeof parsed !== 'string') return { error: parsed }
      state = parsed
    } else if (arg === '--status') {
      const value = take('--status')
      if (typeof value !== 'string') return { error: value }
      const parsed = parseCloseStatus(value)
      if (typeof parsed !== 'string') return { error: parsed }
      closeStatus = parsed
    } else if (arg.startsWith('--status=')) {
      const parsed = parseCloseStatus(arg.slice('--status='.length))
      if (typeof parsed !== 'string') return { error: parsed }
      closeStatus = parsed
    } else if (arg === '--grep') {
      const value = take('--grep')
      if (typeof value !== 'string') return { error: value }
      grep = value
    } else if (arg.startsWith('--grep=')) {
      grep = arg.slice('--grep='.length)
    } else if (arg === '--limit') {
      const value = take('--limit')
      if (typeof value !== 'string') return { error: value }
      const parsed = parsePageInt('--limit', value)
      if (typeof parsed !== 'number') return { error: parsed }
      limit = parsed
    } else if (arg.startsWith('--limit=')) {
      const parsed = parsePageInt('--limit', arg.slice('--limit='.length))
      if (typeof parsed !== 'number') return { error: parsed }
      limit = parsed
    } else if (arg === '--cursor') {
      const value = take('--cursor')
      if (typeof value !== 'string') return { error: value }
      const parsed = parsePageInt('--cursor', value)
      if (typeof parsed !== 'number') return { error: parsed }
      cursor = parsed
    } else if (arg.startsWith('--cursor=')) {
      const parsed = parsePageInt('--cursor', arg.slice('--cursor='.length))
      if (typeof parsed !== 'number') return { error: parsed }
      cursor = parsed
    } else if (arg === '--fields') {
      const value = take('--fields')
      if (typeof value !== 'string') return { error: value }
      fields = value.split(',').filter((field) => field.length > 0)
    } else if (arg.startsWith('--fields=')) {
      fields = arg.slice('--fields='.length).split(',').filter((field) => field.length > 0)
    } else if (arg === '--json') {
      format = 'json'
    } else if (arg === '--oneline') {
      format = 'oneline'
    } else if (arg === '--table') {
      format = 'table'
    } else if (arg.startsWith('-')) {
      return { error: die(`tm history: unknown flag: ${arg}`) }
    } else {
      return {
        error: die(
          `tm history: positional arguments were removed. Use ` +
            `--name ${arg} to filter by teammate attribution, or --id <id> for a session.`,
        ),
      }
    }
  }

  if (fields !== null) {
    const err = validateHistoryFields(fields)
    if (err !== null) return { error: err }
  }
  return {
    repo,
    name,
    id,
    engine,
    sinceMs,
    untilMs,
    state,
    closeStatus,
    grep,
    limit,
    cursor,
    fields,
    format,
  }
}

export async function historyVerb(query: HistoryQuery, ctx: VerbContext, env: NativeEnv): Promise<TmResult> {
  const listings = (await Promise.all(ctx.engines.registered().map((engine) => engine.list(ctx.engineContext))))
    .flatMap((rows) => rows)
  return queryHistory(query, listings, env)
}
