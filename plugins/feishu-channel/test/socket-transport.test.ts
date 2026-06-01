import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemonServer, type DaemonServer } from '../src/daemon-server'
import { connectToDaemon, type ProxyConnection } from '../src/proxy-transport'

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('daemon/proxy over a real unix socket', () => {
  let sockN = 0
  let socketPath = ''
  let server: DaemonServer | null = null
  let proxy: ProxyConnection | null = null

  beforeEach(() => {
    socketPath = join(tmpdir(), `feishu-daemon-test-${process.pid}-${sockN++}.sock`)
  })
  afterEach(async () => {
    proxy?.close()
    await server?.close()
    server = null
    proxy = null
  })

  test('a proxy connects, registers, and round-trips a tool call through the socket', async () => {
    const handleTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      ok: name,
      args,
    }))
    server = await startDaemonServer({
      socketPath,
      daemonVersion: '0.2.1',
      generation: 2,
      core: { handleTool },
    })

    const delivered: Array<{ content: string; meta: Record<string, string> }> = []
    proxy = await connectToDaemon({
      socketPath,
      sessionId: 'sess-X',
      pid: 4321,
      proxyVersion: '0.2.1',
      role: 'dispatcher',
      deliverToClaude: async (content, meta) => {
        delivered.push({ content, meta })
      },
    })

    // hello + register flowed over the socket
    await waitFor(() => proxy!.client.daemon !== null)
    expect(proxy!.client.daemon).toEqual({ daemonVersion: '0.2.1', generation: 2 })
    await waitFor(() => server!.connections.size === 1)
    const conn = [...server!.connections][0]!
    await waitFor(() => conn.session !== null)
    expect(conn.session).toEqual({
      sessionId: 'sess-X',
      pid: 4321,
      proxyVersion: '0.2.1',
      role: 'dispatcher',
      metadata: {},
    })

    // tool call: proxy -> socket -> daemon core -> result -> socket -> proxy
    await expect(proxy.client.callTool('reply', { chat_id: 'oc_1', text: 'hi' })).resolves.toEqual({
      ok: 'reply',
      args: { chat_id: 'oc_1', text: 'hi' },
    })
    expect(handleTool).toHaveBeenCalledWith('reply', { chat_id: 'oc_1', text: 'hi' })
  })

  test('a daemon delivery reaches the proxy and is ACKed back over the socket', async () => {
    const acked: string[] = []
    server = await startDaemonServer({
      socketPath,
      daemonVersion: '0.2.1',
      generation: 1,
      core: { handleTool: async () => ({}) },
      onAck: (eventId) => acked.push(eventId),
    })

    const delivered: Array<{ content: string; meta: Record<string, string> }> = []
    proxy = await connectToDaemon({
      socketPath,
      sessionId: 'sess-Y',
      pid: 5,
      proxyVersion: '0.2.1',
      role: 'session',
      deliverToClaude: async (content, meta) => {
        delivered.push({ content, meta })
      },
    })

    await waitFor(() => server!.connections.size === 1)
    const conn = [...server!.connections][0]!
    conn.deliver('evt_42', '# done', { message_id: 'om_7' })

    await waitFor(() => delivered.length === 1)
    expect(delivered[0]).toEqual({ content: '# done', meta: { message_id: 'om_7' } })
    await waitFor(() => acked.length === 1)
    expect(acked).toEqual(['evt_42'])
  })
})
