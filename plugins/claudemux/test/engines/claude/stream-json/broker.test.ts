import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { brokerMain } from '../../../../src/engines/claude/stream-json/broker'
import { brokerRequest } from '../../../../src/engines/claude/stream-json/client'
import { brokerAlive, removeBrokerDir } from '../../../../src/engines/claude/stream-json/registry'
import { buildClaudeEnv, type BrokerSpawnParams } from '../../../../src/engines/claude/stream-json/launch'
import { proxyRole } from '../../../../../feishu-channel/src/proxy-role'

/**
 * Drives the real broker loop (`brokerMain`) in-process against the fake
 * `claude` fixture, then talks to it over the unix socket exactly as `tm`
 * does. This is the end-to-end replacement for the retired tmux conformance
 * suite: spawn → send → structured result → kill, with no real Claude install.
 */

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/fake-claude.mjs')

function uniqueName(): string {
  return `sjt-${process.pid}-${Math.floor(performance.now() * 1000) % 1_000_000}`
}

function paramsFor(name: string): BrokerSpawnParams {
  return {
    name,
    repo: process.cwd(),
    cwd: process.cwd(),
    worktreeSlug: null,
    dispatcherDir: process.cwd(),
    projectsDir: '/tmp/sjt-projects',
    sessionId: null,
    resumeSid: null,
    remoteControl: false,
  }
}

async function waitReady(name: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (brokerAlive(name)) {
      const ping = await brokerRequest(name, { op: 'ping' })
      if (ping.ok && ping.kind === 'ping' && ping.ready) return
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('broker did not become ready')
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`file did not appear: ${path}`)
}

async function waitRemoteControlUrl(name: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const status = await brokerRequest(name, { op: 'status' })
    if (status.ok && status.kind === 'status' && status.status.remoteControlUrl !== null) {
      return status.status.remoteControlUrl
    }
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('remote control URL did not appear')
}

let running: { name: string; promise: Promise<number> } | null = null

beforeAll(() => {
  chmodSync(FAKE, 0o755)
  process.env['CLAUDEMUX_CLAUDE'] = FAKE
})

afterEach(async () => {
  if (running !== null) {
    if (brokerAlive(running.name)) await brokerRequest(running.name, { op: 'kill' })
    await Promise.race([running.promise, new Promise((r) => setTimeout(r, 2000))])
    removeBrokerDir(running.name)
    running = null
  }
})

describe('stream-json broker end-to-end', () => {
  it('boots, answers ping, runs a turn, and kills', async () => {
    const name = uniqueName()
    const promise = brokerMain(paramsFor(name))
    running = { name, promise }
    await waitReady(name)

    const send = await brokerRequest(name, { op: 'send', prompt: 'hello world', timeoutMs: 5000 })
    expect(send.ok).toBe(true)
    if (!send.ok || send.kind !== 'turn') throw new Error('expected a turn')
    expect(send.turn.isError).toBe(false)
    expect(send.turn.text).toBe('echo: hello world')
    expect(send.turn.sessionId).toBe('11111111-2222-3333-4444-555555555555')
    expect(send.turn.totalCostUsd).toBe(0.001)
    expect(send.turn.cacheReadInputTokens).toBe(2)

    const status = await brokerRequest(name, { op: 'status' })
    expect(status.ok && status.kind === 'status' && status.status.model).toBe('fake-model')

    const last = await brokerRequest(name, { op: 'last' })
    expect(last.ok && last.kind === 'last' && last.text).toBe('echo: hello world')

    const kill = await brokerRequest(name, { op: 'kill' })
    expect(kill.ok && kill.kind === 'killed').toBe(true)
    await Promise.race([promise, new Promise((r) => setTimeout(r, 2000))])
    expect(brokerAlive(name)).toBe(false)
    running = null
    removeBrokerDir(name)
  })

  it('serves multiple sequential turns on one persistent session', async () => {
    const name = uniqueName()
    const promise = brokerMain(paramsFor(name))
    running = { name, promise }
    await waitReady(name)

    const a = await brokerRequest(name, { op: 'send', prompt: 'first', timeoutMs: 5000 })
    const b = await brokerRequest(name, { op: 'send', prompt: 'second', timeoutMs: 5000 })
    expect(a.ok && a.kind === 'turn' && a.turn.text).toBe('echo: first')
    expect(b.ok && b.kind === 'turn' && b.turn.text).toBe('echo: second')
  })

  it('an empty (tool-only) turn clears the last reply — no stale carry-over', async () => {
    const name = uniqueName()
    const promise = brokerMain(paramsFor(name))
    running = { name, promise }
    await waitReady(name)

    const first = await brokerRequest(name, { op: 'send', prompt: 'real reply', timeoutMs: 5000 })
    expect(first.ok && first.kind === 'turn' && first.turn.text).toBe('echo: real reply')
    const afterReal = await brokerRequest(name, { op: 'last' })
    expect(afterReal.ok && afterReal.kind === 'last' && afterReal.text).toBe('echo: real reply')

    const empty = await brokerRequest(name, { op: 'send', prompt: '__EMPTY__', timeoutMs: 5000 })
    expect(empty.ok && empty.kind === 'turn' && empty.turn.text).toBe('')
    // `last` and `status` must reflect the empty turn, not the prior reply.
    const afterEmpty = await brokerRequest(name, { op: 'last' })
    expect(afterEmpty.ok && afterEmpty.kind === 'last' && afterEmpty.text).toBe('')
    const status = await brokerRequest(name, { op: 'status' })
    expect(status.ok && status.kind === 'status' && status.status.lastText).toBeNull()
  })

  it('captures a spontaneous (RC/channel-driven) turn with no tm send — wait --fresh and last reflect it', async () => {
    const name = uniqueName()
    process.env['FAKE_CLAUDE_SPONTANEOUS_MS'] = '500'
    let promise: Promise<number>
    try {
      promise = brokerMain(paramsFor(name))
      running = { name, promise }
      await waitReady(name)
      // No `tm send`. A `wait --fresh` attached now must resolve with the
      // spontaneous turn the fixture emits at ~500ms — not a stale turn and not
      // child-gone.
      const wait = await brokerRequest(name, { op: 'wait', timeoutMs: 5000, fresh: true })
      expect(wait.ok && wait.kind === 'turn' && wait.turn.text).toBe('spontaneous reply')
      // The turn signal the fleet verbs read reflects it too.
      const last = await brokerRequest(name, { op: 'last' })
      expect(last.ok && last.kind === 'last' && last.text).toBe('spontaneous reply')
      const status = await brokerRequest(name, { op: 'status' })
      expect(status.ok && status.kind === 'status' && status.status.state).toBe('idle')
    } finally {
      delete process.env['FAKE_CLAUDE_SPONTANEOUS_MS']
    }
  })

  it('enables remote control and captures the session URL', async () => {
    const name = uniqueName()
    const p = { ...paramsFor(name), remoteControl: true }
    const promise = brokerMain(p)
    running = { name, promise }
    await waitReady(name)
    expect(await waitRemoteControlUrl(name)).toBe('https://example.invalid/session/fake')
  })

  it('launches the teammate claude child without inherited channel argv or env', async () => {
    const name = uniqueName()
    const dir = mkdtempSync(join(tmpdir(), 'claudemux-fake-claude-'))
    const capture = join(dir, 'capture.json')
    const stateDir = join(dir, 'feishu-state')
    const captureKeys = [
      'CLAUDEMUX_TEAMMATE_NAME',
      'CLAUDEMUX_TEST_KEEP_ENV',
      'POWERSHELL_DISTRIBUTION_CHANNEL',
      'FEISHU_CHANNEL_PROXY_ROLE',
      'FEISHU_CHANNEL_DISPATCHER',
      'FEISHU_CHANNEL_SESSION_ID',
      'FEISHU_CHANNEL_STATE_DIR',
      'CLAUDE_CHANNELS',
      'CLAUDE_CODE_CHANNELS',
    ]
    const previous = {
      fakeCapture: process.env['FAKE_CLAUDE_CAPTURE_FILE'],
      fakeCaptureKeys: process.env['FAKE_CLAUDE_CAPTURE_ENV_KEYS'],
      feishuDispatcher: process.env['FEISHU_CHANNEL_DISPATCHER'],
      feishuRole: process.env['FEISHU_CHANNEL_PROXY_ROLE'],
      feishuSessionId: process.env['FEISHU_CHANNEL_SESSION_ID'],
      feishuStateDir: process.env['FEISHU_CHANNEL_STATE_DIR'],
      claudeChannels: process.env['CLAUDE_CHANNELS'],
      claudeCodeChannels: process.env['CLAUDE_CODE_CHANNELS'],
      powershellChannel: process.env['POWERSHELL_DISTRIBUTION_CHANNEL'],
      keep: process.env['CLAUDEMUX_TEST_KEEP_ENV'],
    }
    process.env['FAKE_CLAUDE_CAPTURE_FILE'] = capture
    process.env['FAKE_CLAUDE_CAPTURE_ENV_KEYS'] = captureKeys.join(',')
    process.env['FEISHU_CHANNEL_DISPATCHER'] = '1'
    process.env['FEISHU_CHANNEL_PROXY_ROLE'] = 'dispatcher'
    process.env['FEISHU_CHANNEL_SESSION_ID'] = 'dispatcher-session'
    process.env['FEISHU_CHANNEL_STATE_DIR'] = stateDir
    process.env['CLAUDE_CHANNELS'] = 'plugin:feishu-channel@example'
    process.env['CLAUDE_CODE_CHANNELS'] = 'plugin:feishu-channel@example'
    process.env['POWERSHELL_DISTRIBUTION_CHANNEL'] = 'GitHubActions'
    process.env['CLAUDEMUX_TEST_KEEP_ENV'] = 'keep'
    try {
      const promise = brokerMain({ ...paramsFor(name), remoteControl: true })
      running = { name, promise }
      await waitReady(name)
      await waitForFile(capture)

      const launched = JSON.parse(readFileSync(capture, 'utf8')) as {
        argv: string[]
        env: Record<string, string>
      }
      expect(launched.argv).not.toContain('--channels')
      expect(launched.env['CLAUDEMUX_TEAMMATE_NAME']).toBe(name)
      expect(launched.env['CLAUDEMUX_TEST_KEEP_ENV']).toBe('keep')
      expect(launched.env['POWERSHELL_DISTRIBUTION_CHANNEL']).toBe('GitHubActions')
      expect(launched.env['FEISHU_CHANNEL_STATE_DIR']).toBe(stateDir)
      expect(launched.env['FEISHU_CHANNEL_PROXY_ROLE']).toBeUndefined()
      expect(launched.env['FEISHU_CHANNEL_DISPATCHER']).toBeUndefined()
      expect(launched.env['FEISHU_CHANNEL_SESSION_ID']).toBeUndefined()
      expect(launched.env['CLAUDE_CHANNELS']).toBeUndefined()
      expect(launched.env['CLAUDE_CODE_CHANNELS']).toBeUndefined()
      expect(proxyRole(launched.env)).toBe('session')

      expect(await waitRemoteControlUrl(name)).toBe('https://example.invalid/session/fake')
    } finally {
      if (previous.fakeCapture === undefined) delete process.env['FAKE_CLAUDE_CAPTURE_FILE']
      else process.env['FAKE_CLAUDE_CAPTURE_FILE'] = previous.fakeCapture
      if (previous.fakeCaptureKeys === undefined) delete process.env['FAKE_CLAUDE_CAPTURE_ENV_KEYS']
      else process.env['FAKE_CLAUDE_CAPTURE_ENV_KEYS'] = previous.fakeCaptureKeys
      if (previous.feishuDispatcher === undefined) delete process.env['FEISHU_CHANNEL_DISPATCHER']
      else process.env['FEISHU_CHANNEL_DISPATCHER'] = previous.feishuDispatcher
      if (previous.feishuRole === undefined) delete process.env['FEISHU_CHANNEL_PROXY_ROLE']
      else process.env['FEISHU_CHANNEL_PROXY_ROLE'] = previous.feishuRole
      if (previous.feishuSessionId === undefined) delete process.env['FEISHU_CHANNEL_SESSION_ID']
      else process.env['FEISHU_CHANNEL_SESSION_ID'] = previous.feishuSessionId
      if (previous.feishuStateDir === undefined) delete process.env['FEISHU_CHANNEL_STATE_DIR']
      else process.env['FEISHU_CHANNEL_STATE_DIR'] = previous.feishuStateDir
      if (previous.claudeChannels === undefined) delete process.env['CLAUDE_CHANNELS']
      else process.env['CLAUDE_CHANNELS'] = previous.claudeChannels
      if (previous.claudeCodeChannels === undefined) delete process.env['CLAUDE_CODE_CHANNELS']
      else process.env['CLAUDE_CODE_CHANNELS'] = previous.claudeCodeChannels
      if (previous.powershellChannel === undefined) delete process.env['POWERSHELL_DISTRIBUTION_CHANNEL']
      else process.env['POWERSHELL_DISTRIBUTION_CHANNEL'] = previous.powershellChannel
      if (previous.keep === undefined) delete process.env['CLAUDEMUX_TEST_KEEP_ENV']
      else process.env['CLAUDEMUX_TEST_KEEP_ENV'] = previous.keep
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds teammate env from a controlled parent env', () => {
    const stripped = buildClaudeEnv({
      FEISHU_CHANNEL_PROXY_ROLE: 'dispatcher',
      FEISHU_CHANNEL_DISPATCHER: '1',
      FEISHU_CHANNEL_SESSION_ID: 'dispatcher-session',
      FEISHU_CHANNEL_STATE_DIR: '/tmp/example-feishu-state',
      CLAUDE_CHANNELS: 'plugin:feishu-channel@example',
      CLAUDE_CODE_CHANNELS: 'plugin:feishu-channel@example',
      POWERSHELL_DISTRIBUTION_CHANNEL: 'GitHubActions',
      PATH: '/bin',
      HOME: '/tmp/home',
      ORDINARY_ENV: 'kept',
    }, 'alpha')

    expect(stripped['CLAUDEMUX_TEAMMATE_NAME']).toBe('alpha')
    expect(stripped['FEISHU_CHANNEL_PROXY_ROLE']).toBeUndefined()
    expect(stripped['FEISHU_CHANNEL_DISPATCHER']).toBeUndefined()
    expect(stripped['FEISHU_CHANNEL_SESSION_ID']).toBeUndefined()
    expect(stripped['CLAUDE_CHANNELS']).toBeUndefined()
    expect(stripped['CLAUDE_CODE_CHANNELS']).toBeUndefined()
    expect(stripped['FEISHU_CHANNEL_STATE_DIR']).toBe('/tmp/example-feishu-state')
    expect(stripped['POWERSHELL_DISTRIBUTION_CHANNEL']).toBe('GitHubActions')
    expect(stripped['ORDINARY_ENV']).toBe('kept')
    expect(proxyRole(stripped)).toBe('session')
  })
})
