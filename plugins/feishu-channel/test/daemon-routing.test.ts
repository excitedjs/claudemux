import { describe, expect, test, vi } from 'vitest'

import type { DaemonConnection, RegisteredSession } from '../src/daemon-connection'
import {
  createInboundNotifier,
  defaultEventId,
  selectPrimary,
} from '../src/daemon-routing'

function fakeConn(session: RegisteredSession | null) {
  const delivered: Array<{ eventId: string; content: string; meta: Record<string, string> }> = []
  const conn = {
    session,
    deliver: (eventId: string, content: string, meta: Record<string, string>) =>
      delivered.push({ eventId, content, meta }),
    handle: async () => {},
  } as unknown as DaemonConnection
  return { conn, delivered }
}

const sess = (sessionId: string): RegisteredSession => ({ sessionId, pid: 1, proxyVersion: '0' })

describe('selectPrimary', () => {
  test('returns the first connection that has registered a session', () => {
    const a = fakeConn(null)
    const b = fakeConn(sess('B'))
    const c = fakeConn(sess('C'))
    const set = new Set([a.conn, b.conn, c.conn])
    expect(selectPrimary(set, {})).toBe(b.conn)
  })

  test('returns null when no connection has registered yet', () => {
    expect(selectPrimary(new Set([fakeConn(null).conn]), {})).toBeNull()
    expect(selectPrimary(new Set(), {})).toBeNull()
  })
})

describe('defaultEventId', () => {
  test('prefers the Feishu idempotency key, then message_id', () => {
    expect(defaultEventId({ event_id: 'e', message_id: 'm' })).toBe('e')
    expect(defaultEventId({ uuid: 'u', message_id: 'm' })).toBe('u')
    expect(defaultEventId({ message_id: 'm' })).toBe('m')
  })
})

describe('createInboundNotifier', () => {
  test('routes a gated inbound to the primary proxy', () => {
    const a = fakeConn(sess('A'))
    const connections = new Set([a.conn])
    const notify = createInboundNotifier({ getConnections: () => connections })
    notify('# hi', { message_id: 'om_1', event_id: 'evt_9' })
    expect(a.delivered).toEqual([{ eventId: 'evt_9', content: '# hi', meta: { message_id: 'om_1', event_id: 'evt_9' } }])
  })

  test('logs and drops when no proxy is registered (slice-1 is not yet no-loss)', () => {
    const logInfo = vi.fn()
    const notify = createInboundNotifier({ getConnections: () => new Set(), logInfo })
    notify('hi', { message_id: 'om_1' })
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('slice-2'))
  })

  test('honors a custom selector (the seam slice-3 takeover replaces)', () => {
    const a = fakeConn(sess('A'))
    const b = fakeConn(sess('B'))
    const connections = new Set([a.conn, b.conn])
    // a selector that always picks the *last* registered — stands in for takeover
    const notify = createInboundNotifier({
      getConnections: () => connections,
      selectTarget: (conns) => [...conns].filter((c) => c.session).at(-1) ?? null,
    })
    notify('x', { message_id: 'om_2' })
    expect(a.delivered).toEqual([])
    expect(b.delivered).toHaveLength(1)
  })
})
