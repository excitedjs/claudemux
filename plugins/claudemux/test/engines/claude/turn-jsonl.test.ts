/**
 * Coverage for the offset-anchored JSONL turn signals behind `tm send`'s
 * submit confirmation and the no-hook wait fallback. The load-bearing
 * property: a settled assistant entry from a PRIOR turn (before the send
 * offset) must never be read as this turn's completion.
 */

import { mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  lastAssistantTextAfter,
  terminalAssistantAfter,
  transcriptSizeBytes,
  userEntryAppearedAfter,
} from '../../../src/engines/claude/turn-jsonl'

const SCRATCH = '/tmp/claudemux-turn-jsonl-test'

function assistant(stopReason: string | null, types: readonly string[]): string {
  const content = types.map((t) =>
    t === 'text'
      ? { type: 'text', text: 'hi' }
      : t === 'tool_use'
        ? { type: 'tool_use', id: 't1', name: 'Read', input: {} }
        : { type: t },
  )
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: stopReason, content },
  })
}

function userPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
}

function toolResult(): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  })
}

function write(path: string, lines: readonly string[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '')
}

let jsonl: string

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  jsonl = join(SCRATCH, 'transcript.jsonl')
})

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('transcriptSizeBytes', () => {
  test('returns the byte size of an existing file', () => {
    write(jsonl, [userPrompt('hello')])
    expect(transcriptSizeBytes(jsonl)).toBe(statSync(jsonl).size)
  })
  test('returns 0 for a missing file', () => {
    expect(transcriptSizeBytes(join(SCRATCH, 'nope.jsonl'))).toBe(0)
  })
})

describe('userEntryAppearedAfter — submit confirmation signal', () => {
  test('false when nothing was appended after the offset', () => {
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text'])])
    const offset = transcriptSizeBytes(jsonl)
    expect(userEntryAppearedAfter(jsonl, offset)).toBe(false)
  })

  test('true once a new user entry is appended past the offset', () => {
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text'])])
    const offset = transcriptSizeBytes(jsonl)
    // Simulate the submitted prompt landing in the transcript.
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text']), userPrompt('my new prompt')])
    expect(userEntryAppearedAfter(jsonl, offset)).toBe(true)
  })

  test('a tool_result (also type=user) past the offset counts as input accepted', () => {
    write(jsonl, [userPrompt('prior')])
    const offset = transcriptSizeBytes(jsonl)
    write(jsonl, [userPrompt('prior'), toolResult()])
    expect(userEntryAppearedAfter(jsonl, offset)).toBe(true)
  })

  test('false for a missing transcript', () => {
    expect(userEntryAppearedAfter(join(SCRATCH, 'nope.jsonl'), 0)).toBe(false)
  })
})

describe('terminalAssistantAfter — turn-end signal, offset-anchored', () => {
  test('a prior-turn settled entry BEFORE the offset is NOT read as this turn ending', () => {
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text'])])
    const offset = transcriptSizeBytes(jsonl)
    // After the offset only the new prompt has landed; the turn has not run yet.
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text']), userPrompt('new')])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(false)
  })

  test('true when this turn ends with a terminal+text assistant entry past the offset', () => {
    write(jsonl, [userPrompt('prior'), assistant('end_turn', ['text'])])
    const offset = transcriptSizeBytes(jsonl)
    write(jsonl, [
      userPrompt('prior'),
      assistant('end_turn', ['text']),
      userPrompt('new'),
      assistant('end_turn', ['text']),
    ])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(true)
  })

  test('mid tool-loop (last assistant stop_reason=tool_use) is not settled', () => {
    const offset = 0
    write(jsonl, [
      userPrompt('new'),
      assistant('tool_use', ['tool_use']),
      toolResult(),
      assistant('tool_use', ['tool_use']),
    ])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(false)
  })

  test('split turn: a thinking-only end_turn is not settled until the text response lands', () => {
    const offset = 0
    write(jsonl, [userPrompt('new'), assistant('end_turn', ['thinking'])])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(false)
    write(jsonl, [
      userPrompt('new'),
      assistant('end_turn', ['thinking']),
      assistant('end_turn', ['text']),
    ])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(true)
  })

  test('a tool_use block with a terminal stop_reason counts as settled', () => {
    const offset = 0
    write(jsonl, [userPrompt('new'), assistant('end_turn', ['tool_use'])])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(true)
  })

  test('no assistant entry yet → not settled', () => {
    const offset = 0
    write(jsonl, [userPrompt('new')])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(false)
  })

  test('a shrunk file (compaction rewrote it) reads as nothing-new, never a false positive', () => {
    write(jsonl, [userPrompt('a'), assistant('end_turn', ['text']), userPrompt('b'), assistant('end_turn', ['text'])])
    const offset = transcriptSizeBytes(jsonl)
    // Compaction rewrites the transcript much smaller.
    write(jsonl, [userPrompt('compact summary')])
    expect(terminalAssistantAfter(jsonl, offset)).toBe(false)
  })

  test('a trailing half-written line is skipped without throwing', () => {
    mkdirSync(join(jsonl, '..'), { recursive: true })
    writeFileSync(jsonl, `${userPrompt('new')}\n${assistant('end_turn', ['text'])}\n{"type":"assist`)
    expect(terminalAssistantAfter(jsonl, 0)).toBe(true)
  })
})

describe('lastAssistantTextAfter — reply recovery for the no-hook fallback', () => {
  /** An assistant entry carrying a specific text deliverable. */
  function reply(text: string): string {
    return JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
    })
  }

  test('returns the joined text of this turn, never a prior turn before the offset', () => {
    write(jsonl, [userPrompt('prior'), reply('OLD REPLY')])
    const offset = transcriptSizeBytes(jsonl)
    write(jsonl, [userPrompt('prior'), reply('OLD REPLY'), userPrompt('new'), reply('NEW REPLY')])
    expect(lastAssistantTextAfter(jsonl, offset)).toBe('NEW REPLY')
  })

  test('joins multiple text blocks in the last assistant entry', () => {
    const multi = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }],
      },
    })
    write(jsonl, [userPrompt('new'), multi])
    expect(lastAssistantTextAfter(jsonl, 0)).toBe('foobar')
  })

  test('returns null for a tool-only turn (no text block to recover)', () => {
    write(jsonl, [userPrompt('new'), assistant('end_turn', ['tool_use'])])
    expect(lastAssistantTextAfter(jsonl, 0)).toBeNull()
  })

  test('returns null when no assistant entry is appended past the offset', () => {
    write(jsonl, [userPrompt('prior'), reply('OLD REPLY')])
    const offset = transcriptSizeBytes(jsonl)
    write(jsonl, [userPrompt('prior'), reply('OLD REPLY'), userPrompt('new')])
    expect(lastAssistantTextAfter(jsonl, offset)).toBeNull()
  })

  test('returns null for a missing transcript', () => {
    expect(lastAssistantTextAfter(join(SCRATCH, 'nope.jsonl'), 0)).toBeNull()
  })
})
