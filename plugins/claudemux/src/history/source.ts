import { realpathSync } from 'node:fs'

import type { EngineKind } from '../engines/types'
import type {
  HistoryCloseStatus,
  HistoryCreatedAtSource,
  HistoryRuntimeState,
  HistorySource,
} from '../persistence/history-index'

export interface HistoryQueryRow {
  readonly id: string | null
  readonly engine: EngineKind
  readonly name: string | null
  readonly repo: string | null
  readonly cwd: string | null
  readonly worktreeSlug: string | null
  readonly branch: string | null
  readonly baseRef: string | null
  readonly createdAt: string | null
  readonly createdAtSource: HistoryCreatedAtSource
  readonly lastSeenAt: string | null
  readonly state: HistoryRuntimeState
  readonly intent: string | null
  readonly closeStatus: HistoryCloseStatus | null
  readonly closeNotePreview: string | null
  readonly lastAssistantPreview: string | null
  readonly resumeCommand: string | null
  readonly source: HistorySource
  readonly topic: string | null
  readonly path: string | null
  readonly sizeBytes: number | null
}

export type HistoryCandidateRow =
  Omit<HistoryQueryRow, 'resumeCommand'> & { readonly resumeCommand?: string | null }

export interface HistoryRowWithSort {
  readonly row: HistoryCandidateRow
  readonly createdAtMs: number | null
  readonly lastSeenAtMs: number | null
}

export function cleanHistoryPreview(text: string | null, limit = 300): string | null {
  if (text === null || text.length === 0) return null
  const first = text.split('\n')[0] ?? ''
  const stripped = [...first].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
  if (stripped.length <= limit) return stripped.join('')
  return `${stripped.slice(0, limit).join('')}...`
}

export function parseHistoryTimeMs(value: string | null): number | null {
  if (value === null || value.length === 0) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function isoHistoryTime(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString()
}

export function historyIdMatches(id: string | null, prefix: string | null): boolean {
  if (prefix === null) return true
  return id !== null && id.toLowerCase().startsWith(prefix.toLowerCase())
}

export function comparableHistoryPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
