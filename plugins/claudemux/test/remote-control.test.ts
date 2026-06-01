/**
 * Per-teammate Remote Control (issue #28).
 *
 * `tm spawn` can enable Claude's `--remote-control` for a single teammate
 * without flipping the user-global `remoteControlAtStartup` (which would
 * leak RC onto the dispatcher and every unrelated `claude` session). Two
 * enablement paths, with a fixed precedence:
 *
 *   explicit `--remote-control` / `--no-remote-control`
 *     > global config (`CLAUDEMUX_REMOTE_CONTROL`)
 *     > off
 *
 * These tests pin the four moving parts:
 *   - the CLI flag parses into a tri-state (`true` / `false` / `null`);
 *   - `resolveRemoteControl` applies the precedence and rejects an
 *     explicit `--remote-control` on a codex teammate (RC is a Claude
 *     session flag);
 *   - the global config reads from `CLAUDEMUX_REMOTE_CONTROL`;
 *   - the Claude launch actually injects `claude … --remote-control`.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { parseSpawnArgs } from '../src/shared/verb-args'
import { resolveRemoteControl } from '../src/cli/parse'
import { remoteControlTeammatesFromEnv } from '../src/cli/context'
import { claudeSpawn } from '../src/engines/claude/spawn'
import { ClaudeEngine } from '../src/engines/claude/claude-engine'
import {
  cwdFile,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from '../src/persistence/paths'
import { remove as removeIdentity } from '../src/persistence/identity-store'
import type { ClaudeVerbEnv } from '../src/engines/claude/env'
import type { NativeEnv } from '../src/env'
import type { TmuxRunner } from '../src/tmux'

// ─── parseSpawnArgs: the CLI flag is a tri-state ──────────────────────────

describe('parseSpawnArgs — --remote-control / --no-remote-control', () => {
  test('--remote-control sets remoteControl true', () => {
    const result = parseSpawnArgs(['--remote-control'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.remoteControl).toBe(true)
  })

  test('--no-remote-control sets remoteControl false', () => {
    const result = parseSpawnArgs(['--no-remote-control'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.remoteControl).toBe(false)
  })

  test('absent leaves remoteControl null (defer to config / off)', () => {
    const result = parseSpawnArgs(['--name', 'alpha'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.remoteControl).toBeNull()
  })

  test('coexists with other spawn flags', () => {
    const result = parseSpawnArgs(['--name', 'alpha', '--remote-control', '--no-worktree'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.remoteControl).toBe(true)
    expect(result.name).toBe('alpha')
    expect(result.noWorktree).toBe(true)
  })
})

// ─── resolveRemoteControl: precedence + codex semantics ───────────────────

describe('resolveRemoteControl — explicit > config > off', () => {
  test('claude + explicit --remote-control → on (beats a config-off default)', () => {
    const r = resolveRemoteControl(true, 'claude', false)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(true)
  })

  test('claude + explicit --no-remote-control → off (beats a config-on default)', () => {
    const r = resolveRemoteControl(false, 'claude', true)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(false)
  })

  test('claude + no flag + config on → on', () => {
    const r = resolveRemoteControl(null, 'claude', true)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(true)
  })

  test('claude + no flag + config off → off', () => {
    const r = resolveRemoteControl(null, 'claude', false)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(false)
  })

  test('codex + explicit --remote-control → error naming claude', () => {
    const r = resolveRemoteControl(true, 'codex', false)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.code).toBe(1)
    expect(r.error.stderr).toContain('--remote-control')
    expect(r.error.stderr.toLowerCase()).toContain('claude')
  })

  test('codex + explicit --no-remote-control → off, no error', () => {
    const r = resolveRemoteControl(false, 'codex', true)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(false)
  })

  test('codex + config on (no explicit flag) → off, no error (config never breaks a codex spawn)', () => {
    const r = resolveRemoteControl(null, 'codex', true)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.remoteControl).toBe(false)
  })
})

// ─── global config: CLAUDEMUX_REMOTE_CONTROL ──────────────────────────────

describe('remoteControlTeammatesFromEnv — CLAUDEMUX_REMOTE_CONTROL', () => {
  test('"1" enables', () => {
    expect(remoteControlTeammatesFromEnv({ CLAUDEMUX_REMOTE_CONTROL: '1' })).toBe(true)
  })

  test('"true" enables (case-insensitive)', () => {
    expect(remoteControlTeammatesFromEnv({ CLAUDEMUX_REMOTE_CONTROL: 'TRUE' })).toBe(true)
  })

  test('"0" does not enable', () => {
    expect(remoteControlTeammatesFromEnv({ CLAUDEMUX_REMOTE_CONTROL: '0' })).toBe(false)
  })

  test('unset does not enable', () => {
    expect(remoteControlTeammatesFromEnv({})).toBe(false)
  })

  test('empty string does not enable', () => {
    expect(remoteControlTeammatesFromEnv({ CLAUDEMUX_REMOTE_CONTROL: '' })).toBe(false)
  })
})

// ─── launch-command injection ─────────────────────────────────────────────

/** Names whose /tmp markers + identity record we scrub after each test. */
const createdNames: string[] = []

function trackName(label: string): string {
  const name = `cmxrc-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  createdNames.push(name)
  return name
}

beforeEach(() => {
  createdNames.length = 0
})

afterEach(() => {
  for (const name of createdNames) {
    // The fresh spawn writes a `.last` / idle marker keyed by the generated
    // sid; recover the sid from the marker before scrubbing the name files.
    try {
      const sid = readFileSync(sidFile(name), 'utf8').trim()
      if (sid.length > 0) {
        rmSync(idleMarkerFor(sid), { force: true })
        rmSync(lastFileFor(sid), { force: true })
      }
    } catch {
      // no sid marker — nothing keyed by sid to scrub
    }
    for (const file of [sidFile(name), cwdFile(name), readyFile(name), sendAtFile(name)]) {
      rmSync(file, { force: true })
    }
    removeIdentity(name)
  }
})

/**
 * A tmux runner that lets a fresh spawn complete fast: the session does not
 * pre-exist, `new-session` yields a pane id, and the `send-keys` that carries
 * the `claude …` launch line is captured AND mimics the SessionStart hook by
 * touching the `.ready` marker so `pollReady` returns on its first check.
 */
function captureLaunchTmux(name: string, captured: { cmd: string }): TmuxRunner {
  return async (args) => {
    const verb = args[0]
    if (verb === 'has-session') return { code: 1, stdout: '', stderr: '' }
    if (verb === 'new-session') return { code: 0, stdout: '$0\n', stderr: '' }
    if (verb === 'send-keys') {
      const line = args[3]
      if (typeof line === 'string' && line.startsWith('claude')) {
        captured.cmd = line
        writeFileSync(readyFile(name), '')
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function claudeVerbEnv(runTmux: TmuxRunner): ClaudeVerbEnv {
  return {
    runTmux,
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    dispatcherDir: tmpdir(),
    projectsDir: tmpdir(),
  }
}

function nativeEnv(runTmux: TmuxRunner): NativeEnv {
  return {
    runTmux,
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    runGrep: async () => 1,
    dispatcherDir: tmpdir(),
    projectsDir: tmpdir(),
  }
}

describe('claudeSpawn — injects claude --remote-control into the launch command', () => {
  test('--remote-control in argv puts --remote-control on the claude launch line', async () => {
    const name = trackName('on')
    const captured = { cmd: '' }
    const result = await claudeSpawn(
      [name, '--repo', tmpdir(), '--cwd', tmpdir(), '--remote-control'],
      claudeVerbEnv(captureLaunchTmux(name, captured)),
    )
    expect(result.code).toBe(0)
    expect(captured.cmd).toContain('claude --session-id')
    expect(captured.cmd).toContain('--remote-control')
  })

  test('no --remote-control in argv leaves it off the launch line', async () => {
    const name = trackName('off')
    const captured = { cmd: '' }
    const result = await claudeSpawn(
      [name, '--repo', tmpdir(), '--cwd', tmpdir()],
      claudeVerbEnv(captureLaunchTmux(name, captured)),
    )
    expect(result.code).toBe(0)
    expect(captured.cmd).toContain('claude --session-id')
    expect(captured.cmd).not.toContain('--remote-control')
  })
})

describe('ClaudeEngine.spawn — threads SpawnRequest.remoteControl through to claude', () => {
  test('remoteControl:true reaches the claude launch line', async () => {
    const name = trackName('engine')
    const captured = { cmd: '' }
    const engine = new ClaudeEngine(nativeEnv(captureLaunchTmux(name, captured)))
    const result = await engine.spawn(
      {
        name,
        repo: tmpdir(),
        cwd: tmpdir(),
        worktreeSlug: null,
        resumeCheckpoint: null,
        prompt: null,
        timeoutMs: null,
        displayName: null,
        remoteControl: true,
      },
      { now: () => 0, env: {} },
    )
    expect(result.kind).toBe('spawned')
    expect(captured.cmd).toContain('--remote-control')
  })
})
