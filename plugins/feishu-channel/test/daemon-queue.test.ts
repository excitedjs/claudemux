import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { openInboundQueue } from '../src/daemon-queue'

let n = 0
const tmp = () => join(tmpdir(), `feishu-daemon-queue-${process.pid}-${n++}.json`)

describe('openInboundQueue', () => {
  test('persists received rows before delivery', () => {
    const path = tmp()
    const q = openInboundQueue(path)

    q.enqueue({
      eventId: 'evt_1',
      content: 'hello',
      meta: { event_id: 'evt_1', chat_id: 'oc_1' },
      receivedAt: 100,
      byGeneration: 1,
    })

    expect(q.pending()).toEqual([
      {
        eventId: 'evt_1',
        content: 'hello',
        meta: { event_id: 'evt_1', chat_id: 'oc_1' },
        receivedAt: 100,
        byGeneration: 1,
      },
    ])
    expect(readFileSync(path, 'utf8')).toContain('"eventId": "evt_1"')
  })

  test('deduplicates by Feishu idempotency key', () => {
    const q = openInboundQueue(tmp())
    const row = {
      eventId: 'evt_1',
      content: 'first',
      meta: { event_id: 'evt_1' },
      receivedAt: 100,
      byGeneration: 1,
    }

    q.enqueue(row)
    q.enqueue({ ...row, content: 'redelivered', receivedAt: 200 })

    expect(q.all()).toHaveLength(1)
    expect(q.all()[0]?.content).toBe('first')
  })

  test('marks delivered only after proxy ack', () => {
    const q = openInboundQueue(tmp())
    q.enqueue({
      eventId: 'evt_1',
      content: 'hello',
      meta: { event_id: 'evt_1' },
      receivedAt: 100,
      byGeneration: 1,
    })

    q.markDelivered('evt_1', 150)

    expect(q.pending()).toEqual([])
    expect(q.all()[0]?.deliveredAt).toBe(150)
  })
})
