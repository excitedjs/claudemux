import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { brokerMain } from '../../../../src/engines/claude/stream-json/broker'
import { brokerRequest } from '../../../../src/engines/claude/stream-json/client'
import { brokerAlive, removeBrokerDir } from '../../../../src/engines/claude/stream-json/registry'
import type { BrokerSpawnParams } from '../../../../src/engines/claude/stream-json/launch'

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

  it('enables remote control and captures the session URL', async () => {
    const name = uniqueName()
    const p = { ...paramsFor(name), remoteControl: true }
    const promise = brokerMain(p)
    running = { name, promise }
    await waitReady(name)
    // The RC enable is fire-and-forget after init; give the fixture a tick to
    // answer the control request, then read it off status.
    await new Promise((r) => setTimeout(r, 100))
    const status = await brokerRequest(name, { op: 'status' })
    expect(status.ok && status.kind === 'status' && status.status.remoteControlUrl).toBe('https://example.invalid/session/fake')
  })
})
