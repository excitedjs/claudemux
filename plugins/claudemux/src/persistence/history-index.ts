/**
 * Forward-only session metadata index for `tm history`.
 *
 * This is tm-owned implementation state. It never reads or imports the
 * retired dispatcher Markdown ledger; events only accrue from future `tm`
 * operations. Existing transcripts and rollouts remain read-only enrichment
 * and recovery sources in the query layer.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EngineKind, TeammateName } from '../engines/types'
import { identityRoot } from './identity-store'

export type HistoryRuntimeState =
  | 'idle'
  | 'busy'
  | 'borrowed'
  | 'killed'
  | 'orphaned'
  | 'unknown'

export type HistoryCloseStatus =
  | 'merged'
  | 'done'
  | 'shelved'
  | 'abandoned'
  | 'blocked'

export type HistoryCreatedAtSource = 'index' | 'jsonl' | 'mtime' | 'unknown'

export type HistorySource = 'index' | 'identity' | 'transcript' | 'rollout'

export interface HistoryIndexEvent {
  readonly schema: 1
  readonly event: 'session' | 'close'
  readonly recordedAt: string
  readonly id: string | null
  readonly engine: EngineKind | null
  readonly name: TeammateName | null
  readonly repo: string | null
  readonly cwd: string | null
  readonly worktreeSlug: string | null
  readonly branch: string | null
  readonly baseRef: string | null
  readonly createdAt: string | null
  readonly intent: string | null
  readonly closeStatus: HistoryCloseStatus | null
  readonly closeNotePreview: string | null
}

export interface HistoryIndexUpsert {
  readonly id?: string | null
  readonly engine: EngineKind
  readonly name: TeammateName | null
  readonly repo: string | null
  readonly cwd: string | null
  readonly worktreeSlug: string | null
  readonly branch: string | null
  readonly baseRef: string | null
  readonly createdAt: string | null
  readonly intent: string | null
}

export interface HistoryCloseUpdate {
  readonly id: string | null
  readonly engine: EngineKind | null
  readonly name: TeammateName | null
  readonly repo: string | null
  readonly cwd: string | null
  readonly status: HistoryCloseStatus
  readonly note: string | null
}

export interface HistoryIndexRecord {
  readonly id: string | null
  readonly engine: EngineKind | null
  readonly name: TeammateName | null
  readonly repo: string | null
  readonly cwd: string | null
  readonly worktreeSlug: string | null
  readonly branch: string | null
  readonly baseRef: string | null
  readonly createdAt: string | null
  readonly intent: string | null
  readonly closeStatus: HistoryCloseStatus | null
  readonly closeNotePreview: string | null
}

export function historyIndexFile(): string {
  return join(identityRoot(), 'teammate-history.jsonl')
}

function nowIso(): string {
  return new Date().toISOString()
}

function preview(text: string | null): string | null {
  if (text === null) return null
  const first = text.split('\n')[0] ?? ''
  const stripped = [...first].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f).join('')
  if (stripped.length <= 180) return stripped
  return `${[...stripped].slice(0, 180).join('')}...`
}

function append(event: HistoryIndexEvent): void {
  try {
    mkdirSync(identityRoot(), { recursive: true })
    appendFileSync(historyIndexFile(), `${JSON.stringify(event)}\n`, { mode: 0o600 })
  } catch {
    // History metadata must never make the lifecycle verb fail. The query
    // layer will still recover from transcripts/rollouts where possible.
  }
}

export function recordHistorySession(input: HistoryIndexUpsert): void {
  append({
    schema: 1,
    event: 'session',
    recordedAt: nowIso(),
    id: input.id ?? null,
    engine: input.engine,
    name: input.name,
    repo: input.repo,
    cwd: input.cwd,
    worktreeSlug: input.worktreeSlug,
    branch: input.branch,
    baseRef: input.baseRef,
    createdAt: input.createdAt,
    intent: input.intent,
    closeStatus: null,
    closeNotePreview: null,
  })
}

export function recordHistoryClose(input: HistoryCloseUpdate): void {
  append({
    schema: 1,
    event: 'close',
    recordedAt: nowIso(),
    id: input.id,
    engine: input.engine,
    name: input.name,
    repo: input.repo,
    cwd: input.cwd,
    worktreeSlug: null,
    branch: null,
    baseRef: null,
    createdAt: null,
    intent: null,
    closeStatus: input.status,
    closeNotePreview: preview(input.note),
  })
}

function parseEvent(raw: string): HistoryIndexEvent | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (obj['schema'] !== 1) return null
  if (obj['event'] !== 'session' && obj['event'] !== 'close') return null
  const engine = obj['engine']
  if (engine !== null && engine !== 'claude' && engine !== 'codex') return null
  const closeStatus = obj['closeStatus']
  if (
    closeStatus !== null &&
    closeStatus !== 'merged' &&
    closeStatus !== 'done' &&
    closeStatus !== 'shelved' &&
    closeStatus !== 'abandoned' &&
    closeStatus !== 'blocked'
  ) return null
  const stringOrNull = (key: string): string | null => {
    const v = obj[key]
    return typeof v === 'string' ? v : null
  }
  return {
    schema: 1,
    event: obj['event'],
    recordedAt: stringOrNull('recordedAt') ?? '',
    id: stringOrNull('id'),
    engine,
    name: stringOrNull('name'),
    repo: stringOrNull('repo'),
    cwd: stringOrNull('cwd'),
    worktreeSlug: stringOrNull('worktreeSlug'),
    branch: stringOrNull('branch'),
    baseRef: stringOrNull('baseRef'),
    createdAt: stringOrNull('createdAt'),
    intent: stringOrNull('intent'),
    closeStatus,
    closeNotePreview: stringOrNull('closeNotePreview'),
  }
}

export function readHistoryEvents(): readonly HistoryIndexEvent[] {
  let raw: string
  try {
    raw = readFileSync(historyIndexFile(), 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseEvent(line))
    .filter((event): event is HistoryIndexEvent => event !== null)
}

function mergeRecord(base: HistoryIndexRecord | undefined, event: HistoryIndexEvent): HistoryIndexRecord {
  return {
    id: event.id ?? base?.id ?? null,
    engine: event.engine ?? base?.engine ?? null,
    name: event.name ?? base?.name ?? null,
    repo: event.repo ?? base?.repo ?? null,
    cwd: event.cwd ?? base?.cwd ?? null,
    worktreeSlug: event.worktreeSlug ?? base?.worktreeSlug ?? null,
    branch: event.branch ?? base?.branch ?? null,
    baseRef: event.baseRef ?? base?.baseRef ?? null,
    createdAt: base?.createdAt ?? event.createdAt ?? null,
    intent: event.intent ?? base?.intent ?? null,
    closeStatus: event.closeStatus ?? base?.closeStatus ?? null,
    closeNotePreview: event.closeNotePreview ?? base?.closeNotePreview ?? null,
  }
}

function mergeRecordFields(base: HistoryIndexRecord | undefined, extra: HistoryIndexRecord): HistoryIndexRecord {
  return {
    id: base?.id ?? extra.id,
    engine: base?.engine ?? extra.engine,
    name: base?.name ?? extra.name,
    repo: base?.repo ?? extra.repo,
    cwd: base?.cwd ?? extra.cwd,
    worktreeSlug: base?.worktreeSlug ?? extra.worktreeSlug,
    branch: base?.branch ?? extra.branch,
    baseRef: base?.baseRef ?? extra.baseRef,
    createdAt: base?.createdAt ?? extra.createdAt,
    intent: base?.intent ?? extra.intent,
    closeStatus: extra.closeStatus ?? base?.closeStatus ?? null,
    closeNotePreview: extra.closeNotePreview ?? base?.closeNotePreview ?? null,
  }
}

function attributionKey(
  input: Pick<HistoryIndexEvent, 'engine' | 'name' | 'cwd' | 'repo'>,
): string | null {
  if (input.engine === null || input.name === null) return null
  const cwd = input.cwd ?? input.repo
  return cwd === null ? null : `${input.engine}:${input.name}:${cwd}`
}

function eventKey(event: HistoryIndexEvent): string {
  if (event.id !== null) return `id:${event.id}`
  const engine = event.engine ?? 'unknown'
  const name = event.name ?? 'unknown'
  const cwd = event.cwd ?? event.repo ?? 'unknown'
  return `open:${engine}:${name}:${cwd}`
}

export function listHistoryIndexRecords(): readonly HistoryIndexRecord[] {
  const map = new Map<string, HistoryIndexRecord>()
  const attributedIdKeys = new Map<string, string>()
  for (const event of readHistoryEvents()) {
    const attr = attributionKey(event)
    let key = eventKey(event)
    if (event.id !== null) {
      key = `id:${event.id}`
      if (attr !== null) {
        const openKey = eventKey({ ...event, id: null })
        const openRecord = map.get(openKey)
        if (openRecord !== undefined) {
          map.set(key, mergeRecordFields(map.get(key), openRecord))
          map.delete(openKey)
        }
        attributedIdKeys.set(attr, key)
      }
    } else if (attr !== null) {
      key = attributedIdKeys.get(attr) ?? key
    }
    map.set(key, mergeRecord(map.get(key), event))
  }
  return [...map.values()]
}
