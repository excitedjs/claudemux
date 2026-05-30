/**
 * Production-path coverage for `tm send`'s no-hook JSONL wait fallback.
 *
 * When the Stop hook never fires, the turn settles in the transcript
 * (`terminalAssistantAfter`) and `tm send` must STILL honour its atomic
 * round-trip contract: exit 0 with the reply on stdout AND repopulate
 * `<sid>.last` — not the "(no text reply…)" sentinel, and not a prior
 * turn's stale text. Recovery is scoped to the send-time byte offset, so
 * an earlier assistant entry is never surfaced as this turn's reply.
 *
 * The transcript only grows AFTER the prompt's Enter is delivered, which
 * is the realistic ordering: `claudeSend` snapshots the byte offset
 * before `sendKeys`, so the fake tmux appends this turn's entries on the
 * Enter send-keys to land them past the offset.
 */

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claudeSend } from '../../../src/engines/claude/send'
import { transcriptFile } from '../../../src/engines/claude/ctx'
import { cwdFile, idleDir, lastFileFor, sidFile } from '../../../src/persistence/paths'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { TmuxRunner } from '../../../src/tmux'

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
}
function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] },
  })
}
function assistantToolOnlyLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    },
  })
}

const createdNames: string[] = []
const createdSids: string[] = []
let projectsDir: string
let savedConfirmMs: string | undefined

function uniqueName(label: string): string {
  const name = `cmxjr-${label}-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  createdNames.push(name)
  return name
}

function seedSid(name: string): string {
  const sid = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
    .toString(16)
    .padStart(12, '0')
    .slice(-12)}`
  mkdirSync(idleDir(), { recursive: true })
  writeFileSync(sidFile(name), `${sid}\n`)
  createdSids.push(sid)
  return sid
}

/**
 * Fake tmux: session alive, pane resolves, and on the prompt's Enter
 * send-keys it appends `turnLines` to the transcript — simulating the
 * REPL accepting the prompt and finishing a turn whose Stop hook never
 * fired. No idle marker is ever created, so `waitForTurnEnd` can only end
 * via the JSONL signal.
 */
function fakeTmuxAppending(name: string, jsonlPath: string, turnLines: string): TmuxRunner {
  const sessionName = `teammate-${name}`
  let appended = false
  return async (args) => {
    const verb = args[0]
    if (verb === 'has-session') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'list-sessions') return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    if (verb === 'send-keys' && args.includes('Enter') && !appended) {
      appended = true
      appendFileSync(jsonlPath, turnLines)
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function envFor(name: string, jsonlPath: string, turnLines: string): ClaudeVerbEnv {
  return {
    runTmux: fakeTmuxAppending(name, jsonlPath, turnLines),
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    dispatcherDir: tmpdir(),
    projectsDir,
  }
}

beforeEach(() => {
  createdNames.length = 0
  createdSids.length = 0
  projectsDir = mkdtempSync(`${tmpdir()}/cmxjr-proj-`)
  savedConfirmMs = process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  // Isolate the recovery behaviour from submit-confirmation timing.
  process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = '0'
})

afterEach(() => {
  if (savedConfirmMs === undefined) delete process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  else process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = savedConfirmMs
  for (const name of createdNames) {
    rmSync(sidFile(name), { force: true })
    rmSync(cwdFile(name), { force: true })
  }
  for (const sid of createdSids) rmSync(lastFileFor(sid), { force: true })
  rmSync(projectsDir, { recursive: true, force: true })
})

/** Lay down the sid, recorded cwd, and a prior-turn transcript; return its jsonl path + sid. */
function seedSession(name: string): { sid: string; jsonl: string } {
  const sid = seedSid(name)
  const cwd = '/home/u/repo'
  writeFileSync(cwdFile(name), `${cwd}\n`)
  const jsonl = transcriptFile(projectsDir, cwd, sid)
  mkdirSync(dirname(jsonl), { recursive: true })
  // A PRIOR settled turn lives before the send offset — recovery must skip it.
  writeFileSync(jsonl, `${userLine('prior prompt')}\n${assistantTextLine('OLD REPLY')}\n`)
  return { sid, jsonl }
}

describe('tm send — no-hook JSONL wait fallback recovers the reply', () => {
  test('exits 0 with the settled reply on stdout AND in <sid>.last (not sentinel, not stale)', async () => {
    const name = uniqueName('recover')
    const { sid, jsonl } = seedSession(name)
    // A stale .last from a prior turn — must be overwritten, never returned.
    writeFileSync(lastFileFor(sid), 'OLD REPLY\n')
    const turn = `${userLine('new prompt')}\n${assistantTextLine('NEW REPLY')}\n`

    const result = await claudeSend([name, '--prompt', 'hi'], envFor(name, jsonl, turn))

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('NEW REPLY\n')
    expect(result.stdout).not.toContain('no text reply')
    expect(readFileSync(lastFileFor(sid), 'utf8')).toBe('NEW REPLY\n')
  })

  test('a tool-only fallback turn clears stale .last and prints the sentinel', async () => {
    const name = uniqueName('toolonly')
    const { sid, jsonl } = seedSession(name)
    writeFileSync(lastFileFor(sid), 'OLD REPLY\n')
    const turn = `${userLine('new prompt')}\n${assistantToolOnlyLine()}\n`

    const result = await claudeSend([name, '--prompt', 'hi'], envFor(name, jsonl, turn))

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no text reply')
    // Stale .last cleared to empty (→ sentinel), not left as the prior reply.
    expect(readFileSync(lastFileFor(sid), 'utf8')).toBe('')
  })
})
