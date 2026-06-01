import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import type { EngineKind, TeammateListing } from '../engines/types'
import { readCodexRolloutSnapshot, listCodexRolloutFiles } from '../engines/codex/rollout'
import {
  listHistoryIndexRecords,
  type HistoryCloseStatus,
  type HistoryCreatedAtSource,
  type HistoryRuntimeState,
  type HistorySource,
} from '../persistence/history-index'
import { listArchived } from '../persistence/identity-store'
import { encodeProjectDir, sidFile, worktreeBranchFor } from '../persistence/paths'
import type { NativeEnv } from '../env'
import type { TmResult } from '../tm'

export type HistoryFormat = 'json' | 'oneline' | 'table'

export interface HistoryQuery {
  readonly repo: string | null
  readonly name: string | null
  readonly id: string | null
  readonly engine: EngineKind | null
  readonly sinceMs: number | null
  readonly untilMs: number | null
  readonly state: HistoryRuntimeState | null
  readonly closeStatus: HistoryCloseStatus | null
  readonly grep: string | null
  readonly limit: number
  readonly cursor: number
  readonly fields: readonly string[] | null
  readonly format: HistoryFormat
}

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

interface RowWithSort {
  readonly row: Omit<HistoryQueryRow, 'resumeCommand'> & { readonly resumeCommand?: string | null }
  readonly createdAtMs: number | null
  readonly lastSeenAtMs: number | null
}

export const HISTORY_JSON_FIELDS = [
  'id',
  'engine',
  'name',
  'repo',
  'cwd',
  'worktreeSlug',
  'branch',
  'baseRef',
  'createdAt',
  'createdAtSource',
  'lastSeenAt',
  'state',
  'intent',
  'closeStatus',
  'closeNotePreview',
  'lastAssistantPreview',
  'resumeCommand',
  'source',
  'topic',
  'path',
  'sizeBytes',
] as const

const FIELD_SET = new Set<string>(HISTORY_JSON_FIELDS)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function cleanPreview(text: string | null, limit = 300): string | null {
  if (text === null || text.length === 0) return null
  const first = text.split('\n')[0] ?? ''
  const stripped = [...first].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
  if (stripped.length <= limit) return stripped.join('')
  return `${stripped.slice(0, limit).join('')}...`
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseTimeMs(value: string | null): number | null {
  if (value === null || value.length === 0) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString()
}

function comparablePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function projectDirForCwd(projectsDir: string, cwd: string): string {
  return join(projectsDir, encodeProjectDir(comparablePath(cwd)))
}

function repoLeaf(path: string | null): string | null {
  if (path === null || path.length === 0) return null
  return basename(path.replace(/\/+$/, ''))
}

function repoMatches(row: HistoryQueryRow, filter: string | null, resolved: string | null): boolean {
  if (filter === null) return true
  const candidates = [row.repo, row.cwd].filter((v): v is string => v !== null && v.length > 0)
  if (resolved !== null) {
    const cmp = comparablePath(resolved)
    if (candidates.some((candidate) => comparablePath(candidate) === cmp)) return true
  }
  return candidates.some((candidate) => candidate === filter || repoLeaf(candidate) === filter)
}

function globMatches(value: string | null, pattern: string | null): boolean {
  if (pattern === null) return true
  if (value === null) return false
  if (!pattern.includes('*')) return value === pattern
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

function idMatches(id: string | null, prefix: string | null): boolean {
  if (prefix === null) return true
  return id !== null && id.toLowerCase().startsWith(prefix.toLowerCase())
}

function grepMatches(row: HistoryQueryRow, needle: string | null): boolean {
  if (needle === null) return true
  const q = needle.toLowerCase()
  return [
    row.intent,
    row.topic,
    row.lastAssistantPreview,
    row.closeNotePreview,
  ].some((field) => field !== null && field.toLowerCase().includes(q))
}

function rowKey(row: HistoryQueryRow): string {
  if (row.id !== null) return `${row.engine}:${row.id}`
  return `${row.engine}:${row.name ?? '-'}:${row.cwd ?? row.repo ?? '-'}:${row.source}`
}

function rowScoreSource(source: HistorySource): number {
  switch (source) {
    case 'index': return 4
    case 'identity': return 3
    case 'transcript': return 2
    case 'rollout': return 2
  }
}

function mergeRows(a: RowWithSort, b: RowWithSort): RowWithSort {
  const row = {
    id: a.row.id ?? b.row.id,
    engine: a.row.engine,
    name: a.row.name ?? b.row.name,
    repo: a.row.repo ?? b.row.repo,
    cwd: a.row.cwd ?? b.row.cwd,
    worktreeSlug: a.row.worktreeSlug ?? b.row.worktreeSlug,
    branch: a.row.branch ?? b.row.branch,
    baseRef: a.row.baseRef ?? b.row.baseRef,
    createdAt: a.row.createdAtSource === 'jsonl' ? a.row.createdAt : (b.row.createdAt ?? a.row.createdAt),
    createdAtSource: a.row.createdAtSource === 'jsonl' ? a.row.createdAtSource : b.row.createdAtSource,
    lastSeenAt: a.row.lastSeenAt ?? b.row.lastSeenAt,
    state: rankState(a.row.state) >= rankState(b.row.state) ? a.row.state : b.row.state,
    intent: a.row.intent ?? b.row.intent,
    closeStatus: a.row.closeStatus ?? b.row.closeStatus,
    closeNotePreview: a.row.closeNotePreview ?? b.row.closeNotePreview,
    lastAssistantPreview: a.row.lastAssistantPreview ?? b.row.lastAssistantPreview,
    resumeCommand: a.row.resumeCommand ?? b.row.resumeCommand,
    source: rowScoreSource(a.row.source) >= rowScoreSource(b.row.source) ? a.row.source : b.row.source,
    topic: a.row.topic ?? b.row.topic,
    path: a.row.path ?? b.row.path,
    sizeBytes: a.row.sizeBytes ?? b.row.sizeBytes,
  } satisfies Omit<HistoryQueryRow, 'resumeCommand'> & { readonly resumeCommand?: string | null }
  return {
    row,
    createdAtMs: a.createdAtMs ?? b.createdAtMs,
    lastSeenAtMs: a.lastSeenAtMs ?? b.lastSeenAtMs,
  }
}

function rankState(state: HistoryRuntimeState): number {
  switch (state) {
    case 'busy': return 7
    case 'borrowed': return 6
    case 'idle': return 5
    case 'killed': return 3
    case 'orphaned': return 2
    case 'unknown': return 1
  }
}

function promptFromClaudeEntry(entry: Record<string, unknown>): string | null {
  const message = entry['message']
  if (!isPlainObject(message) || message['role'] !== 'user') return null
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item) || item['type'] !== 'text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

function assistantFromClaudeEntry(entry: Record<string, unknown>): string | null {
  const message = entry['message']
  if (!isPlainObject(message)) return null
  const content = message['content']
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item) || item['type'] !== 'text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

function readClaudeTranscript(path: string): {
  readonly firstPrompt: string | null
  readonly lastAssistant: string | null
  readonly createdAt: string | null
  readonly createdAtMs: number | null
} {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { firstPrompt: null, lastAssistant: null, createdAt: null, createdAtMs: null }
  }
  let firstPrompt: string | null = null
  let lastAssistant: string | null = null
  let firstTs: string | null = null
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlainObject(parsed)) continue
    if (firstTs === null) firstTs = stringProp(parsed, 'timestamp')
    if (parsed['type'] === 'user' && firstPrompt === null) firstPrompt = promptFromClaudeEntry(parsed)
    if (parsed['type'] === 'assistant') lastAssistant = assistantFromClaudeEntry(parsed) ?? lastAssistant
  }
  const createdAtMs = parseTimeMs(firstTs)
  return { firstPrompt, lastAssistant, createdAt: firstTs, createdAtMs }
}

function textFromCodexContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const type = item['type']
    if (type !== 'input_text' && type !== 'output_text' && type !== 'text') continue
    const text = stringProp(item, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

function promptFromCodexEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null
  if (payload['type'] === 'user_message' || payload['type'] === 'userMessage') {
    return stringProp(payload, 'message') ?? stringProp(payload, 'text')
  }
  if (entry['type'] === 'response_item' && payload['type'] === 'message' && payload['role'] === 'user') {
    return textFromCodexContent(payload['content'])
  }
  return null
}

function cwdFromCodexEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null
  return stringProp(payload, 'cwd')
}

function readCodexHeader(path: string): {
  readonly cwd: string | null
  readonly firstPrompt: string | null
  readonly createdAt: string | null
  readonly createdAtMs: number | null
} {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { cwd: null, firstPrompt: null, createdAt: null, createdAtMs: null }
  }
  let cwd: string | null = null
  let firstPrompt: string | null = null
  let createdAt: string | null = null
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (createdAt === null && isPlainObject(parsed)) createdAt = stringProp(parsed, 'timestamp')
    cwd = cwd ?? cwdFromCodexEntry(parsed)
    firstPrompt = firstPrompt ?? promptFromCodexEntry(parsed)
    if (cwd !== null && firstPrompt !== null && createdAt !== null) break
  }
  return { cwd, firstPrompt, createdAt, createdAtMs: parseTimeMs(createdAt) }
}

function liveIdFor(listing: TeammateListing): string | null {
  if (listing.engine === 'codex') {
    const thread = listing.extras['thread']
    return thread !== undefined && thread.length > 0 ? thread : null
  }
  try {
    const sid = readFileSync(sidFile(listing.name), 'utf8').trim()
    return sid.length > 0 ? sid : null
  } catch {
    return null
  }
}

function withResumeCommand(row: Omit<HistoryQueryRow, 'resumeCommand'> & { readonly resumeCommand?: string | null }): HistoryQueryRow {
  if (row.resumeCommand !== undefined) return { ...row, resumeCommand: row.resumeCommand }
  if (row.id === null || (row.repo === null && row.cwd === null)) return { ...row, resumeCommand: null }
  const repo = row.repo ?? row.cwd!
  const parts = [
    'tm',
    'resume',
    '--engine',
    row.engine,
    '--repo',
    shellSingleQuote(repo),
    '--id',
    shellSingleQuote(row.id),
  ]
  if (row.name !== null) parts.push('--name', shellSingleQuote(row.name))
  if (row.intent !== null) parts.push('--intent', shellSingleQuote(row.intent))
  return { ...row, resumeCommand: parts.join(' ') }
}

function normalizeRows(rows: readonly RowWithSort[]): readonly RowWithSort[] {
  const map = new Map<string, RowWithSort>()
  for (const candidate of rows) {
    const key = rowKey(withResumeCommand(candidate.row))
    const existing = map.get(key)
    map.set(key, existing === undefined ? candidate : mergeRows(existing, candidate))
  }
  return [...map.values()].sort((a, b) => {
    const at = a.lastSeenAtMs ?? a.createdAtMs ?? 0
    const bt = b.lastSeenAtMs ?? b.createdAtMs ?? 0
    return bt - at || ((a.row.id ?? '') < (b.row.id ?? '') ? -1 : 1)
  })
}

function rowsFromIndex(): RowWithSort[] {
  return listHistoryIndexRecords()
    .filter((record) => record.engine !== null)
    .map((record) => {
      const createdAtMs = parseTimeMs(record.createdAt)
      return {
        row: {
          id: record.id,
          engine: record.engine!,
          name: record.name,
          repo: record.repo,
          cwd: record.cwd,
          worktreeSlug: record.worktreeSlug,
          branch: record.branch,
          baseRef: record.baseRef,
          createdAt: record.createdAt,
          createdAtSource: record.createdAt === null ? 'unknown' : 'index',
          lastSeenAt: null,
          state: record.closeStatus === null ? 'unknown' : 'killed',
          intent: record.intent,
          closeStatus: record.closeStatus,
          closeNotePreview: record.closeNotePreview,
          lastAssistantPreview: null,
          source: 'index',
          topic: null,
          path: null,
          sizeBytes: null,
        },
        createdAtMs,
        lastSeenAtMs: null,
      }
    })
}

function rowsFromListings(listings: readonly TeammateListing[]): RowWithSort[] {
  return listings.map((listing) => {
    const id = liveIdFor(listing)
    const now = Date.now()
    return {
      row: {
        id,
        engine: listing.engine,
        name: listing.name,
        repo: listing.repo || null,
        cwd: listing.cwd || null,
        worktreeSlug: listing.worktreeSlug,
        branch: listing.worktreeSlug === null ? null : worktreeBranchFor(listing.worktreeSlug),
        baseRef: null,
        createdAt: null,
        createdAtSource: 'unknown',
        lastSeenAt: iso(now),
        state: listing.state === 'killed' ? 'killed' : listing.state,
        intent: listing.displayName,
        closeStatus: null,
        closeNotePreview: null,
        lastAssistantPreview: listing.extras['preview'] === '-' ? null : listing.extras['preview'] ?? null,
        source: 'identity',
        topic: listing.displayName,
        path: null,
        sizeBytes: null,
      },
      createdAtMs: null,
      lastSeenAtMs: now,
    }
  })
}

function rowsFromArchived(): RowWithSort[] {
  return listArchived().map((record) => ({
    row: {
      id: null,
      engine: record.engine,
      name: record.name,
      repo: record.repo,
      cwd: record.cwd,
      worktreeSlug: record.worktreeSlug,
      branch: record.worktreeSlug === null ? null : worktreeBranchFor(record.worktreeSlug),
      baseRef: null,
      createdAt: iso(record.createdAt * 1000),
      createdAtSource: 'index',
      lastSeenAt: null,
      state: 'killed',
      intent: record.displayName,
      closeStatus: null,
      closeNotePreview: null,
      lastAssistantPreview: null,
      source: 'identity',
      topic: record.displayName,
      path: null,
      sizeBytes: null,
    },
    createdAtMs: record.createdAt * 1000,
    lastSeenAtMs: null,
  }))
}

function scanClaudeProject(cwd: string | null, projectDir: string, idPrefix: string | null): RowWithSort[] {
  let files: string[]
  try {
    files = readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: RowWithSort[] = []
  for (const fileName of files) {
    const id = fileName.replace(/\.jsonl$/, '')
    if (!idMatches(id, idPrefix)) continue
    const path = join(projectDir, fileName)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    const data = readClaudeTranscript(path)
    const createdAtMs = data.createdAtMs ?? st.mtimeMs
    const createdAtSource: HistoryCreatedAtSource = data.createdAtMs === null ? 'mtime' : 'jsonl'
    out.push({
      row: {
        id,
        engine: 'claude',
        name: null,
        repo: cwd,
        cwd,
        worktreeSlug: null,
        branch: null,
        baseRef: null,
        createdAt: iso(createdAtMs),
        createdAtSource,
        lastSeenAt: iso(st.mtimeMs),
        state: 'orphaned',
        intent: null,
        closeStatus: null,
        closeNotePreview: null,
        lastAssistantPreview: cleanPreview(data.lastAssistant),
        source: 'transcript',
        topic: cleanPreview(data.firstPrompt, 120),
        path,
        sizeBytes: st.size,
      },
      createdAtMs,
      lastSeenAtMs: st.mtimeMs,
    })
  }
  return out
}

function rowsFromClaude(env: NativeEnv, knownCwds: readonly string[], idPrefix: string | null): RowWithSort[] {
  const out: RowWithSort[] = []
  const seenProjectDirs = new Set<string>()
  for (const cwd of knownCwds) {
    const projectDir = projectDirForCwd(env.projectsDir, cwd)
    seenProjectDirs.add(projectDir)
    out.push(...scanClaudeProject(cwd, projectDir, idPrefix))
  }
  if (idPrefix !== null) {
    let dirs: string[]
    try {
      dirs = readdirSync(env.projectsDir)
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      const projectDir = join(env.projectsDir, dir)
      if (seenProjectDirs.has(projectDir)) continue
      out.push(...scanClaudeProject(null, projectDir, idPrefix))
    }
  }
  return out
}

function cwdAllowed(cwd: string | null, knownCwds: readonly string[], allowGlobal: boolean): boolean {
  if (allowGlobal) return true
  if (cwd === null) return false
  const comparable = comparablePath(cwd)
  return knownCwds.some((known) => comparablePath(known) === comparable)
}

function rowsFromCodex(
  idPrefix: string | null,
  knownCwds: readonly string[],
  allowGlobal: boolean,
): RowWithSort[] {
  const out: RowWithSort[] = []
  for (const file of listCodexRolloutFiles(process.env)) {
    if (!idMatches(file.threadId, idPrefix)) continue
    const st = (() => {
      try {
        return statSync(file.path)
      } catch {
        return null
      }
    })()
    if (st === null) continue
    const header = readCodexHeader(file.path)
    if (!cwdAllowed(header.cwd, knownCwds, allowGlobal)) continue
    const snapshot = readCodexRolloutSnapshot(file.threadId, process.env)
    const createdAtMs = header.createdAtMs ?? st.mtimeMs
    out.push({
      row: {
        id: file.threadId,
        engine: 'codex',
        name: null,
        repo: header.cwd,
        cwd: header.cwd,
        worktreeSlug: null,
        branch: null,
        baseRef: null,
        createdAt: iso(createdAtMs),
        createdAtSource: header.createdAtMs === null ? 'mtime' : 'jsonl',
        lastSeenAt: iso(st.mtimeMs),
        state: 'orphaned',
        intent: null,
        closeStatus: null,
        closeNotePreview: null,
        lastAssistantPreview: cleanPreview(snapshot?.lastAssistantText ?? null),
        source: 'rollout',
        topic: cleanPreview(header.firstPrompt, 120),
        path: file.path,
        sizeBytes: st.size,
      },
      createdAtMs,
      lastSeenAtMs: st.mtimeMs,
    })
  }
  return out
}

function knownCwdsFromRows(rows: readonly RowWithSort[], repoFilter: string | null, repoResolved: string | null): readonly string[] {
  const out = new Set<string>()
  for (const { row } of rows) {
    const materialized = withResumeCommand(row)
    if (!repoMatches(materialized, repoFilter, repoResolved)) continue
    if (materialized.cwd !== null) out.add(materialized.cwd)
    else if (materialized.repo !== null) out.add(materialized.repo)
  }
  if (repoResolved !== null) out.add(repoResolved)
  return [...out]
}

function filterRows(rows: readonly RowWithSort[], query: HistoryQuery, repoResolved: string | null): readonly RowWithSort[] {
  return rows.filter(({ row, createdAtMs }) => {
    const materialized = withResumeCommand(row)
    if (query.engine !== null && materialized.engine !== query.engine) return false
    if (!repoMatches(materialized, query.repo, repoResolved)) return false
    if (!globMatches(materialized.name, query.name)) return false
    if (!idMatches(materialized.id, query.id)) return false
    if (query.state !== null && materialized.state !== query.state) return false
    if (query.closeStatus !== null && materialized.closeStatus !== query.closeStatus) return false
    if (query.sinceMs !== null && (createdAtMs === null || createdAtMs < query.sinceMs)) return false
    if (query.untilMs !== null && (createdAtMs === null || createdAtMs > query.untilMs)) return false
    if (!grepMatches(materialized, query.grep)) return false
    return true
  })
}

function selectFields(row: HistoryQueryRow, fields: readonly string[] | null): Record<string, unknown> {
  const selected = fields ?? HISTORY_JSON_FIELDS
  const out: Record<string, unknown> = {}
  for (const field of selected) {
    out[field] = row[field as keyof HistoryQueryRow]
  }
  return out
}

function renderJson(rows: readonly HistoryQueryRow[], query: HistoryQuery, total: number): TmResult {
  const next = query.cursor + rows.length < total ? String(query.cursor + rows.length) : null
  return {
    code: 0,
    stdout: `${JSON.stringify({
      items: rows.map((row) => selectFields(row, query.fields)),
      nextCursor: next,
    }, null, 2)}\n`,
    stderr: '',
  }
}

function renderOneline(rows: readonly HistoryQueryRow[]): TmResult {
  const lines = rows.map((row) =>
    [
      row.id ?? '-',
      row.engine,
      row.state,
      repoLeaf(row.repo ?? row.cwd) ?? '-',
      row.name ?? '-',
      row.intent ?? row.topic ?? '-',
    ].join(' '),
  )
  return { code: 0, stdout: `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, stderr: '' }
}

function renderTable(rows: readonly HistoryQueryRow[]): TmResult {
  const all = [
    ['STATE', 'ENGINE', 'NAME', 'REPO', 'ID', 'CREATED', 'INTENT'],
    ...rows.map((row) => [
      row.state,
      row.engine,
      row.name ?? '-',
      repoLeaf(row.repo ?? row.cwd) ?? '-',
      row.id ?? '-',
      row.createdAt ?? '-',
      row.intent ?? row.topic ?? '-',
    ]),
  ]
  const widths = all[0]!.map((_cell, i) => Math.max(...all.map((row) => row[i]?.length ?? 0)))
  const text = all.map((row) => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()).join('\n')
  return { code: 0, stdout: `${text}\n`, stderr: '' }
}

export function validateHistoryFields(fields: readonly string[]): TmResult | null {
  if (fields.length === 0) {
    return { code: 1, stdout: '', stderr: `tm: history: --fields must name at least one field. Valid fields: ${HISTORY_JSON_FIELDS.join(',')}\n` }
  }
  const bad = fields.filter((field) => !FIELD_SET.has(field))
  if (bad.length > 0) {
    return { code: 1, stdout: '', stderr: `tm: history: unknown field(s): ${bad.join(',')}. Valid fields: ${HISTORY_JSON_FIELDS.join(',')}\n` }
  }
  return null
}

export async function queryHistory(
  query: HistoryQuery,
  listings: readonly TeammateListing[],
  env: NativeEnv,
): Promise<TmResult> {
  const repoResolved = query.repo === null
    ? null
    : comparablePath(isAbsolute(query.repo) ? query.repo : join(env.dispatcherDir, query.repo))
  const baseRows = [
    ...rowsFromIndex(),
    ...rowsFromListings(listings),
    ...rowsFromArchived(),
  ]
  const knownCwds = knownCwdsFromRows(baseRows, query.repo, repoResolved)
  const shouldScanGlobalLogs = query.id !== null
  const shouldScanKnownLogs = knownCwds.length > 0
  const allRows = normalizeRows([
    ...baseRows,
    ...(shouldScanKnownLogs || shouldScanGlobalLogs ? rowsFromClaude(env, knownCwds, query.id) : []),
    ...(shouldScanKnownLogs || shouldScanGlobalLogs ? rowsFromCodex(query.id, knownCwds, shouldScanGlobalLogs) : []),
  ])
  const filtered = filterRows(allRows, query, repoResolved)
  const page = filtered.slice(query.cursor, query.cursor + query.limit)
    .map(({ row }) => withResumeCommand(row))
  switch (query.format) {
    case 'json':
      return renderJson(page, query, filtered.length)
    case 'oneline':
      return renderOneline(page)
    case 'table':
      return renderTable(page)
  }
}

export function resolveHistoryId(
  idPrefix: string,
  listings: readonly TeammateListing[],
  env: NativeEnv,
): { kind: 'found'; row: HistoryQueryRow } | { kind: 'not-found' } | { kind: 'ambiguous'; ids: readonly string[] } {
  const baseRows = [...rowsFromIndex(), ...rowsFromListings(listings), ...rowsFromArchived()]
  const allRows = normalizeRows([
    ...baseRows,
    ...rowsFromClaude(env, knownCwdsFromRows(baseRows, null, null), idPrefix),
    ...rowsFromCodex(idPrefix, [], true),
  ])
    .filter(({ row }) => idMatches(row.id, idPrefix))
    .map(({ row }) => withResumeCommand(row))
  const unique = new Map<string, HistoryQueryRow>()
  for (const row of allRows) {
    if (row.id !== null) unique.set(row.id, row)
  }
  const rows = [...unique.values()]
  if (rows.length === 0) return { kind: 'not-found' }
  if (rows.length > 1) return { kind: 'ambiguous', ids: rows.map((row) => row.id!).sort() }
  return { kind: 'found', row: rows[0]! }
}
