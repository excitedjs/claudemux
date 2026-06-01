/**
 * Thin stdio proxy (claudemux#10, slice-1 OS layer).
 *
 * What a Claude Code session loads instead of opening its own Feishu connection:
 * a tiny MCP server whose tool calls forward to the standing daemon and whose
 * `<channel>` notifications are fed by the daemon's `deliver` messages. It holds
 * NO Feishu connection and NO lock — only the daemon socket. The Claude-facing
 * stdio never drops, so the daemon can restart/upgrade behind it (the #10
 * reason for a proxy over a direct HTTP daemon).
 *
 * The MCP server is injected (the real entrypoint passes `createMcpServer()` +
 * a `StdioServerTransport`), so the wiring is testable with a captured server.
 */

import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { connectToDaemon, type ProxyConnection } from './proxy-transport'
import { CHANNEL_TOOLS, channelNotification } from './server'
import { CHANNEL_OWNER_TOOLS } from './channel-owner'
import { comparePluginVersions } from './version'

/** The slice of the MCP `Server` the proxy drives (lets tests inject a fake). */
export interface ProxyMcpServer {
  setRequestHandler(
    schema: typeof ListToolsRequestSchema | typeof CallToolRequestSchema,
    handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => unknown,
  ): void
  notification(notification: { method: string; params: unknown }): Promise<void>
}

export interface StartProxyDeps {
  socketPath: string
  sessionId: string
  pid: number
  proxyVersion: string
  role: 'dispatcher' | 'session'
  /** Source-specific identity to self-report at `register` (opaque to the daemon). */
  metadata?: Record<string, string>
  /** The MCP server to wire (real `createMcpServer()` or a test fake). */
  mcpServer: ProxyMcpServer
  connectToDaemonFn?: typeof connectToDaemon
  onDaemonMissing?(): void
  reconnectDelayMs?: number
  logError?(message: string, err?: unknown): void
}

export interface ProxyHandle {
  readonly connection: ProxyConnection
  close(): void
}

export async function startProxy(deps: StartProxyDeps): Promise<ProxyHandle> {
  const manager = new ProxyDaemonConnectionManager({
    socketPath: deps.socketPath,
    sessionId: deps.sessionId,
    pid: deps.pid,
    proxyVersion: deps.proxyVersion,
    role: deps.role,
    metadata: deps.metadata,
    connectToDaemonFn: deps.connectToDaemonFn,
    onDaemonMissing: deps.onDaemonMissing,
    reconnectDelayMs: deps.reconnectDelayMs,
    logError: deps.logError,
    deliverToClaude: async (content, meta) => {
      await deps.mcpServer.notification(channelNotification(content, meta))
    },
  })
  // Connect to the daemon before exposing the MCP tool surface. The proxy ACKs
  // (inside connectToDaemon) only after a delivered notification resolves — the
  // end-to-end delivered signal.
  await manager.start()

  // Tool surface is static; forward each call to the daemon, which runs it
  // against the real transport and returns the CallToolResult.
  deps.mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...CHANNEL_TOOLS, ...CHANNEL_OWNER_TOOLS],
  }))
  deps.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await manager.callTool(request.params.name, request.params.arguments ?? {})
    return result as CallToolResult
  })

  return {
    get connection() {
      const connection = manager.connection
      if (!connection) throw new Error('Feishu daemon proxy is not connected')
      return connection
    },
    close: () => manager.close(),
  }
}

interface ProxyDaemonConnectionManagerDeps {
  socketPath: string
  sessionId: string
  pid: number
  proxyVersion: string
  role: 'dispatcher' | 'session'
  metadata?: Record<string, string>
  connectToDaemonFn?: typeof connectToDaemon
  onDaemonMissing?(): void
  reconnectDelayMs?: number
  deliverToClaude(content: string, meta: Record<string, string>): Promise<void>
  logError?(message: string, err?: unknown): void
}

const DEFAULT_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 5_000

class ProxyDaemonConnectionManager {
  #connection: ProxyConnection | null = null
  #closed = false
  #reconnecting: Promise<void> | null = null
  #spawnedForCurrentLoop = false
  readonly #deps: Required<Pick<ProxyDaemonConnectionManagerDeps, 'connectToDaemonFn' | 'reconnectDelayMs'>> &
    Omit<ProxyDaemonConnectionManagerDeps, 'connectToDaemonFn' | 'reconnectDelayMs'>

  constructor(deps: ProxyDaemonConnectionManagerDeps) {
    this.#deps = {
      ...deps,
      connectToDaemonFn: deps.connectToDaemonFn ?? connectToDaemon,
      reconnectDelayMs: deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    }
  }

  get connection(): ProxyConnection | null {
    return this.#connection
  }

  async start(): Promise<void> {
    this.#connection = await this.#connectOnce({ enforceMinimumVersion: false })
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = this.#connection
    if (!connection) {
      throw new Error('Feishu daemon is reconnecting; retry shortly')
    }
    return connection.client.callTool(name, args)
  }

  close(): void {
    this.#closed = true
    this.#connection?.close()
    this.#connection = null
  }

  #onClose(connection: ProxyConnection): void {
    if (this.#connection !== connection || this.#closed) return
    this.#connection = null
    void this.#ensureReconnected()
  }

  async #ensureReconnected(): Promise<void> {
    if (!this.#reconnecting) {
      this.#spawnedForCurrentLoop = false
      this.#reconnecting = this
        .#connectLoop({ enforceMinimumVersion: true })
        .finally(() => {
          this.#reconnecting = null
        })
    }
    return this.#reconnecting
  }

  async #connectLoop(opts: { enforceMinimumVersion: boolean }): Promise<void> {
    let delayMs = this.#deps.reconnectDelayMs
    while (!this.#closed) {
      try {
        const connection = await this.#connectOnce(opts)
        this.#connection = connection
        this.#spawnedForCurrentLoop = false
        return
      } catch (err) {
        if (this.#closed) return
        this.#deps.logError?.('failed to connect to Feishu daemon; retrying', err)
        if (!(err instanceof OlderDaemonError) && !this.#spawnedForCurrentLoop) {
          try {
            this.#deps.onDaemonMissing?.()
          } catch (spawnErr) {
            this.#deps.logError?.('failed to start replacement Feishu daemon', spawnErr)
          }
          this.#spawnedForCurrentLoop = true
        }
        await sleep(delayMs)
        delayMs = Math.min(delayMs * 2, MAX_RECONNECT_DELAY_MS)
      }
    }
  }

  async #connectOnce(opts: { enforceMinimumVersion: boolean }): Promise<ProxyConnection> {
    let connection!: ProxyConnection
    connection = await this.#deps.connectToDaemonFn({
      socketPath: this.#deps.socketPath,
      sessionId: this.#deps.sessionId,
      pid: this.#deps.pid,
      proxyVersion: this.#deps.proxyVersion,
      role: this.#deps.role,
      metadata: this.#deps.metadata,
      deliverToClaude: this.#deps.deliverToClaude,
      logError: this.#deps.logError,
      onClose: () => this.#onClose(connection),
    })
    const daemon = connection.client.daemon
    if (
      opts.enforceMinimumVersion &&
      daemon &&
      comparePluginVersions(daemon.daemonVersion, this.#deps.proxyVersion) < 0
    ) {
      connection.close()
      throw new OlderDaemonError(
        `connected daemon ${daemon.daemonVersion} is older than proxy ${this.#deps.proxyVersion}`,
      )
    }
    return connection
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class OlderDaemonError extends Error {}
