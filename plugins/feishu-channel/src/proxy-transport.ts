/**
 * Proxy-side unix socket connection to the daemon (claudemux#10, slice-1 OS layer).
 *
 * Connects the thin stdio proxy to the daemon's socket and frames bytes <-> IPC
 * messages, driving a ProxyClient. The OS bridge over the socket-agnostic
 * handler in proxy-client.ts — this file owns only `net.Socket`, framing, and
 * the connect lifecycle.
 */

import { connect, type Socket } from 'node:net'

import { FrameDecoder, encodeFrame, type DaemonToProxy } from './ipc'
import { createProxyClient, type ProxyClient } from './proxy-client'

export interface ProxyConnectionDeps {
  socketPath: string
  sessionId: string
  pid: number
  proxyVersion: string
  role: 'dispatcher' | 'session'
  /** Source-specific identity reported in `register` (opaque to the daemon). */
  metadata?: Record<string, string>
  /** Writes a delivered event to Claude (the MCP notification); resolves on write. */
  deliverToClaude(content: string, meta: Record<string, string>): Promise<void>
  /** Called when an established socket closes. */
  onClose?(): void
  logError?(message: string, err?: unknown): void
}

export interface ProxyConnection {
  readonly client: ProxyClient
  close(): void
}

/** Connect to the daemon, register, and return the driven ProxyClient. */
export function connectToDaemon(deps: ProxyConnectionDeps): Promise<ProxyConnection> {
  const logError = deps.logError ?? ((m, e) => console.error(`[proxy] ${m}`, e ?? ''))
  const decoder = new FrameDecoder<DaemonToProxy>()

  return new Promise<ProxyConnection>((resolve, reject) => {
    const socket: Socket = connect(deps.socketPath)
    let settled = false
    let closed = false

    const client = createProxyClient({
      sessionId: deps.sessionId,
      pid: deps.pid,
      proxyVersion: deps.proxyVersion,
      role: deps.role,
      metadata: deps.metadata,
      deliverToClaude: deps.deliverToClaude,
      logError,
      send: (message) => {
        if (!socket.destroyed) socket.write(encodeFrame(message))
      },
    })

    socket.on('data', (chunk: Buffer) => {
      let messages
      try {
        messages = decoder.push(chunk)
      } catch (err) {
        logError('framing error — closing connection', err)
        socket.destroy()
        return
      }
      for (const m of messages) {
        void client.handle(m).catch((err) => logError('handle failed', err))
        if (!settled && m.t === 'hello') {
          settled = true
          resolve({
            client,
            close: () => socket.destroy(),
          })
        }
      }
    })
    socket.on('error', (err) => {
      logError('socket error', err)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    socket.on('close', () => {
      if (closed) return
      closed = true
      client.disconnect(new Error('Feishu daemon socket closed'))
      if (!settled) {
        settled = true
        reject(new Error('Feishu daemon socket closed before hello'))
        return
      }
      deps.onClose?.()
    })
    socket.once('connect', () => {
      client.register()
    })
  })
}
