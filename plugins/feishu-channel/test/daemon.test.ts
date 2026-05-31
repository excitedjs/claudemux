import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type StartDaemonResult } from '../src/daemon'
import { connectToDaemon, type ProxyConnection } from '../src/proxy-transport'
import type { FeishuTransport } from '../src/feishu'
import type { DaemonLockRecord } from '../src/daemon-lock'

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

  test('serves a proxy: a reply tool round-trips daemon core -> transport', async () => {
    const { r, socketPath, transport } = await boot()
    expect(r.started).toBe(true)
    const proxy = await connectToDaemon({
      socketPath,
      sessionId: 's1',
      pid: 1,
      proxyVersion: '0.2.1',
      deliverToClaude: async () => {},
    })
    proxies.push(proxy)
    const result = await proxy.client.callTool('reply', { chat_id: 'oc_1', text: 'hi' })
    expect(transport.sendText).toHaveBeenCalledWith('oc_1', 'hi')
    expect(result).toBeDefined()
  })
})
