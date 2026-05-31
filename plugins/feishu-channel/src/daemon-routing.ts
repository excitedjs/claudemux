/**
 * Inbound routing seam for the daemon (claudemux#10, slice-1).
 *
 * The daemon owns the single Feishu connection; a gated inbound event must go to
 * exactly one proxy. The default policy prefers the active dispatcher proxy and
 * falls back to the first ordinary session only while no dispatcher is online.
 * That prevents a random Claude Code session from permanently stealing the
 * inbound stream while the dispatcher restarts; once the dispatcher reconnects,
 * it becomes the target again. The policy lives behind a `TargetSelector` seam
 * so slice-3 takeover (per-conversation routing) can replace only the selector,
 * never the deliver path.
 *
 * Slice-2 pairs this fire-to-proxy path with a durable queue: the daemon
 * persists the row before calling this router, and only marks it delivered
 * after the proxy ACKs the Claude-facing notification write.
 */

import type { DaemonConnection } from './daemon-connection'

/** Chooses which connected proxy receives a given inbound event, or none. */
export type TargetSelector = (
  connections: ReadonlySet<DaemonConnection>,
  meta: Record<string, string>,
) => DaemonConnection | null

/**
 * Default: newest registered dispatcher wins; when none is online, fall back to
 * the first registered ordinary session. Ignores `meta`; slice-3 takeover swaps
 * in a selector that routes by conversation.
 */
export const selectPrimary: TargetSelector = (connections) => {
  const registered = [...connections].filter((conn) => conn.session !== null)
  for (let i = registered.length - 1; i >= 0; i--) {
    const conn = registered[i]
    if (conn?.session?.role === 'dispatcher') return conn
  }
  return registered[0] ?? null
}

export const selectDispatcherPreferred = selectPrimary

export const selectFirstRegistered: TargetSelector = (connections) => {
  for (const conn of connections) {
    if (conn.session !== null) return conn
  }
  return null
}

export interface InboundNotifierDeps {
  /** The daemon server's live connection set (read each delivery — it changes). */
  getConnections(): ReadonlySet<DaemonConnection>
  /** Routing policy; defaults to `selectPrimary`. */
  selectTarget?: TargetSelector
  /**
   * The delivery id used for the proxy ACK correlation. Defaults to the Feishu
   * idempotency key when present (`event_id`/`uuid`), falling back to
   * `message_id`. Slice-2's durable queue keys dedup on the same value.
   */
  makeEventId?(meta: Record<string, string>): string
  logInfo?(message: string): void
}

/** The Feishu idempotency key for `meta`, or a stable fallback. */
export function defaultEventId(meta: Record<string, string>): string {
  return meta.event_id ?? meta.uuid ?? meta.message_id ?? `evt_${meta.create_time ?? ''}`
}

/**
 * Build the router the daemon uses after it has persisted a received row. It
 * returns whether a proxy was available for immediate delivery; when false, the
 * caller leaves the row pending for a later proxy registration replay.
 */
export function createInboundNotifier(
  deps: InboundNotifierDeps,
): (content: string, meta: Record<string, string>) => boolean {
  const selectTarget = deps.selectTarget ?? selectPrimary
  const makeEventId = deps.makeEventId ?? defaultEventId
  const logInfo = deps.logInfo ?? (() => {})

  return (content, meta) => {
    const target = selectTarget(deps.getConnections(), meta)
    if (target === null) {
      logInfo('no proxy registered — inbound persisted and left pending')
      return false
    }
    target.deliver(makeEventId(meta), content, meta)
    return true
  }
}
