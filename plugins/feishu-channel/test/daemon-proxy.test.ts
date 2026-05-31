import { describe, expect, test, vi } from 'vitest'

import { createDaemonConnection, type DaemonCore } from '../src/daemon-connection'
import { createProxyClient } from '../src/proxy-client'
import type { DaemonToProxy, ProxyToDaemon } from '../src/ipc'

/**
 * Wire a daemon-connection and a proxy-client together over an in-memory
 * message queue (no sockets). `pump()` drains queued messages through the peer's
 * handler, so a test triggers an action then `await pump()` to settle the
 * request/response chain deterministically.
 */
function connect(opts: {
  core: DaemonCore
  deliverToClaude(content: string, meta: Record<string, string>): Promise<void>
  onAck?(eventId: string): void
  role?: 'dispatcher' | 'session'
}) {
  const queue: Array<['proxy', DaemonToProxy] | ['daemon', ProxyToDaemon]> = []

  const daemonConn = createDaemonConnection({
    daemonVersion: '0.2.1',
    generation: 1,
    core: opts.core,
    onAck: opts.onAck,
    send: (m) => queue.push(['proxy', m]),
  })
  const proxyClient = createProxyClient({
    sessionId: 'sess-A',
    pid: 999,
    proxyVersion: '0.2.1',
    role: opts.role ?? 'session',
    deliverToClaude: opts.deliverToClaude,
    send: (m) => queue.push(['daemon', m]),
  })

  async function pump() {
    while (queue.length) {
      const next = queue.shift()!
      if (next[0] === 'proxy') await proxyClient.handle(next[1])
      else await daemonConn.handle(next[1])
    }
  }
  return { daemonConn, proxyClient, pump }
}

describe('daemon <-> proxy protocol', () => {
  test('proxy receives the daemon hello; daemon records the proxy register', async () => {
    const { daemonConn, proxyClient, pump } = connect({
      core: { handleTool: async () => ({}) },
      deliverToClaude: async () => {},
    })
    proxyClient.register()
    await pump()
    expect(proxyClient.daemon).toEqual({ daemonVersion: '0.2.1', generation: 1 })
    expect(daemonConn.session).toEqual({
      sessionId: 'sess-A',
      pid: 999,
      proxyVersion: '0.2.1',
      role: 'session',
    })
  })

  test('forwards a tool call and returns the daemon-run result', async () => {
    const handleTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      ran: name,
      echoed: args,
    }))
    const { proxyClient, pump } = connect({
      core: { handleTool },
      deliverToClaude: async () => {},
    })
    const call = proxyClient.callTool('reply', { chat_id: 'oc_x', text: 'hi' })
    await pump()
    await expect(call).resolves.toEqual({ ran: 'reply', echoed: { chat_id: 'oc_x', text: 'hi' } })
    expect(handleTool).toHaveBeenCalledWith('reply', { chat_id: 'oc_x', text: 'hi' })
  })

  test('a throwing tool surfaces as a rejected callTool', async () => {
    const { proxyClient, pump } = connect({
      core: { handleTool: async () => { throw new Error('feishu said no') } },
      deliverToClaude: async () => {},
    })
    const call = proxyClient.callTool('react', { message_id: 'om_1', emoji: 'OK' })
    await pump()
    await expect(call).rejects.toThrow('feishu said no')
  })

  test('delivery is ACKed only after the Claude-facing write resolves', async () => {
    const order: string[] = []
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((r) => { releaseWrite = r })
    const onAck = vi.fn((eventId: string) => order.push(`ack:${eventId}`))

    const { daemonConn, pump } = connect({
      core: { handleTool: async () => ({}) },
      onAck,
      deliverToClaude: async (content, meta) => {
        order.push(`deliver:${meta.message_id}:${content}`)
        await writeGate // block the notification write until released
        order.push('written')
      },
    })

    daemonConn.deliver('evt_1', 'done', { message_id: 'om_9' })
    // pump parks inside the proxy's deliver handler (awaiting the gated write),
    // so drive it in the background rather than awaiting it here.
    const pumping = pump()
    await Promise.resolve() // let the delivery reach the proxy and record + park
    expect(order).toEqual(['deliver:om_9:done'])
    expect(onAck).not.toHaveBeenCalled()

    releaseWrite() // the channel notification hits the transport
    await pumping // the write resolves, the proxy ACKs, the daemon records it
    expect(onAck).toHaveBeenCalledWith('evt_1')
    expect(order).toEqual(['deliver:om_9:done', 'written', 'ack:evt_1'])
  })

  test('a failed Claude-facing write produces no ACK (row stays undelivered)', async () => {
    const onAck = vi.fn()
    const { daemonConn, pump } = connect({
      core: { handleTool: async () => ({}) },
      onAck,
      deliverToClaude: async () => { throw new Error('stdio closed') },
    })
    daemonConn.deliver('evt_2', 'hi', { message_id: 'om_2' })
    await pump()
    expect(onAck).not.toHaveBeenCalled()
  })
})
