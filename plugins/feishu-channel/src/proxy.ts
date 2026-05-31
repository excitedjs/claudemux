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
  /** The MCP server to wire (real `createMcpServer()` or a test fake). */
  mcpServer: ProxyMcpServer
  logError?(message: string, err?: unknown): void
}

export interface ProxyHandle {
  readonly connection: ProxyConnection
  close(): void
}

export async function startProxy(deps: StartProxyDeps): Promise<ProxyHandle> {
  // Connect to the daemon first; a delivered event becomes a channel
  // notification. The proxy ACKs (inside connectToDaemon) only after this
  // notification resolves — the end-to-end delivered signal.
  const connection = await connectToDaemon({
    socketPath: deps.socketPath,
    sessionId: deps.sessionId,
    pid: deps.pid,
    proxyVersion: deps.proxyVersion,
    role: deps.role,
    logError: deps.logError,
    deliverToClaude: async (content, meta) => {
      await deps.mcpServer.notification(channelNotification(content, meta))
    },
  })

  // Tool surface is static; forward each call to the daemon, which runs it
  // against the real transport and returns the CallToolResult.
  deps.mcpServer.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...CHANNEL_TOOLS, ...CHANNEL_OWNER_TOOLS],
  }))
  deps.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await connection.client.callTool(request.params.name, request.params.arguments ?? {})
    return result as CallToolResult
  })

  return {
    connection,
    close: () => connection.close(),
  }
}
