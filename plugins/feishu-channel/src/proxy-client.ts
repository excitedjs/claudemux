/**
 * Proxy side of the daemon connection (claudemux#10 daemon refactor, slice-1).
 *
 * The thin stdio proxy holds no Feishu connection and no lock; it forwards MCP
 * tool calls to the daemon and renders the daemon's `deliver` messages to Claude
 * as `<channel>` notifications. Decoupled from the socket (`send` writes to the
 * daemon) and from MCP (`deliverToClaude` performs the actual notification
 * write), so the protocol behavior is unit-testable.
 *
 * Delivery is end-to-end ACKed: the proxy only sends `ack` AFTER
 * `deliverToClaude` resolves (the channel notification hit the MCP transport),
 * which is the signal the daemon needs before it may mark a row delivered —
 * the fix for the #10 fire-and-forget loss.
 */

import type { DaemonToProxy, ProxyToDaemon } from './ipc.js'

export interface ProxyClientDeps {
  /** Identity sent in `register`. */
  sessionId: string
  pid: number
  proxyVersion: string
  /** Write one message to the daemon (the framed socket write). */
  send(message: ProxyToDaemon): void
  /**
   * Push a delivered event to the Claude session (the MCP notification write).
   * Must resolve only once the notification has hit the transport; the proxy
   * ACKs the daemon afterwards.
   */
  deliverToClaude(content: string, meta: Record<string, string>): Promise<void>
  /** Records a recoverable error (defaults to stderr). */
  logError?(message: string, err?: unknown): void
}

export interface ProxyClient {
  /** Send `register`; call once on connect. */
  register(): void
  /** Forward an MCP tool call to the daemon; resolves with the daemon's result. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Consume one message from the daemon. */
  handle(message: DaemonToProxy): Promise<void>
  /** Daemon identity from `hello`, once received. */
  readonly daemon: { daemonVersion: string; generation: number } | null
}

export function createProxyClient(deps: ProxyClientDeps): ProxyClient {
  const logError = deps.logError ?? ((m, e) => console.error(`[proxy] ${m}`, e ?? ''))
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  let nextId = 1
  let daemon: { daemonVersion: string; generation: number } | null = null

  return {
    get daemon() {
      return daemon
    },

    register() {
      deps.send({
        t: 'register',
        sessionId: deps.sessionId,
        pid: deps.pid,
        proxyVersion: deps.proxyVersion,
      })
    },

    callTool(name, args) {
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        deps.send({ t: 'tool', id, name, args })
      })
    },

    async handle(message) {
      switch (message.t) {
        case 'hello':
          daemon = { daemonVersion: message.daemonVersion, generation: message.generation }
          return
        case 'deliver':
          // Write to Claude first; only ACK once the transport accepted it.
          try {
            await deps.deliverToClaude(message.content, message.meta)
            deps.send({ t: 'ack', eventId: message.eventId })
          } catch (err) {
            // No ACK on failure — the row stays undelivered and is retried,
            // preserving the no-loss guarantee at the cost of a possible
            // at-least-once duplicate (the conscious #10 edge trade-off).
            logError(`failed to deliver event ${message.eventId} to Claude`, err)
          }
          return
        case 'tool_result': {
          const waiter = pending.get(message.id)
          if (!waiter) {
            logError(`tool_result for unknown id ${message.id}`)
            return
          }
          pending.delete(message.id)
          if (message.ok) waiter.resolve(message.result)
          else waiter.reject(new Error(message.error))
          return
        }
        default: {
          const _never: never = message
          logError(`unhandled daemon message`, _never)
        }
      }
    },
  }
}
