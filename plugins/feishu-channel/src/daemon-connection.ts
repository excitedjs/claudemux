/**
 * Daemon side of one proxy connection (claudemux#10 daemon refactor, slice-1).
 *
 * The standing daemon owns the single Feishu connection and the channel core;
 * each connected proxy gets one of these handlers. It is decoupled from the
 * socket: `send` writes a framed message to this proxy, and `handle` consumes
 * the proxy's messages. That keeps the protocol behavior unit-testable over an
 * in-memory pipe, with the OS socket/lifecycle a thin wrapper added separately.
 */

import type { DaemonToProxy, ProxyToDaemon } from './ipc'
import type { OwnershipToolResult } from './channel-owner'

/** The slice of the channel core the daemon needs to run a forwarded tool call. */
export interface DaemonCore {
  handleTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

export interface DaemonConnectionDeps {
  /** Daemon's own version, advertised in the `hello` greeting. */
  daemonVersion: string
  /** Daemon process id, advertised for diagnostics and future direct handoff paths. */
  daemonPid?: number
  /** Current active generation, advertised in `hello` (see #10 handoff spec). */
  generation: number
  /** Runs a forwarded MCP tool call. */
  core: DaemonCore
  /** Write one message to this proxy (the framed socket write). */
  send(message: DaemonToProxy): void
  /** Called when this proxy ACKs a delivery — slice-2 marks the row delivered. */
  onAck?(eventId: string): void
  /** Called after this proxy registers; slice-2 replays pending durable rows. */
  onRegister?(conn: DaemonConnection): void
  /** Handles daemon-local channel ownership tools before forwarding to core. */
  handleOwnershipTool?(
    conn: DaemonConnection,
    name: string,
    args: Record<string, unknown>,
  ): Promise<OwnershipToolResult>
  /** Records a recoverable error (defaults to stderr). */
  logError?(message: string, err?: unknown): void
}

export interface RegisteredSession {
  sessionId: string
  pid: number
  proxyVersion: string
  role: 'dispatcher' | 'session'
  /**
   * Source-specific identity the proxy self-reported at `register`, surfaced
   * verbatim in `feishu_channel_status` so a coordinator can locate the session
   * by a readable key (e.g. `teammate_name`). Opaque to the channel core.
   */
  metadata: Record<string, string>
}

export interface DaemonConnection {
  /** Consume one message from this proxy. */
  handle(message: ProxyToDaemon): Promise<void>
  /** Push a gated inbound event to this proxy as a `deliver`. */
  deliver(eventId: string, content: string, meta: Record<string, string>): void
  /** The session this proxy registered, once `register` has arrived. */
  readonly session: RegisteredSession | null
}

export function createDaemonConnection(deps: DaemonConnectionDeps): DaemonConnection {
  const logError = deps.logError ?? ((m, e) => console.error(`[daemon] ${m}`, e ?? ''))
  let session: RegisteredSession | null = null

  // Greet immediately so a newer proxy can detect a daemon it must upgrade past.
  deps.send({
    t: 'hello',
    daemonVersion: deps.daemonVersion,
    generation: deps.generation,
    ...(deps.daemonPid !== undefined ? { pid: deps.daemonPid } : {}),
  })

  const conn: DaemonConnection = {
    get session() {
      return session
    },

    deliver(eventId, content, meta) {
      deps.send({ t: 'deliver', eventId, content, meta })
    },

    async handle(message) {
      switch (message.t) {
        case 'register':
          session = {
            sessionId: message.sessionId,
            pid: message.pid,
            proxyVersion: message.proxyVersion,
            role: message.role,
            metadata: message.metadata ?? {},
          }
          deps.onRegister?.(conn)
          return
        case 'ack':
          deps.onAck?.(message.eventId)
          return
        case 'tool': {
          try {
            const ownership = await deps.handleOwnershipTool?.(conn, message.name, message.args)
            if (ownership?.handled) {
              deps.send({ t: 'tool_result', id: message.id, ok: true, result: ownership.result })
              return
            }
            const result = await deps.core.handleTool(message.name, message.args)
            deps.send({ t: 'tool_result', id: message.id, ok: true, result })
          } catch (err) {
            logError(`tool '${message.name}' failed`, err)
            deps.send({
              t: 'tool_result',
              id: message.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          return
        }
        default: {
          // Exhaustiveness guard: a new ProxyToDaemon variant must be handled.
          const _never: never = message
          logError(`unhandled proxy message`, _never)
        }
      }
    },
  }
  return conn
}
