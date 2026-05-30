/**
 * Coverage for the teammate launch hardening flags built in
 * `engines/claude/spawn.ts`:
 *
 *  - the resume-prompt suppressor env `CLAUDE_CODE_RESUME_TOKEN_THRESHOLD`
 *    is injected into the teammate's tmux session (so Claude Code's
 *    "Resume from summary vs full session" startup modal never renders
 *    for a headless teammate — bug #2's real fix);
 *  - the `claude` launch command disables the modal-opening tools
 *    `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` (each would hold
 *    a turn open waiting for a human a teammate does not have).
 *
 * Both are asserted by recording the tmux calls a fresh `claudeSpawn`
 * makes through a fake runner.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claudeSpawn } from '../../../src/engines/claude/spawn'
import { cwdFile, idleDir, readyFile, sidFile, lastFileFor } from '../../../src/persistence/paths'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { TmuxResult } from '../../../src/tmux'

const SCRATCH = '/tmp/claudemux-launch-flags-test'

let calls: string[][]

/**
 * Fake tmux: report the session absent, accept `new-session` with a
 * synthetic pane id, and on `send-keys` touch the ready file so
 * `pollReady` returns on its first tick. Every call is recorded.
 */
function makeRunTmux(name: string): (args: readonly string[]) => Promise<TmuxResult> {
  return async (args) => {
    calls.push([...args])
    if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'new-session') return { code: 0, stdout: '$99\n', stderr: '' }
    if (args[0] === 'send-keys') {
      writeFileSync(readyFile(name), '')
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function buildEnv(name: string): ClaudeVerbEnv {
  return {
    runTmux: makeRunTmux(name),
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    dispatcherDir: SCRATCH,
    projectsDir: join(SCRATCH, 'projects'),
  }
}

beforeEach(() => {
  calls = []
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  mkdirSync(idleDir(), { recursive: true })
})

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/** Run a fresh (no-worktree) spawn and return the recorded tmux calls. */
async function spawnAndCapture(name: string): Promise<void> {
  const repo = join(SCRATCH, name)
  mkdirSync(repo, { recursive: true })
  const env = buildEnv(name)
  const result = await claudeSpawn([name, '--repo', repo, '--cwd', repo], env)
  expect(result.code).toBe(0)
  // Cleanup the markers this spawn wrote.
  rmSync(cwdFile(name), { force: true })
  rmSync(readyFile(name), { force: true })
  try {
    const fs = await import('node:fs')
    const sid = fs.readFileSync(sidFile(name), 'utf8').trim()
    rmSync(lastFileFor(sid), { force: true })
  } catch {
    /* ignore */
  }
  rmSync(sidFile(name), { force: true })
}

describe('teammate launch hardening flags', () => {
  test('new-session injects CLAUDE_CODE_RESUME_TOKEN_THRESHOLD to suppress the resume modal', async () => {
    await spawnAndCapture('alpha')
    const newSession = calls.find((c) => c[0] === 'new-session')
    expect(newSession).toBeDefined()
    // The env is passed as a `-e KEY=VAL` pair; assert the value is present.
    expect(newSession).toContain('CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=100000000')
    // And the existing identity-gate env is still there alongside it.
    expect(newSession!.some((a) => a.startsWith('CLAUDEMUX_TEAMMATE_NAME='))).toBe(true)
  })

  test('the claude launch command disables AskUserQuestion + plan-mode tools', async () => {
    await spawnAndCapture('beta')
    const sendKeys = calls.find((c) => c[0] === 'send-keys')
    expect(sendKeys).toBeDefined()
    // launchCmd is the send-keys literal payload (index 3: send-keys -t <pane> <cmd> Enter).
    const launchCmd = sendKeys!.find((a) => a.startsWith('claude '))
    expect(launchCmd).toBeDefined()
    expect(launchCmd).toContain('--disallowedTools AskUserQuestion,EnterPlanMode,ExitPlanMode')
  })
})
