/**
 * Durable inbound queue for the Feishu daemon (#10 slice-2).
 *
 * Receiving from Feishu and delivering to Claude are separate facts. The daemon
 * persists the received row before attempting proxy delivery, and only marks it
 * delivered after the proxy ACKs the Claude-facing notification write. This
 * intentionally gives at-least-once delivery to Claude: a crash between render
 * and ACK can replay the row, but an ACKed-before-persist loss is not possible.
 *
 * The file is append-only JSONL, not read-modify-write JSON. Handoff briefly has
 * two daemon generations with two Feishu WS clients; Feishu randomly routes
 * each event to one client, so both daemons must be able to append received
 * facts to the same durable queue without a last-writer-wins rename race.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface InboundQueueRow {
  eventId: string
  content: string
  meta: Record<string, string>
  receivedAt: number
  byGeneration: number
  deliveredAt?: number
}

type QueueEvent =
  | {
      t: 'received'
      eventId: string
      content: string
      meta: Record<string, string>
      receivedAt: number
      byGeneration: number
    }
  | { t: 'delivered'; eventId: string; deliveredAt: number }

export interface InboundQueue {
  enqueue(row: InboundQueueRow): void
  markDelivered(eventId: string, deliveredAt: number): void
  pending(): InboundQueueRow[]
  all(): InboundQueueRow[]
}

export function openInboundQueue(path: string): InboundQueue {
  return {
    enqueue(row) {
      if (readRows(path).some((r) => r.eventId === row.eventId)) return
      appendEvent(path, { t: 'received', ...row })
    },

    markDelivered(eventId, deliveredAt) {
      const row = readRows(path).find((r) => r.eventId === eventId)
      if (!row || row.deliveredAt !== undefined) return
      appendEvent(path, { t: 'delivered', eventId, deliveredAt })
    },

    pending() {
      return readRows(path).filter((r) => r.deliveredAt === undefined)
    },

    all() {
      return readRows(path)
    },
  }
}

function readRows(path: string): InboundQueueRow[] {
  try {
    const rows = new Map<string, InboundQueueRow>()
    for (const [idx, line] of readFileSync(path, 'utf8').split('\n').entries()) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as unknown
      if (!isQueueEvent(parsed)) {
        throw new Error(`invalid daemon inbound queue event at line ${idx + 1}: ${path}`)
      }
      if (parsed.t === 'received') {
        if (rows.has(parsed.eventId)) continue
        rows.set(parsed.eventId, {
          eventId: parsed.eventId,
          content: parsed.content,
          meta: parsed.meta,
          receivedAt: parsed.receivedAt,
          byGeneration: parsed.byGeneration,
        })
      } else {
        const row = rows.get(parsed.eventId)
        if (row && row.deliveredAt === undefined) row.deliveredAt = parsed.deliveredAt
      }
    }
    return [...rows.values()]
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    throw err
  }
}

function appendEvent(path: string, event: QueueEvent): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
}

function isQueueEvent(value: unknown): value is QueueEvent {
  if (!isRecord(value) || typeof value.eventId !== 'string') return false
  if (value.t === 'delivered') return typeof value.deliveredAt === 'number'
  return (
    value.t === 'received' &&
    typeof value.content === 'string' &&
    isStringRecord(value.meta) &&
    typeof value.receivedAt === 'number' &&
    typeof value.byGeneration === 'number'
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
