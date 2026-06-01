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

const sess = (
  sessionId: string,
  role: RegisteredSession['role'] = 'session',
): RegisteredSession => ({ sessionId, pid: 1, proxyVersion: '0', role, metadata: {} })

describe('selectPrimary', () => {
  test('returns the first ordinary session when no dispatcher is online', () => {
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

  test('prefers a dispatcher over ordinary sessions', () => {
    const a = fakeConn(sess('ordinary'))
    const b = fakeConn(sess('dispatcher', 'dispatcher'))
    const c = fakeConn(sess('another'))
    expect(selectPrimary(new Set([a.conn, b.conn, c.conn]), {})).toBe(b.conn)
  })

  test('a reconnected dispatcher wins over an earlier dispatcher', () => {
    const oldDispatcher = fakeConn(sess('old', 'dispatcher'))
    const ordinary = fakeConn(sess('ordinary'))
    const newDispatcher = fakeConn(sess('new', 'dispatcher'))
    expect(selectPrimary(new Set([oldDispatcher.conn, ordinary.conn, newDispatcher.conn]), {})).toBe(
      newDispatcher.conn,
    )
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
    expect(notify('# hi', { message_id: 'om_1', event_id: 'evt_9' })).toBe(true)
    expect(a.delivered).toEqual([{ eventId: 'evt_9', content: '# hi', meta: { message_id: 'om_1', event_id: 'evt_9' } }])
  })

  test('logs and leaves pending when no proxy is registered', () => {
    const logInfo = vi.fn()
    const notify = createInboundNotifier({ getConnections: () => new Set(), logInfo })
    expect(notify('hi', { message_id: 'om_1' })).toBe(false)
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining('left pending'))
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
