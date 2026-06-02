/**
 * Claude history source helpers.
 *
 * `tm history` keeps merge/filter/rendering policy in the verb query layer,
 * while this module owns Claude Code transcript discovery and JSONL parsing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  cleanHistoryPreview,
  comparableHistoryPath,
  historyIdMatches,
  isoHistoryTime,
  parseHistoryTimeMs,
  type HistoryRowWithSort,
} from '../../history/source'
import { encodeProjectDir } from '../../persistence/paths'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProp(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function projectDirForCwd(projectsDir: string, cwd: string): string {
  return join(projectsDir, encodeProjectDir(comparableHistoryPath(cwd)))
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
  const createdAtMs = parseHistoryTimeMs(firstTs)
  return { firstPrompt, lastAssistant, createdAt: firstTs, createdAtMs }
}

function scanClaudeProject(cwd: string | null, projectDir: string, idPrefix: string | null): HistoryRowWithSort[] {
  let files: string[]
  try {
    files = readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'))
  } catch {
    return []
  }
  const out: HistoryRowWithSort[] = []
  for (const fileName of files) {
    const id = fileName.replace(/\.jsonl$/, '')
    if (!historyIdMatches(id, idPrefix)) continue
    const path = join(projectDir, fileName)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    const data = readClaudeTranscript(path)
    const createdAtMs = data.createdAtMs ?? st.mtimeMs
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
        createdAt: isoHistoryTime(createdAtMs),
        createdAtSource: data.createdAtMs === null ? 'mtime' : 'jsonl',
        lastSeenAt: isoHistoryTime(st.mtimeMs),
        state: 'orphaned',
        intent: null,
        closeStatus: null,
        closeNotePreview: null,
        lastAssistantPreview: cleanHistoryPreview(data.lastAssistant),
        source: 'transcript',
        topic: cleanHistoryPreview(data.firstPrompt, 120),
        path,
        sizeBytes: st.size,
      },
      createdAtMs,
      lastSeenAtMs: st.mtimeMs,
    })
  }
  return out
}

export function rowsFromClaudeHistorySource(args: {
  readonly projectsDir: string
  readonly knownCwds: readonly string[]
  readonly idPrefix: string | null
}): HistoryRowWithSort[] {
  const out: HistoryRowWithSort[] = []
  const seenProjectDirs = new Set<string>()
  for (const cwd of args.knownCwds) {
    const projectDir = projectDirForCwd(args.projectsDir, cwd)
    seenProjectDirs.add(projectDir)
    out.push(...scanClaudeProject(cwd, projectDir, args.idPrefix))
  }
  if (args.idPrefix !== null) {
    let dirs: string[]
    try {
      dirs = readdirSync(args.projectsDir)
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      const projectDir = join(args.projectsDir, dir)
      if (seenProjectDirs.has(projectDir)) continue
      out.push(...scanClaudeProject(null, projectDir, args.idPrefix))
    }
  }
  return out
}

/**
 * Existence-only check: does the Claude Code project dir for `cwd`
 * hold any transcript jsonl? Mirrors `hasCodexHistoryForCwd` — both
 * resume-probing callers ask the same question of each engine and
 * branch on the answer.
 */
export function hasClaudeHistoryForCwd(cwd: string, projectsDir: string): boolean {
  const projectDir = join(projectsDir, encodeProjectDir(cwd))
  try {
    for (const name of readdirSync(projectDir)) {
      if (name.endsWith('.jsonl')) return true
    }
  } catch {
    return false
  }
  return false
}
