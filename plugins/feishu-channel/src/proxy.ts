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
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import { connectToDaemon, type ProxyConnection } from './proxy-transport'
import { CHANNEL_TOOLS, channelNotification } from './server'
import { CHANNEL_OWNER_TOOLS } from './channel-owner'
import { DOCTOR_TOOL, DOCTOR_TOOL_NAME } from './doctor'
import { comparePluginVersions } from './version'

/** The slice of the MCP `Server` the proxy drives (lets tests inject a fake). */
export interface ProxyMcpServer {
  setRequestHandler(
    schema: typeof ListToolsRequestSchema | typeof CallToolRequestSchema,
    handler: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => unknown,
  ): void
  notification(notification: { method: string; params: unknown }): Promise<void>
}

/** A local handler for `feishu_channel_doctor`; spawns nothing and forwards nothing. */
export type DoctorRunner = (verbose: boolean) => Promise<CallToolResult>

/** The static tool surface a proxy advertises, optionally including the doctor. */
export function proxyTools(includeDoctor: boolean): Tool[] {
  return [...CHANNEL_TOOLS, ...CHANNEL_OWNER_TOOLS, ...(includeDoctor ? [DOCTOR_TOOL] : [])]
}

/** The lifecycle steps of a proxy session, injected so the ordering is testable. */
export interface ProxySessionDeps {
  /** Install the bootstrap tool surface (exposes the local doctor immediately). */
  installBootstrap: () => void
  /** Connect the MCP stdio transport. */
  connectStdio: () => Promise<void>
  /**
   * Attach to (or spawn) the daemon for normal delivery. This is the proxy's
   * standard startup behavior and spawns a daemon when one is missing — product
   * behavior, independent of the local, spawn-free doctor handler.
   */
  attach: () => Promise<ProxyHandle>
  /** Called once the daemon attach succeeds (e.g. to register cleanup). */
  onAttached: (proxy: ProxyHandle) => void
  /** Called when the daemon attach fails; the session stays up on the bootstrap surface. */
  onAttachError: (err: unknown) => void
}

/**
 * Run a proxy session in the order that keeps `feishu_channel_doctor` reachable:
 * install the bootstrap tool surface and connect stdio FIRST, then attach to the
 * daemon in the BACKGROUND. The doctor (handled locally in the bootstrap) is thus
 * callable the instant stdio is up — even if the daemon never attaches — and the
 * attach failing does not fail the session. The attach itself is the normal
 * delivery path and may spawn a daemon; that is intended proxy behavior, not the
 * doctor's doing. (For a no-spawn, no-disturbance diagnosis of a daemon-missing
 * or stale-socket scene, the `npm run doctor` CLI is the entry — it registers no
 * proxy.)
 */
export async function startProxySession(deps: ProxySessionDeps): Promise<void> {
  deps.installBootstrap()
  await deps.connectStdio()
  void deps.attach().then(deps.onAttached).catch(deps.onAttachError)
}

/**
 * Expose the tool surface BEFORE a daemon connection exists, so
 * `feishu_channel_doctor` is reachable even when the daemon is unreachable —
 * and that diagnosis path spawns no daemon (the doctor is handled locally).
 * Forwarded tools report that the daemon is still connecting; `startProxy`
 * replaces these handlers with the live forwarding set once it attaches.
 */
export function installDoctorBootstrap(mcpServer: ProxyMcpServer, runDoctor: DoctorRunner): void {
  mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({ tools: proxyTools(true) }))
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === DOCTOR_TOOL_NAME) {
      return (await runDoctor(request.params.arguments?.verbose === true)) as CallToolResult
    }
    return {
      content: [{ type: 'text', text: 'Feishu daemon is connecting; retry shortly.' }],
      isError: true,
    } as CallToolResult
  })
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
  /**
   * Run the local `feishu_channel_doctor` diagnosis. Provided, the proxy
   * exposes the doctor tool and handles it in-process — read-only, never
   * forwarded to the daemon (the daemon may be the stale subject) and never
   * spawning anything. Omitted, the tool is not advertised.
   */
  runDoctor?(verbose: boolean): Promise<CallToolResult>
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
  // against the real transport and returns the CallToolResult. The one
  // exception is the doctor: it is handled locally so it can diagnose a stale
  // or unreachable daemon instead of being forwarded to the subject.
  const runDoctor = deps.runDoctor
  deps.mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: proxyTools(runDoctor !== undefined),
  }))
  deps.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (runDoctor && request.params.name === DOCTOR_TOOL_NAME) {
      return (await runDoctor(request.params.arguments?.verbose === true)) as CallToolResult
    }
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
