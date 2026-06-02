/**
 * Boundary coverage for `hasClaudeHistoryForCwd` — the existence-only
 * candidate check the resume-probing branch in `verbs/resume.ts` calls.
 * The contract is intentionally shallow (any `.jsonl` file under the
 * cwd's encoded project dir counts), to mirror `hasCodexHistoryForCwd`
 * and avoid the two engines disagreeing on what "has candidate" means
 * — that disagreement would silently bias the ambiguity decision.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { hasClaudeHistoryForCwd, rowsFromClaudeHistorySource } from '../../../src/engines/claude/history'
import { encodeProjectDir } from '../../../src/persistence/paths'

let projectsDir: string
let cwd: string
let projectDir: string

beforeEach(() => {
  projectsDir = mkdtempSync('/tmp/cmx-claude-probe-')
  cwd = realpathSync(mkdtempSync('/tmp/cmx-claude-cwd-'))
  projectDir = join(projectsDir, encodeProjectDir(cwd))
})

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('hasClaudeHistoryForCwd', () => {
  test('returns false when the encoded project dir does not exist', () => {
    // Probing must not crash on a fresh cwd; the dir is created lazily
    // by Claude Code on first session, so "missing" is the common case.
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns false when the project dir exists but is empty', () => {
    mkdirSync(projectDir, { recursive: true })
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns true for a zero-byte .jsonl — claude --continue picks it', () => {
    // The existence-only contract: an empty jsonl is still a candidate
    // claude --continue could pick. Anything stricter would diverge from
    // hasCodexHistoryForCwd, which also accepts a present-but-empty
    // rollout (first-line cwd missing is treated the same as no record,
    // but a present file with a matching cwd is true even when the file
    // itself has no useful turns).
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '00000000-0000-0000-0000-000000000000.jsonl'), '')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns true even when every jsonl is malformed', () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'a.jsonl'), 'not-json-at-all\n{"broken":\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns false when only non-jsonl files are present', () => {
    // The marker the SessionStart hook writes (e.g. *.sid) lives elsewhere
    // (/tmp/claude-idle), but a future stray file under projects/ must not
    // false-positive as a transcript.
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), '#\n')
    writeFileSync(join(projectDir, 'notes.txt'), 'x\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns true when any single .jsonl is present alongside other files', () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'unrelated.log'), '\n')
    writeFileSync(join(projectDir, 'session.jsonl'), '\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns false when projectsDir itself is missing on disk', () => {
    rmSync(projectsDir, { recursive: true, force: true })
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('keys lookup by encoded cwd, not raw cwd', () => {
    // Sanity: if encodeProjectDir is bypassed (e.g. a future caller
    // forgets the encoding) the lookup misses. Pinning the encoded path
    // guards the routing through the one canonical encoder.
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'a.jsonl'), '')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
    // A different cwd encodes to a different dir → miss.
    const other = `${cwd}-not-here`
    expect(hasClaudeHistoryForCwd(other, projectsDir)).toBe(false)
  })
})

describe('rowsFromClaudeHistorySource', () => {
  test('parses a real Claude transcript row for a known cwd', () => {
    const sid = '52778285-eab4-4fd2-9bbd-000000000001'
    const transcript = join(projectDir, `${sid}.jsonl`)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(transcript, [
      JSON.stringify({
        timestamp: '2026-05-24T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Implement Claude history\nwith details' },
      }),
      JSON.stringify({
        timestamp: '2026-05-24T00:00:02.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Claude answer\nsecond line' }],
        },
      }),
      '',
    ].join('\n'))
    const mtime = new Date('2026-05-24T00:00:05.000Z')
    utimesSync(transcript, mtime, mtime)

    const rows = rowsFromClaudeHistorySource({
      projectsDir,
      knownCwds: [cwd],
      idPrefix: null,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      createdAtMs: Date.parse('2026-05-24T00:00:00.000Z'),
      lastSeenAtMs: Date.parse('2026-05-24T00:00:05.000Z'),
      row: {
        id: sid,
        engine: 'claude',
        source: 'transcript',
        cwd,
        repo: cwd,
        createdAt: '2026-05-24T00:00:00.000Z',
        createdAtSource: 'jsonl',
        lastSeenAt: '2026-05-24T00:00:05.000Z',
        state: 'orphaned',
        topic: 'Implement Claude history',
        lastAssistantPreview: 'Claude answer',
        path: transcript,
        sizeBytes: expect.any(Number),
      },
    })
  })

  test('can resolve a transcript by id prefix from the global projects dir scan', () => {
    const sid = '52778285-eab4-4fd2-9bbd-000000000002'
    const transcript = join(projectDir, `${sid}.jsonl`)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(transcript, `${JSON.stringify({
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: 'Global lookup prompt' },
    })}\n`)

    const rows = rowsFromClaudeHistorySource({
      projectsDir,
      knownCwds: [],
      idPrefix: sid.slice(0, 8),
    }).map(({ row }) => row)

    expect(rows).toEqual([
      expect.objectContaining({
        id: sid,
        engine: 'claude',
        cwd: null,
        repo: null,
        topic: 'Global lookup prompt',
      }),
    ])
  })
})
