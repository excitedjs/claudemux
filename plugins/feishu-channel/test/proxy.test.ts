import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { startDaemonServer, type DaemonServer } from '../src/daemon-server'
import { startProxy, type ProxyHandle, type ProxyMcpServer } from '../src/proxy'
import { CHANNEL_TOOLS, channelNotification } from '../src/server'

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function fakeMcp() {
  const handlers = new Map<unknown, (req: { params: { name: string; arguments?: Record<string, unknown> } }) => unknown>()
  const notifications: Array<{ method: string; params: unknown }> = []
  const server: ProxyMcpServer = {
    setRequestHandler: (schema, h) => handlers.set(schema, h),
    notification: async (n) => { notifications.push(n) },
  }
  return { server, handlers, notifications }
}

describe('thin proxy MCP wiring', () => {
  let socketPath = ''
  let daemon: DaemonServer | null = null
  let proxy: ProxyHandle | null = null
  let n = 0

  beforeEach(() => {
    socketPath = join(tmpdir(), `feishu-proxy-${process.pid}-${n++}.sock`)
  })
  afterEach(async () => {
    proxy?.close()
    await daemon?.close()
    daemon = null
    proxy = null
  })

  async function boot(handleTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ tool: name, args }))) {
    daemon = await startDaemonServer({
      socketPath,
      daemonVersion: '0.2.1',
      generation: 1,
      core: { handleTool },
    })
    const mcp = fakeMcp()
    proxy = await startProxy({
      socketPath,
      sessionId: 's1',
      pid: 1,
      proxyVersion: '0.2.1',
      mcpServer: mcp.server,
    })
    return { mcp, handleTool }
  }

  test('ListTools returns the static channel tool surface', async () => {
    const { mcp } = await boot()
    const list = (await mcp.handlers.get(ListToolsRequestSchema)!({ params: { name: '' } })) as { tools: unknown }
    expect(list.tools).toBe(CHANNEL_TOOLS)
  })

  test('a CallTool forwards through the daemon and returns its result', async () => {
    const { mcp, handleTool } = await boot()
    const result = await mcp.handlers.get(CallToolRequestSchema)!({
      params: { name: 'reply', arguments: { chat_id: 'oc_1', text: 'hi' } },
    })
    expect(result).toEqual({ tool: 'reply', args: { chat_id: 'oc_1', text: 'hi' } })
    expect(handleTool).toHaveBeenCalledWith('reply', { chat_id: 'oc_1', text: 'hi' })
  })

  test('a daemon delivery becomes a channel notification', async () => {
    const { mcp } = await boot()
    await waitFor(() => daemon!.connections.size === 1)
    const conn = [...daemon!.connections][0]!
    conn.deliver('evt_1', '# done', { message_id: 'om_9' })
    await waitFor(() => mcp.notifications.length === 1)
    expect(mcp.notifications[0]).toEqual(channelNotification('# done', { message_id: 'om_9' }))
  })
})
