/**
 * Coverage for `confirmSubmit` — `tm send`'s post-Enter check that the
 * REPL accepted the prompt as a turn (rather than the Enter being
 * swallowed by a modal). Verifies the three "accepted" signals, the
 * retry-Enter-then-warn path, and the env disable switch.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { confirmSubmit } from '../../../src/engines/claude/wait-signals'
import { busyMarkerFor, idleDir, idleMarkerFor, sidFile } from '../../../src/persistence/paths'
import type { TmuxRunner } from '../../../src/tmux'

const SCRATCH = '/tmp/claudemux-submit-confirm-test'

let names: string[]
let sids: string[]
let savedConfirmMs: string | undefined

function uniqueName(label: string): string {
  const name = `cmxsc-${label}-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  names.push(name)
  return name
}

function seedSid(name: string): string {
  const sid = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12).toString(16).padStart(12, '0').slice(-12)}`
  mkdirSync(idleDir(), { recursive: true })
  writeFileSync(sidFile(name), `${sid}\n`)
  sids.push(sid)
  return sid
}

/** Fake tmux: session alive, pane resolves, send-keys recorded. */
function recordingTmux(name: string): { runTmux: TmuxRunner; enters: () => number } {
  const sessionName = `teammate-${name}`
  let enterCount = 0
  const runTmux: TmuxRunner = async (args) => {
    if (args[0] === 'has-session') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'list-sessions') return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    if (args[0] === 'send-keys' && args.includes('Enter')) enterCount += 1
    return { code: 0, stdout: '', stderr: '' }
  }
  return { runTmux, enters: () => enterCount }
}

beforeEach(() => {
  names = []
  sids = []
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  savedConfirmMs = process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  // Small budget so the not-submitted path resolves fast.
  process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = '600'
})

afterEach(() => {
  if (savedConfirmMs === undefined) delete process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  else process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = savedConfirmMs
  for (const name of names) rmSync(sidFile(name), { force: true })
  for (const sid of sids) {
    rmSync(busyMarkerFor(sid), { force: true })
    rmSync(idleMarkerFor(sid), { force: true })
  }
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('confirmSubmit', () => {
  test('confirms immediately when the on-busy marker is present (no Enter re-send)', async () => {
    const name = uniqueName('busy')
    const sid = seedSid(name)
    writeFileSync(busyMarkerFor(sid), '')
    const { runTmux, enters } = recordingTmux(name)

    const r = await confirmSubmit(name, { jsonl: null, sinceBytes: 0 }, runTmux)

    expect(r.ok).toBe(true)
    expect(enters()).toBe(0)
  })

  test('confirms when the idle marker is present (a fast turn already ended)', async () => {
    const name = uniqueName('idle')
    const sid = seedSid(name)
    writeFileSync(idleMarkerFor(sid), '')
    const { runTmux } = recordingTmux(name)

    const r = await confirmSubmit(name, { jsonl: null, sinceBytes: 0 }, runTmux)
    expect(r.ok).toBe(true)
  })

  test('confirms when a new user entry landed in the transcript past the offset (hook-independent)', async () => {
    const name = uniqueName('jsonl')
    seedSid(name)
    const jsonl = join(SCRATCH, 'transcript.jsonl')
    writeFileSync(jsonl, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'my prompt' } })}\n`)
    const { runTmux, enters } = recordingTmux(name)

    const r = await confirmSubmit(name, { jsonl, sinceBytes: 0 }, runTmux)

    expect(r.ok).toBe(true)
    expect(enters()).toBe(0)
  })

  test('no evidence → re-sends Enter (attempts-1 = 2x) then warns, never hard-fails', async () => {
    const name = uniqueName('none')
    seedSid(name) // sid exists but no busy/idle marker, and jsonl is null
    const { runTmux, enters } = recordingTmux(name)

    const r = await confirmSubmit(name, { jsonl: null, sinceBytes: 0 }, runTmux)

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.warn).toContain('no turn-start signal')
      expect(r.warn).toContain(`tm status ${name}`)
      // Must NOT advise re-running tm send (would double-drive the teammate).
      expect(r.warn).not.toMatch(/Re-run\s+'tm send/)
    }
    // Re-sent Enter between the 3 attempts → 2 retries.
    expect(enters()).toBe(2)
  })

  test('CLAUDEMUX_CONFIRM_SUBMIT_MS=0 disables confirmation (returns ok, no work)', async () => {
    const name = uniqueName('disabled')
    seedSid(name)
    process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS'] = '0'
    const { runTmux, enters } = recordingTmux(name)

    const r = await confirmSubmit(name, { jsonl: null, sinceBytes: 0 }, runTmux)

    expect(r.ok).toBe(true)
    expect(enters()).toBe(0)
  })
})
