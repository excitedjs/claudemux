import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { startDaemonServer, type DaemonServer } from '../src/daemon-server'
import { startProxy, type ProxyHandle, type ProxyMcpServer } from '../src/proxy'
import {
  CHANNEL_TOOLS,
  channelNotification,
  claudemuxIdentityFromEnv,
  connectProxyOrSpawnDaemon,
  deriveProxyMetadata,
  stableProxySessionId,
} from '../src/server'
import { CHANNEL_OWNER_TOOLS } from '../src/channel-owner'
import type { ProxyConnection, ProxyConnectionDeps } from '../src/proxy-transport'

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

  test('keeps the MCP surface alive and reconnects after an established daemon closes', async () => {
    const mcp = fakeMcp()
    const closeCallbacks: Array<() => void> = []
    let generation = 0
    const connectToDaemonFn = vi.fn(async (deps: ProxyConnectionDeps) => {
      closeCallbacks.push(deps.onClose!)
      generation += 1
      return {
        client: {
          daemon: { daemonVersion: '0.2.1', generation },
          callTool: vi.fn(async () => ({ generation })),
        },
        close: vi.fn(),
      } as unknown as ProxyConnection
    })

    proxy = await startProxy({
      socketPath,
      sessionId: 's1',
      pid: 1,
      proxyVersion: '0.2.1',
      role: 'session',
      mcpServer: mcp.server,
      connectToDaemonFn,
      reconnectDelayMs: 1,
    })

    await expect(
      mcp.handlers.get(CallToolRequestSchema)!({ params: { name: 'reply', arguments: {} } }),
    ).resolves.toEqual({ generation: 1 })

    closeCallbacks[0]!()
    await waitFor(() => {
      try {
        return proxy!.connection.client.daemon?.generation === 2
      } catch {
        return false
      }
    })

    await expect(
      mcp.handlers.get(CallToolRequestSchema)!({ params: { name: 'reply', arguments: {} } }),
    ).resolves.toEqual({ generation: 2 })
  })

  test('mid-session reconnect rejects older daemons without spawning a replacement', async () => {
    const mcp = fakeMcp()
    const closeCallbacks: Array<() => void> = []
    const connectionCloses: Array<ReturnType<typeof vi.fn>> = []
    const onDaemonMissing = vi.fn()
    let attempt = 0
    const connectToDaemonFn = vi.fn(async (deps: ProxyConnectionDeps) => {
      closeCallbacks.push(deps.onClose!)
      attempt += 1
      const close = vi.fn()
      connectionCloses.push(close)
      return {
        client: {
          daemon: { daemonVersion: attempt === 1 ? '0.2.1' : '0.1.0', generation: attempt },
          callTool: vi.fn(async () => ({})),
        },
        close,
      } as unknown as ProxyConnection
    })

    proxy = await startProxy({
      socketPath,
      sessionId: 's1',
      pid: 1,
      proxyVersion: '0.2.1',
      role: 'session',
      mcpServer: mcp.server,
      connectToDaemonFn,
      onDaemonMissing,
      reconnectDelayMs: 1,
    })

    closeCallbacks[0]!()
    await waitFor(() => connectToDaemonFn.mock.calls.length >= 2)
    proxy.close()

    expect(connectionCloses[1]).toHaveBeenCalledTimes(1)
    expect(onDaemonMissing).not.toHaveBeenCalled()
  })
})

describe('connectProxyOrSpawnDaemon', () => {
  test('spawns the daemon once, then retries the proxy connection until it succeeds', async () => {
    const mcp = fakeMcp()
    const handle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.4.0' } } },
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
      expect.objectContaining({ socketPath: '/tmp/feishu.sock' }),
    )
    expect(spawnDaemonProcessFn).toHaveBeenCalledTimes(1)
    expect(spawnDaemonProcessFn).toHaveBeenCalledWith('/tmp/feishu-state')
    expect(sleepFn).toHaveBeenCalledWith(100)
  })

  test('spawns a replacement daemon when the connected daemon is older', async () => {
    const mcp = fakeMcp()
    const oldHandle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.1.0' } } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const newHandle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.4.0' } } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const startProxyFn = vi.fn().mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(newHandle)
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

    expect(result).toBe(newHandle)
    expect(oldHandle.close).toHaveBeenCalledTimes(1)
    expect(spawnDaemonProcessFn).toHaveBeenCalledTimes(1)
    expect(startProxyFn).toHaveBeenCalledTimes(2)
  })

  test('falls back to the old daemon when replacement does not finish before timeout', async () => {
    const mcp = fakeMcp()
    const oldHandle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.1.0' } } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const fallbackHandle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.1.0' } } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const startProxyFn = vi.fn().mockResolvedValueOnce(oldHandle).mockResolvedValueOnce(fallbackHandle)
    const spawnDaemonProcessFn = vi.fn()
    const sleepFn = vi.fn(async () => {})
    let calls = 0

    const result = await connectProxyOrSpawnDaemon({
      socketPath: '/tmp/feishu.sock',
      mcpServer: mcp.server,
      baseDir: '/tmp/feishu-state',
      startProxyFn,
      spawnDaemonProcessFn,
      sleepFn,
      now: () => (calls++ < 2 ? 1000 : 20_000),
    })

    expect(result).toBe(fallbackHandle)
    expect(spawnDaemonProcessFn).toHaveBeenCalledTimes(1)
  })

  test('closes a proxy handle if it disconnects before startup version inspection', async () => {
    const mcp = fakeMcp()
    const orphanClose = vi.fn()
    const orphanHandle = {
      get connection() {
        throw new Error('connection dropped')
      },
      close: orphanClose,
    } as unknown as ProxyHandle
    const goodHandle = {
      connection: { close: vi.fn(), client: { callTool: vi.fn(), daemon: { daemonVersion: '0.4.0' } } },
      close: vi.fn(),
    } as unknown as ProxyHandle
    const startProxyFn = vi.fn().mockResolvedValueOnce(orphanHandle).mockResolvedValueOnce(goodHandle)
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

    expect(result).toBe(goodHandle)
    expect(orphanClose).toHaveBeenCalledTimes(1)
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

describe('deriveProxyMetadata', () => {
  test('reports the claudemux teammate name and project cwd', () => {
    const meta = deriveProxyMetadata({
      CLAUDEMUX_TEAMMATE_NAME: 'api-worker',
      CLAUDE_PROJECT_DIR: '/nonexistent-ws/api',
    })
    expect(meta).toEqual({ teammate_name: 'api-worker', cwd: '/nonexistent-ws/api' })
  })

  test('omits teammate_name for a session without the claudemux env (e.g. the dispatcher)', () => {
    const meta = deriveProxyMetadata({ CLAUDE_PROJECT_DIR: '/nonexistent-ws' })
    expect(meta).toEqual({ cwd: '/nonexistent-ws' })
  })

  test('prefers CLAUDE_PROJECT_DIR over INIT_CWD and never uses process.cwd', () => {
    const meta = deriveProxyMetadata({
      CLAUDE_PROJECT_DIR: '/nonexistent-ws/project',
      INIT_CWD: '/nonexistent-ws/npm',
    })
    expect(meta.cwd).toBe('/nonexistent-ws/project')
  })

  test('is an empty bag when no identity env is present', () => {
    expect(deriveProxyMetadata({})).toEqual({})
  })

  test('an empty CLAUDE_PROJECT_DIR falls back to INIT_CWD instead of suppressing cwd', () => {
    expect(deriveProxyMetadata({ CLAUDE_PROJECT_DIR: '', INIT_CWD: '/nonexistent-ws/npm' })).toEqual({
      cwd: '/nonexistent-ws/npm',
    })
  })

  test('an empty CLAUDE_PROJECT_DIR with no INIT_CWD emits no cwd', () => {
    expect(deriveProxyMetadata({ CLAUDE_PROJECT_DIR: '' })).toEqual({})
  })

  test('rejects a malformed teammate name', () => {
    expect(claudemuxIdentityFromEnv({ CLAUDEMUX_TEAMMATE_NAME: 'bad name/with spaces' })).toEqual({})
    expect(claudemuxIdentityFromEnv({ CLAUDEMUX_TEAMMATE_NAME: 'ok-name_1' })).toEqual({
      teammate_name: 'ok-name_1',
    })
  })
})
