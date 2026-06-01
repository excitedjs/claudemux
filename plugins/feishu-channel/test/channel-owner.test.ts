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
  metadata: Record<string, string> = {},
): RegisteredSession => ({ sessionId, pid: 1, proxyVersion: '0', role, metadata })

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

  test('a teammate can acquire a dispatcher grant and then return it to dispatcher', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const granted = await owner.handleTool(dispatcher, 'feishu_channel_grant', { session_id: 'tm-1' }, conns)
    expect(granted.handled).toBe(true)
    if (granted.handled) expect(text(granted.result)).toContain('tm-1')

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

  test('ordinary sessions cannot acquire without a dispatcher grant', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const result = await owner.handleTool(tm, 'feishu_channel_acquire', {}, conns)

    expect(result.handled).toBe(true)
    if (result.handled) expect(result.result.isError).toBe(true)
    expect(owner.select(conns)).toBe(dispatcher)
  })

  test('ordinary sessions cannot grant ownership', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tmA = fakeConn(session('tm-a', 'session'))
    const tmB = fakeConn(session('tm-b', 'session'))
    const conns = new Set([dispatcher, tmA, tmB])
    owner.register(dispatcher)

    const result = await owner.handleTool(tmA, 'feishu_channel_grant', { session_id: 'tm-b' }, conns)

    expect(result.handled).toBe(true)
    if (result.handled) expect(result.result.isError).toBe(true)
    expect(owner.select(conns)).toBe(dispatcher)
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
    await owner.handleTool(dispatcher, 'feishu_channel_acquire', { session_id: 'tm-1' }, new Set([dispatcher, tm]))

    expect(owner.select(new Set([dispatcher]))).toBeNull()
  })

  test('dispatcher can reclaim ownership from a dead teammate session', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session'))
    owner.register(dispatcher)
    await owner.handleTool(dispatcher, 'feishu_channel_acquire', { session_id: 'tm-1' }, new Set([dispatcher, tm]))

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
    await owner.handleTool(dispatcher, 'feishu_channel_acquire', { session_id: 'tm-a' }, new Set([dispatcher, tmA, tmB]))

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
    await owner.handleTool(dispatcher, 'feishu_channel_acquire', { session_id: 'tm-1' }, new Set([dispatcher, tm]))

    const status = await owner.handleTool(dispatcher, 'feishu_channel_status', {}, new Set([dispatcher, tm]))

    expect(status.handled).toBe(true)
    if (status.handled) expect(text(status.result)).toContain('"lease_epoch": 2')
  })

  test('status surfaces each session metadata verbatim', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher', { cwd: '/ws' }))
    const tm = fakeConn(session('tm-1', 'session', { cwd: '/ws/api', teammate_name: 'api-worker' }))
    owner.register(dispatcher)

    const status = await owner.handleTool(dispatcher, 'feishu_channel_status', {}, new Set([dispatcher, tm]))

    expect(status.handled).toBe(true)
    if (status.handled) {
      expect(text(status.result)).toContain('"teammate_name": "api-worker"')
      expect(text(status.result)).toContain('"cwd": "/ws/api"')
    }
  })

  test('dispatcher assigns ownership by metadata match', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session', { teammate_name: 'api-worker' }))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const result = await owner.handleTool(
      dispatcher,
      'feishu_channel_acquire',
      { match: { teammate_name: 'api-worker' } },
      conns,
    )

    expect(result.handled).toBe(true)
    if (result.handled) expect(text(result.result)).toContain('tm-1')
    expect(owner.select(conns)).toBe(tm)
  })

  test('dispatcher grants by metadata match', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session', { teammate_name: 'api-worker' }))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const granted = await owner.handleTool(
      dispatcher,
      'feishu_channel_grant',
      { match: { teammate_name: 'api-worker' } },
      conns,
    )
    expect(granted.handled).toBe(true)
    if (granted.handled) expect(text(granted.result)).toContain('tm-1')

    const acquired = await owner.handleTool(tm, 'feishu_channel_acquire', {}, conns)
    expect(owner.select(conns)).toBe(tm)
    expect(acquired.handled).toBe(true)
  })

  test('a metadata match with no live session is an error', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session', { teammate_name: 'api-worker' }))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const result = await owner.handleTool(
      dispatcher,
      'feishu_channel_acquire',
      { match: { teammate_name: 'ghost' } },
      conns,
    )

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.result.isError).toBe(true)
      expect(text(result.result)).toContain('no live channel proxy matching')
    }
    expect(owner.select(conns)).toBe(dispatcher)
  })

  test('an ambiguous metadata match lists candidates and is an error', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tmA = fakeConn(session('tm-a', 'session', { teammate_name: 'twin' }))
    const tmB = fakeConn(session('tm-b', 'session', { teammate_name: 'twin' }))
    const conns = new Set([dispatcher, tmA, tmB])
    owner.register(dispatcher)

    const result = await owner.handleTool(
      dispatcher,
      'feishu_channel_grant',
      { match: { teammate_name: 'twin' } },
      conns,
    )

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.result.isError).toBe(true)
      expect(text(result.result)).toContain('ambiguous match')
      expect(text(result.result)).toContain('tm-a')
      expect(text(result.result)).toContain('tm-b')
    }
  })

  test('passing both session_id and match is an error', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session', { teammate_name: 'api-worker' }))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    const result = await owner.handleTool(
      dispatcher,
      'feishu_channel_acquire',
      { session_id: 'tm-1', match: { teammate_name: 'api-worker' } },
      conns,
    )

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.result.isError).toBe(true)
      expect(text(result.result)).toContain('pass only one of session_id / match')
    }
  })

  test('a present but invalid match is an error, not a silent acquire-self', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const tm = fakeConn(session('tm-1', 'session', { teammate_name: 'api-worker' }))
    const conns = new Set([dispatcher, tm])
    owner.register(dispatcher)

    for (const badMatch of [
      {}, // empty object
      { teammate_name: 123 }, // non-string value
      { teammate_name: 'api-worker', cwd: 123 }, // a non-string value must not be silently dropped
      [], // not an object
      'api-worker', // not an object
    ]) {
      const result = await owner.handleTool(
        dispatcher,
        'feishu_channel_acquire',
        { match: badMatch },
        conns,
      )
      expect(result.handled).toBe(true)
      if (result.handled) {
        expect(result.result.isError).toBe(true)
        expect(text(result.result)).toContain('match must be a non-empty object')
      }
      // The dispatcher must NOT have silently acquired itself off a bad selector.
      expect(owner.select(conns)).toBe(dispatcher)
    }
  })

  test('grant with neither session_id nor match is an error', async () => {
    const owner = new ChannelOwnerState()
    const dispatcher = fakeConn(session('dispatcher-1', 'dispatcher'))
    const conns = new Set([dispatcher])
    owner.register(dispatcher)

    const result = await owner.handleTool(dispatcher, 'feishu_channel_grant', {}, conns)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.result.isError).toBe(true)
      expect(text(result.result)).toContain('session_id or match is required')
    }
  })
})
