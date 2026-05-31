import { describe, expect, test, vi } from 'vitest'

import { ChannelOwnerState } from '../src/channel-owner'
import type { DaemonConnection, RegisteredSession } from '../src/daemon-connection'

function fakeConn(session: RegisteredSession): DaemonConnection {
  return {
    session,
    deliver: vi.fn(),
    handle: async () => {},
  }
}

const session = (
  sessionId: string,
  role: RegisteredSession['role'],
): RegisteredSession => ({ sessionId, pid: 1, proxyVersion: '0', role })

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '')
}

describe('ChannelOwnerState', () => {
  test('dispatcher is the default owner on registration', () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    owner.register(tm)
    owner.register(dispatcher)

    expect(owner.select(new Set([tm, dispatcher]))).toBe(dispatcher)
  })

  test('a teammate can acquire the channel and then return it to dispatcher', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const acquired = await owner.handleTool(tm, 'feishu_channel_acquire', {}, conns)
    expect(acquired.handled).toBe(true)
    if (acquired.handled) expect(text(acquired.result)).toContain('tm-1')
    expect(owner.select(conns)).toBe(tm)

    const returned = await owner.handleTool(tm, 'feishu_channel_return_to_dispatcher', {}, conns)
    expect(returned.handled).toBe(true)
    if (returned.handled) expect(text(returned.result)).toContain('dispatcher-1')
    expect(owner.select(conns)).toBe(dispatcher)
  })

  test('dispatcher can assign ownership to a live teammate session', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    await owner.handleTool(dispatcher, 'feishu_channel_acquire', { session_id: 'tm-1' }, conns)

    expect(owner.select(conns)).toBe(tm)
  })

  test('ordinary sessions cannot assign ownership to another session', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tmA = fakeConn(session('tm-a', 'session'))
    const tmB = fakeConn(session('tm-b', 'session'))
    const conns = new Set([dispatcher, tmA, tmB])
    owner.register(dispatcher)

    const result = await owner.handleTool(tmA, 'feishu_channel_acquire', { session_id: 'tm-b' }, conns)

    expect(result.handled).toBe(true)
    if (result.handled) expect(result.result.isError).toBe(true)
    expect(owner.select(conns)).toBe(dispatcher)
  })

  test('leaves inbound pending when the selected teammate is no longer connected', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    owner.register(dispatcher)
    await owner.handleTool(tm, 'feishu_channel_acquire', {}, new Set([dispatcher, tm]))

    expect(owner.select(new Set([dispatcher]))).toBeNull()
  })

  test('dispatcher can reclaim ownership from a dead teammate session', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    owner.register(dispatcher)
    await owner.handleTool(tm, 'feishu_channel_acquire', {}, new Set([dispatcher, tm]))

    const reclaimed = await owner.handleTool(dispatcher, 'feishu_channel_reclaim', {}, new Set([dispatcher]))

    expect(reclaimed.handled).toBe(true)
    if (reclaimed.handled) expect(text(reclaimed.result)).toContain('reclaimed')
    expect(owner.select(new Set([dispatcher]))).toBe(dispatcher)
  })

  test('ordinary sessions cannot reclaim ownership for dispatcher', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tmA = fakeConn(session('tm-a', 'session'))
    const tmB = fakeConn(session('tm-b', 'session'))
    owner.register(dispatcher)
    await owner.handleTool(tmA, 'feishu_channel_acquire', {}, new Set([dispatcher, tmA, tmB]))

    const result = await owner.handleTool(tmB, 'feishu_channel_reclaim', {}, new Set([dispatcher, tmB]))

    expect(result.handled).toBe(true)
    if (result.handled) expect(result.result.isError).toBe(true)
    expect(owner.select(new Set([dispatcher, tmB]))).toBeNull()
  })

  test('status exposes the ownership lease epoch', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    owner.register(dispatcher)
    await owner.handleTool(tm, 'feishu_channel_acquire', {}, new Set([dispatcher, tm]))

    const status = await owner.handleTool(dispatcher, 'feishu_channel_status', {}, new Set([dispatcher, tm]))

    expect(status.handled).toBe(true)
    if (status.handled) expect(text(status.result)).toContain('"lease_epoch": 2')
  })
})
