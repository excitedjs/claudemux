/**
 * Daemon-side unix socket server (claudemux#10 daemon refactor, slice-1 OS layer).
 *
 * Binds the standing daemon's listening socket and, per accepted proxy
 * connection, frames bytes <-> IPC messages and drives a DaemonConnection. This
 * is the thin OS bridge over the already-tested protocol handler in
 * daemon-connection.ts: the handler logic stays socket-agnostic; this file owns
 * only `net.Server`, framing, and per-socket lifecycle.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'

import { createDaemonConnection, type DaemonConnection, type DaemonCore } from './daemon-connection'
import { probeDaemonSocket } from './daemon-lock'
import { FrameDecoder, encodeFrame, type ProxyToDaemon } from './ipc'

/**
 * Thrown when the socket is already bound by a *live* daemon — the atomic
 * single-instance signal. The caller (startDaemon) treats it as "reuse the
 * running daemon", not an error to crash on.
 */
export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly socketPath: string) {
    super(`a daemon is already listening on ${socketPath}`)
    this.name = 'DaemonAlreadyRunningError'
  }
}

export interface DaemonServerDeps {
  /** Absolute path of the unix socket to bind. */
  socketPath: string
  /** Daemon version, advertised to each proxy in `hello`. */
  daemonVersion: string
  /** Current active generation (see #10 handoff spec). */
  generation: number
  /** The shared channel core every connection runs forwarded tool calls against. */
  core: DaemonCore
  /** Marks an inbound row delivered once a proxy ACKs it (slice-2 persists this). */
  onAck?(eventId: string): void
  logError?(message: string, err?: unknown): void
}

export interface DaemonServer {
  /** The live connections, keyed by socket — lets the daemon route/deliver. */
  readonly connections: ReadonlySet<DaemonConnection>
  close(): Promise<void>
}

export function startDaemonServer(deps: DaemonServerDeps): Promise<DaemonServer> {
  const logError = deps.logError ?? ((m, e) => console.error(`[daemon] ${m}`, e ?? ''))
  const connections = new Set<DaemonConnection>()
  const sockets = new Set<Socket>()

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    const decoder = new FrameDecoder<ProxyToDaemon>()
    const conn = createDaemonConnection({
      daemonVersion: deps.daemonVersion,
      generation: deps.generation,
      core: deps.core,
      onAck: deps.onAck,
      logError,
      send: (message) => {
        if (!socket.destroyed) socket.write(encodeFrame(message))
      },
    })
    connections.add(conn)

    socket.on('data', (chunk: Buffer) => {
      let messages
      try {
        messages = decoder.push(chunk)
      } catch (err) {
        logError('framing error — dropping connection', err)
        socket.destroy()
        return
      }
      for (const m of messages) void conn.handle(m).catch((err) => logError('handle failed', err))
    })
    const cleanup = () => {
      connections.delete(conn)
      sockets.delete(socket)
    }
    socket.on('close', cleanup)
    socket.on('error', (err) => {
      logError('socket error', err)
      cleanup()
    })
  })

  // The unix-socket bind is the ATOMIC single-instance arbiter: two daemons
  // racing to listen on the same path — even past the lock — cannot both win,
  // the second gets EADDRINUSE. On EADDRINUSE we distinguish a live daemon
  // (reuse) from a stale socket left by a crash (unlink once and rebind).
  return new Promise<DaemonServer>((resolve, reject) => {
    let triedStaleCleanup = false
    const onListening = () => {
      server.removeListener('error', onError)
      resolve({
        connections,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    }
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' || triedStaleCleanup) {
        reject(err)
        return
      }
      triedStaleCleanup = true
      probeDaemonSocket(deps.socketPath).then((alive) => {
        if (alive) {
          reject(new DaemonAlreadyRunningError(deps.socketPath))
          return
        }
        // Stale socket file (no live listener) — remove it and rebind once.
        try {
          unlinkSync(deps.socketPath)
        } catch (e) {
          logError('failed to unlink stale daemon socket', e)
        }
        server.listen(deps.socketPath, onListening)
      })
    }
    server.on('error', onError)
    server.listen(deps.socketPath, onListening)
  })
}
