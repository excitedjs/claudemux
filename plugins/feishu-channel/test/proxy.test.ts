import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { startDaemonServer, type DaemonServer } from '../src/daemon-server'
import { startProxy, type ProxyHandle, type ProxyMcpServer } from '../src/proxy'
import { CHANNEL_TOOLS, channelNotification, connectProxyOrSpawnDaemon, stableProxySessionId } from '../src/server'
import { CHANNEL_OWNER_TOOLS } from '../src/channel-owner'

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
      role: 'session',
      mcpServer: mcp.server,
    })
    return { mcp, handleTool }
  }

  test('ListTools returns channel tools plus daemon-local ownership tools', async () => {
    const { mcp } = await boot()
    const list = (await mcp.handlers.get(ListToolsRequestSchema)!({ params: { name: '' } })) as { tools: unknown }
    expect(list.tools).toEqual([...CHANNEL_TOOLS, ...CHANNEL_OWNER_TOOLS])
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

describe('connectProxyOrSpawnDaemon', () => {
  test('spawns the daemon once, then retries the proxy connection until it succeeds', async () => {
    const mcp = fakeMcp()
    const handle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn() } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const startProxyFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket missing'))
      .mockResolvedValueOnce(handle)
    const spawnDaemonProcessFn = vi.fn()
    const sleepFn = vi.fn(async () => {})
    let tick = 0

    const result = await connectProxyOrSpawnDaemon({
      socketPath: '/tmp/feishu.sock',
      mcpServer: mcp.server,
      baseDir: '/tmp/feishu-state',
      startProxyFn,
      spawnDaemonProcessFn,
      sleepFn,
      now: () => 1000 + tick++,
    })

    expect(result).toBe(handle)
    expect(startProxyFn).toHaveBeenCalledTimes(2)
    expect(startProxyFn).toHaveBeenLastCalledWith(
      expect.objectContaining({ socketPath: '/tmp/feishu.sock', role: 'session' }),
    )
    expect(spawnDaemonProcessFn).toHaveBeenCalledTimes(1)
    expect(spawnDaemonProcessFn).toHaveBeenCalledWith('/tmp/feishu-state')
    expect(sleepFn).toHaveBeenCalledWith(100)
  })
})

describe('stableProxySessionId', () => {
  test('is stable across proxy process restarts for the same role and cwd', () => {
    expect(stableProxySessionId('session', '/tmp/repo-a')).toBe(stableProxySessionId('session', '/tmp/repo-a'))
  })

  test('distinguishes dispatcher and teammate roles for the same cwd', () => {
    expect(stableProxySessionId('dispatcher', '/tmp/repo-a')).not.toBe(stableProxySessionId('session', '/tmp/repo-a'))
  })

  test('uses Claude Code session id before cwd so npm --prefix proxy launches stay per-session unique', () => {
    const cwd = '/tmp/shared-plugin-root'
    expect(stableProxySessionId('session', cwd, { CLAUDE_CODE_SESSION_ID: 'claude-session-a' })).toBe(
      stableProxySessionId('session', cwd, { CLAUDE_CODE_SESSION_ID: 'claude-session-a' }),
    )
    expect(stableProxySessionId('session', cwd, { CLAUDE_CODE_SESSION_ID: 'claude-session-a' })).not.toBe(
      stableProxySessionId('session', cwd, { CLAUDE_CODE_SESSION_ID: 'claude-session-b' }),
    )
  })

  test('keeps FEISHU_CHANNEL_SESSION_ID as the explicit override', () => {
    expect(
      stableProxySessionId('session', '/tmp/shared-plugin-root', {
        FEISHU_CHANNEL_SESSION_ID: 'tm-1',
        CLAUDE_CODE_SESSION_ID: 'claude-session-a',
      }),
    ).toBe('session:tm-1')
  })

  test('falls back to CLAUDE_PROJECT_DIR instead of npm --prefix cwd when Claude session id is unavailable', () => {
    const pluginRoot = '/tmp/shared-plugin-root'
    expect(stableProxySessionId('session', pluginRoot, { CLAUDE_PROJECT_DIR: '/tmp/repo-a' })).not.toBe(
      stableProxySessionId('session', pluginRoot, { CLAUDE_PROJECT_DIR: '/tmp/repo-b' }),
    )
  })

  test('uses INIT_CWD as the next fallback for non-Claude hosts', () => {
    const pluginRoot = '/tmp/shared-plugin-root'
    expect(stableProxySessionId('session', pluginRoot, { INIT_CWD: '/tmp/repo-a' })).not.toBe(
      stableProxySessionId('session', pluginRoot, { INIT_CWD: '/tmp/repo-b' }),
    )
  })
})
