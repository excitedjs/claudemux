/**
 * Durable inbound queue for the Feishu daemon (#10 slice-2).
 *
 * Receiving from Feishu and delivering to Claude are separate facts. The daemon
 * persists the received row before attempting proxy delivery, and only marks it
 * delivered after the proxy ACKs the Claude-facing notification write. This
 * intentionally gives at-least-once delivery to Claude: a crash between render
 * and ACK can replay the row, but an ACKed-before-persist loss is not possible.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface InboundQueueRow {
  eventId: string
  content: string
  meta: Record<string, string>
  receivedAt: number
  byGeneration: number
  deliveredAt?: number
}

interface QueueFile {
  version: 1
  rows: InboundQueueRow[]
}

export interface InboundQueue {
  enqueue(row: InboundQueueRow): void
  markDelivered(eventId: string, deliveredAt: number): void
  pending(): InboundQueueRow[]
  all(): InboundQueueRow[]
}

export function openInboundQueue(path: string): InboundQueue {
  return {
    enqueue(row) {
      const file = readQueue(path)
      if (file.rows.some((r) => r.eventId === row.eventId)) return
      file.rows.push(row)
      writeQueue(path, file)
    },

    markDelivered(eventId, deliveredAt) {
      const file = readQueue(path)
      const row = file.rows.find((r) => r.eventId === eventId)
      if (!row || row.deliveredAt !== undefined) return
      row.deliveredAt = deliveredAt
      writeQueue(path, file)
    },

    pending() {
      return readQueue(path).rows.filter((r) => r.deliveredAt === undefined)
    },

    all() {
      return readQueue(path).rows
    },
  }
}

function readQueue(path: string): QueueFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (isQueueFile(parsed)) return parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { version: 1, rows: [] }
    throw err
  }
  throw new Error(`invalid daemon inbound queue: ${path}`)
}

function writeQueue(path: string, file: QueueFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

function isQueueFile(value: unknown): value is QueueFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.rows) &&
    value.rows.every(isQueueRow)
  )
}

function isQueueRow(value: unknown): value is InboundQueueRow {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.content === 'string' &&
    isStringRecord(value.meta) &&
    typeof value.receivedAt === 'number' &&
    typeof value.byGeneration === 'number' &&
    (value.deliveredAt === undefined || typeof value.deliveredAt === 'number')
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
