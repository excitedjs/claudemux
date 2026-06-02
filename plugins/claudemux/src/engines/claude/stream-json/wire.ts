/**
 * The `tm` ↔ broker control protocol over the per-teammate unix socket.
 *
 * `tm` is stateless and ephemeral; the broker is the long-lived process that
 * holds the `claude` stream-json child. Every `tm` verb that targets a Claude
 * teammate opens a short connection to the broker's socket, sends exactly one
 * request line (NDJSON), reads the response line(s), and closes. This file is
 * the shared shape of those messages plus the framing helper both sides use.
 *
 * Kept deliberately small: one request per connection, one terminal response.
 * The transport is a plain `node:net` unix socket — no WebSocket, no
 * dependency — because the payloads are line-delimited JSON, not framed binary.
 */

import type { Socket } from 'node:net'

/** A turn's reduced outcome as it crosses the socket back to `tm`. */
export interface WireTurn {
  readonly isError: boolean
  readonly text: string
  readonly stopReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadInputTokens: number | null
  readonly totalCostUsd: number | null
  readonly numTurns: number | null
  readonly durationMs: number | null
  readonly sessionId: string | null
  readonly subtype: string | null
}

/** Requests `tm` sends to the broker. One per connection. */
export type BrokerRequest =
  | { op: 'ping' }
  | { op: 'send'; prompt: string; timeoutMs: number | null }
  | { op: 'wait'; timeoutMs: number | null; fresh: boolean }
  | { op: 'status' }
  | { op: 'last' }
  | { op: 'kill' }

/** The broker's live view of itself, for `tm status` / `tm ls`. */
export interface BrokerStatus {
  readonly sessionId: string | null
  readonly model: string | null
  readonly state: 'idle' | 'busy' | 'starting'
  readonly remoteControlUrl: string | null
  readonly lastText: string | null
}

/** Responses the broker sends back. The discriminant is `ok` plus a kind. */
export type BrokerResponse =
  | { ok: true; kind: 'ping'; ready: boolean }
  | { ok: true; kind: 'turn'; turn: WireTurn }
  | { ok: true; kind: 'status'; status: BrokerStatus }
  | { ok: true; kind: 'last'; text: string }
  | { ok: true; kind: 'killed' }
  | { ok: false; kind: 'busy' | 'timed-out' | 'child-gone' | 'error'; message: string; elapsedMs?: number }

/**
 * Read exactly one newline-delimited JSON value off a socket, then resolve.
 * Resolves `null` if the peer closes before a full line arrives. Used by both
 * ends — the broker to read the request, `tm` to read the response.
 */
export function readOneJsonLine<T>(sock: Socket): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let buf = ''
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      sock.off('data', onData)
      sock.off('end', onEnd)
      sock.off('error', onError)
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      try {
        finish(JSON.parse(line) as T)
      } catch (err) {
        settled = true
        sock.off('data', onData)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    const onEnd = (): void => finish(null)
    const onError = (err: Error): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    sock.on('data', onData)
    sock.on('end', onEnd)
    sock.on('error', onError)
  })
}

/** Write one JSON value as a single NDJSON line. */
export function writeJsonLine(sock: Socket, value: unknown): void {
  sock.write(`${JSON.stringify(value)}\n`)
}
