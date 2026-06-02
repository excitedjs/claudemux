import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { rowsFromClaudeHistorySource } from '../../../src/engines/claude/history'
import { rowsFromCodexHistorySource } from '../../../src/engines/codex/history'
import type { TeammateListing } from '../../../src/engines/types'
import type { NativeEnv } from '../../../src/env'
import { encodeProjectDir } from '../../../src/persistence/paths'
import { queryHistory, type HistoryQuery } from '../../../src/verbs/history-query'

const THREAD_ID = '019e5f5f-2e57-7abc-8def-123456789ac5'
const AGENTS_PROMPT =
  '# AGENTS.md instructions for /workspace/example-repo\n\n' +
  '<INSTRUCTIONS>\nUse the repository instructions.\n</INSTRUCTIONS>'

let scratch: string
let repo: string
let sessionsRoot: string
let projectsDir: string
let savedSessionsRoot: string | undefined

beforeEach(() => {
  scratch = realpathSync(mkdtempSync('/tmp/cmx-codex-history-prompt-'))
  repo = join(scratch, 'example-repo')
  sessionsRoot = join(scratch, 'sessions')
  projectsDir = join(scratch, 'claude-projects')
  mkdirSync(repo, { recursive: true })
  savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
})

afterEach(() => {
  if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
  rmSync(scratch, { recursive: true, force: true })
})

function writeRollout(threadId: string, lines: readonly unknown[], mtimeIso = '2026-05-24T00:00:05.000Z'): string {
  const dir = join(sessionsRoot, '2026', '05', '24')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-05-24T00-00-00-${threadId}.jsonl`)
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const mtime = new Date(mtimeIso)
  utimesSync(path, mtime, mtime)
  return path
}

function rolloutLinesForCwd(threadId: string, cwd: string, prompt: string, lastAssistant = 'assistant after prompt'): readonly unknown[] {
  return [
    {
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd },
    },
    {
      timestamp: '2026-05-24T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: AGENTS_PROMPT }],
      },
    },
    {
      timestamp: '2026-05-24T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    },
    {
      timestamp: '2026-05-24T00:00:03.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt },
    },
    {
      timestamp: '2026-05-24T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: lastAssistant,
        phase: 'final_answer',
      },
    },
  ]
}

function rolloutLines(prompt: string): readonly unknown[] {
  return rolloutLinesForCwd(THREAD_ID, repo, prompt)
}

function responseItemRolloutLines(
  threadId: string,
  cwd: string,
  firstPrompt: string,
  lastAssistant: string,
): readonly unknown[] {
  return [
    {
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: threadId, cwd },
    },
    {
      timestamp: '2026-05-24T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: firstPrompt }],
      },
    },
    {
      timestamp: '2026-05-24T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: lastAssistant }],
      },
    },
  ]
}

function writeClaudeTranscript(sid: string, prompt: string, assistant: string, mtimeIso = '2026-05-24T00:00:06.000Z'): string {
  const dir = join(projectsDir, encodeProjectDir(realpathSync(repo)))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sid}.jsonl`)
  writeFileSync(path, [
    JSON.stringify({
      timestamp: '2026-05-24T00:00:01.000Z',
      type: 'user',
      message: { role: 'user', content: prompt },
    }),
    JSON.stringify({
      timestamp: '2026-05-24T00:00:04.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: assistant }] },
    }),
    '',
  ].join('\n'))
  const mtime = new Date(mtimeIso)
  utimesSync(path, mtime, mtime)
  return path
}

function nativeEnv(): NativeEnv {
  return {
    dispatcherDir: scratch,
    projectsDir,
  } as NativeEnv
}

function historyQuery(format: HistoryQuery['format'], engine: HistoryQuery['engine'] = 'codex'): HistoryQuery {
  return {
    repo,
    name: null,
    id: null,
    engine,
    sinceMs: null,
    untilMs: null,
    state: null,
    closeStatus: null,
    grep: null,
    limit: 50,
    cursor: 0,
    fields: null,
    format,
  }
}

describe('Codex history prompt extraction', () => {
  test('Codex history source skips AGENTS instructions and returns the first real user prompt', () => {
    writeRollout(THREAD_ID, rolloutLines('Prompt from tm send'))

    const rows = rowsFromCodexHistorySource({
      idPrefix: null,
      knownCwds: [repo],
      allowGlobal: false,
      env: { CLAUDEMUX_CODEX_SESSIONS_ROOT: sessionsRoot },
    }).map(({ row }) => row)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      topic: 'Prompt from tm send',
      lastAssistantPreview: 'assistant after prompt',
    })
    expect(rows[0]?.topic).not.toContain('# AGENTS.md instructions')
  })

  test('Codex history source reads and filters rollout rows for the teammate cwd', () => {
    const activeThreadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    const oldThreadId = '019e5f5f-2e57-7abc-8def-123456789abd'
    const otherThreadId = '019e5f5f-2e57-7abc-8def-123456789abe'
    const otherCwd = join(scratch, 'other-repo')
    mkdirSync(otherCwd, { recursive: true })
    writeRollout(
      activeThreadId,
      rolloutLinesForCwd(activeThreadId, repo, 'Implement codex history', 'active answer'),
      '2026-05-24T00:00:05.000Z',
    )
    writeRollout(
      oldThreadId,
      rolloutLinesForCwd(oldThreadId, repo, 'Older codex thread', 'old answer'),
      '2026-05-24T00:00:04.000Z',
    )
    writeRollout(
      otherThreadId,
      rolloutLinesForCwd(otherThreadId, otherCwd, 'Other repo thread', 'other answer'),
      '2026-05-24T00:00:06.000Z',
    )

    const rows = rowsFromCodexHistorySource({
      idPrefix: null,
      knownCwds: [repo],
      allowGlobal: false,
      env: { CLAUDEMUX_CODEX_SESSIONS_ROOT: sessionsRoot },
    }).map(({ row }) => row)

    expect(rows.map((row) => row.id)).toEqual([activeThreadId, oldThreadId])
    expect(rows[0]).toMatchObject({
      engine: 'codex',
      source: 'rollout',
      cwd: repo,
      state: 'orphaned',
      topic: 'Implement codex history',
      lastAssistantPreview: 'active answer',
    })
    expect(rows[1]).toMatchObject({
      topic: 'Older codex thread',
      lastAssistantPreview: 'old answer',
    })
    expect(rows).not.toContainEqual(expect.objectContaining({ id: otherThreadId }))
  })

  test('Codex history source filters rollout thread id prefixes', () => {
    const firstThreadId = '019e5f5f-1111-7abc-8def-123456789abc'
    const secondThreadId = '019e5f5f-2222-7abc-8def-123456789abc'
    writeRollout(firstThreadId, rolloutLinesForCwd(firstThreadId, repo, 'First match', 'first answer'))
    writeRollout(secondThreadId, rolloutLinesForCwd(secondThreadId, repo, 'Second match', 'second answer'))

    const rows = rowsFromCodexHistorySource({
      idPrefix: '019e5f5f-1111',
      knownCwds: [repo],
      allowGlobal: false,
      env: { CLAUDEMUX_CODEX_SESSIONS_ROOT: sessionsRoot },
    }).map(({ row }) => row)

    expect(rows.map((row) => row.id)).toEqual([firstThreadId])
  })

  test('Codex history source falls back to response_item user text', () => {
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac2'
    writeRollout(
      threadId,
      responseItemRolloutLines(threadId, repo, 'Prompt from response item', 'assistant response item'),
    )

    const rows = rowsFromCodexHistorySource({
      idPrefix: null,
      knownCwds: [repo],
      allowGlobal: false,
      env: { CLAUDEMUX_CODEX_SESSIONS_ROOT: sessionsRoot },
    }).map(({ row }) => row)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      topic: 'Prompt from response item',
      lastAssistantPreview: 'assistant response item',
    })
  })

  test('Codex history source returns no rows when no rollout matches the cwd', () => {
    expect(rowsFromCodexHistorySource({
      idPrefix: null,
      knownCwds: [repo],
      allowGlobal: false,
      env: { CLAUDEMUX_CODEX_SESSIONS_ROOT: sessionsRoot },
    })).toEqual([])
  })

  test('tm history oneline uses the rollout first real user prompt when intent is implicit', async () => {
    writeRollout(THREAD_ID, rolloutLines('Prompt from tm spawn'))

    const result = await queryHistory(historyQuery('oneline'), [], nativeEnv())
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Prompt from tm spawn')
    expect(result.stdout).not.toContain('# AGENTS.md instructions')
  })

  test('tm history oneline keeps an explicit intent ahead of the rollout-derived topic', async () => {
    writeRollout(THREAD_ID, rolloutLines('Prompt from tm spawn'))
    const listing: TeammateListing = {
      name: 'worker',
      engine: 'codex',
      state: 'idle',
      repo,
      cwd: repo,
      worktreeSlug: null,
      displayName: 'Explicit intent',
      extras: { thread: THREAD_ID },
    }

    const result = await queryHistory(historyQuery('oneline'), [listing], nativeEnv())
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Explicit intent')
    expect(result.stdout).not.toContain('Prompt from tm spawn')
    expect(result.stdout).not.toContain('# AGENTS.md instructions')
  })

  test('tm history merges Claude transcript and Codex rollout rows in one query result', async () => {
    const sid = '52778285-eab4-4fd2-9bbd-000000000010'
    writeClaudeTranscript(sid, 'Claude transcript topic', 'Claude final answer')
    writeRollout(
      THREAD_ID,
      rolloutLinesForCwd(THREAD_ID, repo, 'Codex rollout topic', 'Codex final answer'),
      '2026-05-24T00:00:05.000Z',
    )

    expect(rowsFromClaudeHistorySource({
      projectsDir,
      knownCwds: [repo],
      idPrefix: null,
    })).toHaveLength(1)

    const result = await queryHistory(historyQuery('json', null), [], nativeEnv())
    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout) as { items: Array<{ engine: string; id: string; topic: string }> }

    expect(parsed.items).toEqual([
      expect.objectContaining({
        engine: 'claude',
        id: sid,
        topic: 'Claude transcript topic',
      }),
      expect.objectContaining({
        engine: 'codex',
        id: THREAD_ID,
        topic: 'Codex rollout topic',
      }),
    ])
  })
})
