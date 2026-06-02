import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { rowsFromCodexHistorySource } from '../../../src/engines/codex/history'
import type { TeammateListing } from '../../../src/engines/types'
import type { NativeEnv } from '../../../src/env'
import { queryHistory, type HistoryQuery } from '../../../src/verbs/history-query'

const THREAD_ID = '019e5f5f-2e57-7abc-8def-123456789ac5'
const AGENTS_PROMPT =
  '# AGENTS.md instructions for /workspace/example-repo\n\n' +
  '<INSTRUCTIONS>\nUse the repository instructions.\n</INSTRUCTIONS>'

let scratch: string
let repo: string
let sessionsRoot: string
let savedSessionsRoot: string | undefined

beforeEach(() => {
  scratch = mkdtempSync('/tmp/cmx-codex-history-prompt-')
  repo = join(scratch, 'example-repo')
  sessionsRoot = join(scratch, 'sessions')
  mkdirSync(repo, { recursive: true })
  savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
})

afterEach(() => {
  if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
  rmSync(scratch, { recursive: true, force: true })
})

function writeRollout(threadId: string, lines: readonly unknown[]): string {
  const dir = join(sessionsRoot, '2026', '05', '24')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-05-24T00-00-00-${threadId}.jsonl`)
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const mtime = new Date('2026-05-24T00:00:05.000Z')
  utimesSync(path, mtime, mtime)
  return path
}

function rolloutLines(prompt: string): readonly unknown[] {
  return [
    {
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: THREAD_ID, cwd: repo },
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
        message: 'assistant after prompt',
        phase: 'final_answer',
      },
    },
  ]
}

function nativeEnv(): NativeEnv {
  return {
    dispatcherDir: scratch,
    projectsDir: join(scratch, 'claude-projects'),
  } as NativeEnv
}

function historyQuery(format: HistoryQuery['format']): HistoryQuery {
  return {
    repo,
    name: null,
    id: null,
    engine: 'codex',
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
})
