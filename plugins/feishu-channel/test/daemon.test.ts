import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type StartDaemonResult } from '../src/daemon'
import { connectToDaemon, type ProxyConnection } from '../src/proxy-transport'
import type { FeishuTransport } from '../src/feishu'
import type { DaemonLockRecord } from '../src/daemon-lock'
import { acquireInstanceLockWithEviction } from '../src/instance-lock'

function fakeTransport(): FeishuTransport {
  return {
    appId: 'cli_fake',
    botOpenId: undefined,
    start: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ messageIds: ['om_sent'] })),
    addReaction: vi.fn(async () => 'rk_1'),
    removeReaction: vi.fn(async () => {}),
    editText: vi.fn(async () => {}),
    fetchDocComment: vi.fn(async () => null),
    fetchDocMeta: vi.fn(async () => null),
    close: vi.fn(async () => {}),
  } as unknown as FeishuTransport
}

let n = 0
const tmp = (ext: string) => join(tmpdir(), `feishu-daemonbody-${process.pid}-${n++}.${ext}`)
const self = (socketPath: string): DaemonLockRecord => ({
  pid: process.pid,
  startedAt: 1000,
  socketPath,
  daemonVersion: '0.2.1',
})

describe('startDaemon (process body)', () => {
  const started: StartDaemonResult[] = []
  const proxies: ProxyConnection[] = []
  afterEach(async () => {
    for (const p of proxies.splice(0)) p.close()
    for (const r of started.splice(0)) if (r.started) await r.close()
  })

  async function boot(over: Partial<Parameters<typeof startDaemon>[0]> = {}) {
    const socketPath = tmp('sock')
    const lockPath = tmp('lock')
    const transport = fakeTransport()
    const r = await startDaemon({
      lockPath,
      socketPath,
      daemonVersion: '0.2.1',
      generation: 1,
      self: self(socketPath),
      transport,
      accessFile: tmp('access.json'),
      queueFile: tmp('queue.json'),
      baseDir: tmpdir(),
      ...over,
    })
    started.push(r)
    return { r, socketPath, lockPath, transport }
  }

  test('becomes the daemon: opens the transport and holds the lock', async () => {
    const { r, lockPath, transport } = await boot()
    expect(r.started).toBe(true)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(existsSync(`${lockPath}.lock`)).toBe(true)
  })

  test('idempotent startup: a second start finds the live daemon and reuses it', async () => {
    const { socketPath, lockPath } = await boot()
    // second daemon, same lock + socket — the held fresh lock makes it stand down
    const second = await startDaemon({
      lockPath,
      socketPath,
      daemonVersion: '0.2.1',
      generation: 1,
      self: self(socketPath),
      transport: fakeTransport(),
      accessFile: tmp('access.json'),
      queueFile: tmp('queue.json'),
      baseDir: tmpdir(),
    })
    started.push(second)
    expect(second.started).toBe(false)
    if (!second.started) expect(['held', 'serving']).toContain(second.reason)
  })

  test('evicts an older serving daemon through the legacy inbound lock primitive, then starts', async () => {
    const legacyLock = tmp('legacy.lock')
    const acquireLegacyInboundLock = vi.fn(async () => ({ acquired: true as const, evicted: true }))
    const releaseLegacyInboundLock = vi.fn()
    let probed = false

    const { r, transport } = await boot({
      daemonVersion: '0.4.0',
      legacyInboundLockPath: legacyLock,
      acquireLegacyInboundLock,
      releaseLegacyInboundLock,
      probe: async () => {
        if (!probed) {
          probed = true
          return true
        }
        return false
      },
      probeDaemonInfo: async () => ({ daemonVersion: '0.3.0', generation: 1 }),
    })

    expect(r.started).toBe(true)
    expect(acquireLegacyInboundLock).toHaveBeenCalledWith(legacyLock)
    expect(releaseLegacyInboundLock).toHaveBeenCalledWith(legacyLock)
    expect(transport.start).toHaveBeenCalledTimes(1)
  })

  test('does not evict a same-version serving daemon', async () => {
    const acquireLegacyInboundLock = vi.fn(async () => ({ acquired: true as const, evicted: true }))

    const { r, transport } = await boot({
      daemonVersion: '0.4.0',
      legacyInboundLockPath: tmp('legacy.lock'),
      acquireLegacyInboundLock,
      probe: async () => true,
      probeDaemonInfo: async () => ({ daemonVersion: '0.4.0', generation: 1 }),
    })

    expect(r).toEqual({ started: false, reason: 'serving' })
    expect(acquireLegacyInboundLock).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
  })

  test('after forced legacy eviction, waits out proper-lockfile stale floor and reclaims the daemon lock', async () => {
    const socketPath = tmp('sock')
    const lockPath = tmp('lock')
    const legacyLock = tmp('legacy.lock')
    mkdirSync(`${lockPath}.lock`)
    writeFileSync(legacyLock, '4242\n')

    let holderAlive = true
    const signals: string[] = []
    const waits: number[] = []
    const transport = fakeTransport()
    const r = await startDaemon({
      lockPath,
      socketPath,
      daemonVersion: '0.4.0',
      generation: 1,
      self: { ...self(socketPath), daemonVersion: '0.4.0' },
      transport,
      accessFile: tmp('access.json'),
      queueFile: tmp('queue.json'),
      baseDir: tmpdir(),
      legacyInboundLockPath: legacyLock,
      probe: async () => false,
      probeDaemonInfo: async () => ({ daemonVersion: '0.3.0', generation: 1 }),
      acquireLegacyInboundLock: (path) => acquireInstanceLockWithEviction(path, {
        pid: process.pid,
        isProcessAlive: (pid) => (pid === 4242 ? holderAlive : pid === process.pid),
        selfDir: '/cache/claudemux/feishu-channel/0.4.0',
        probe: (pid) => (pid === 4242
          ? { command: 'tsx src/server.ts', cwd: '/cache/claudemux/feishu-channel/0.4.0' }
          : undefined),
        signal: (_pid, signal) => {
          signals.push(signal)
          if (signal === 'SIGKILL') holderAlive = false
        },
        sleep: async () => {},
        requireDifferentSelfDir: false,
      }),
      sleep: async (ms) => {
        waits.push(ms)
        const stale = new Date(Date.now() - 3_000)
        utimesSync(`${lockPath}.lock`, stale, stale)
      },
    })
    started.push(r)

    expect(r.started).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(waits).toEqual([2_000])
    expect(transport.start).toHaveBeenCalledTimes(1)
  })

  test('serves a proxy: a reply tool round-trips daemon core -> transport', async () => {
    const { r, socketPath, transport } = await boot()
    expect(r.started).toBe(true)
    const proxy = await connectToDaemon({
      socketPath,
      sessionId: 's1',
      pid: 1,
      proxyVersion: '0.2.1',
      role: 'dispatcher',
      deliverToClaude: async () => {},
    })
    proxies.push(proxy)
    const result = await proxy.client.callTool('reply', { chat_id: 'oc_1', text: 'hi' })
    expect(transport.sendText).toHaveBeenCalledWith('oc_1', 'hi')
    expect(result).toBeDefined()
  })

  test('holds and releases the legacy inbound lock while the daemon owns Feishu', async () => {
    const acquireLegacyInboundLock = vi.fn(async () => ({ acquired: true, evicted: true }))
    const releaseLegacyInboundLock = vi.fn()

    const { r, transport } = await boot({
      legacyInboundLockPath: tmp('legacy.lock'),
      acquireLegacyInboundLock,
      releaseLegacyInboundLock,
    })

    expect(r.started).toBe(true)
    expect(acquireLegacyInboundLock).toHaveBeenCalledTimes(1)
    expect(transport.start).toHaveBeenCalledTimes(1)
    if (r.started) await r.close()
    expect(releaseLegacyInboundLock).toHaveBeenCalledTimes(1)
    started.length = 0
  })

  test('stands down before opening Feishu when an old legacy holder cannot be evicted', async () => {
    const acquireLegacyInboundLock = vi.fn(async () => ({
      acquired: false as const,
      holderPid: 4242,
      evicted: false,
    }))

    const { r, transport } = await boot({
      legacyInboundLockPath: tmp('legacy.lock'),
      acquireLegacyInboundLock,
    })

    expect(r).toEqual({ started: false, reason: 'held' })
    expect(transport.start).not.toHaveBeenCalled()
  })
})
