/**
 * Codex history source helpers.
 *
 * Codex persists durable threads as rollout JSONL files under
 * `~/.codex/sessions/YYYY/MM/DD/`. This module owns rollout discovery and
 * parsing; `verbs/history-query.ts` owns cross-engine merge/filter/rendering.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { Buffer } from 'node:buffer'

import {
  cleanHistoryPreview,
  comparableHistoryPath,
  historyIdMatches,
  isoHistoryTime,
  parseHistoryTimeMs,
  type HistoryRowWithSort,
} from '../../history/source'
import {
  listCodexRolloutFiles,
  readCodexRolloutSnapshot,
  type CodexRolloutFile,
} from './rollout.js'
import { codexHistoryPromptFromEntry } from './history-prompt.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function cwdMatches(recorded: string, target: string): boolean {
  return recorded === target || comparableHistoryPath(recorded) === comparableHistoryPath(target)
}

function cwdFromEntry(entry: unknown): string | null {
  if (!isPlainObject(entry)) return null
  const payload = entry['payload']
  if (!isPlainObject(payload)) return null
  return stringProp(payload, 'cwd')
}

function readFirstLine(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(4096)
    let offset = 0
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n === 0) break
      const chunk = buf.subarray(0, n)
      const newline = chunk.indexOf(10)
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(Buffer.from(chunk))
      offset += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch { /* ignore close failure after a read-only route probe */ }
    }
  }
}

function cwdFromFirstLine(file: CodexRolloutFile): string | null {
  const line = readFirstLine(file.path)
  if (line === null || line.trim() === '') return null
  try {
    return cwdFromEntry(JSON.parse(line))
  } catch {
    return null
  }
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
    cwd = cwd ?? cwdFromEntry(parsed)
    firstPrompt = firstPrompt ?? codexHistoryPromptFromEntry(parsed)
    if (cwd !== null && firstPrompt !== null && createdAt !== null) break
  }
  return { cwd, firstPrompt, createdAt, createdAtMs: parseHistoryTimeMs(createdAt) }
}

function cwdAllowed(cwd: string | null, knownCwds: readonly string[], allowGlobal: boolean): boolean {
  if (allowGlobal) return true
  if (cwd === null) return false
  const comparable = comparableHistoryPath(cwd)
  return knownCwds.some((known) => comparableHistoryPath(known) === comparable)
}

export function rowsFromCodexHistorySource(args: {
  readonly idPrefix: string | null
  readonly knownCwds: readonly string[]
  readonly allowGlobal: boolean
  readonly env: NodeJS.ProcessEnv
}): HistoryRowWithSort[] {
  const out: HistoryRowWithSort[] = []
  for (const file of listCodexRolloutFiles(args.env)) {
    if (!historyIdMatches(file.threadId, args.idPrefix)) continue
    const st = (() => {
      try {
        return statSync(file.path)
      } catch {
        return null
      }
    })()
    if (st === null) continue
    const header = readCodexHeader(file.path)
    if (!cwdAllowed(header.cwd, args.knownCwds, args.allowGlobal)) continue
    const snapshot = readCodexRolloutSnapshot(file.threadId, args.env)
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
        createdAt: isoHistoryTime(createdAtMs),
        createdAtSource: header.createdAtMs === null ? 'mtime' : 'jsonl',
        lastSeenAt: isoHistoryTime(st.mtimeMs),
        state: 'orphaned',
        intent: null,
        closeStatus: null,
        closeNotePreview: null,
        lastAssistantPreview: cleanHistoryPreview(snapshot?.lastAssistantText ?? null),
        source: 'rollout',
        topic: cleanHistoryPreview(header.firstPrompt, 120),
        path: file.path,
        sizeBytes: st.size,
      },
      createdAtMs,
      lastSeenAtMs: st.mtimeMs,
    })
  }
  return out
}

export function hasCodexHistoryForCwd(cwd: string, env: NodeJS.ProcessEnv): boolean {
  for (const file of listCodexRolloutFiles(env)) {
    const recordedCwd = cwdFromFirstLine(file)
    if (recordedCwd !== null && cwdMatches(recordedCwd, cwd)) return true
  }
  return false
}
