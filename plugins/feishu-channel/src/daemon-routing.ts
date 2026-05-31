/**
 * Inbound routing seam for the daemon (claudemux#10, slice-1).
 *
 * The daemon owns the single Feishu connection; a gated inbound event must go to
 * exactly one proxy. Slice-1's policy is deliberately minimal — deliver to the
 * **primary** proxy (the first one to register a session) — and it lives behind
 * a `TargetSelector` seam so slice-3 takeover (per-conversation routing) can
 * replace only the selector, never the deliver path. No host role (e.g.
 * "dispatcher") is hardcoded: "primary" is purely the first-registered proxy.
 *
 * Slice-1 is NOT yet no-loss: when no proxy is registered the event is
 * logged and dropped. The no-loss guarantee (durable queue keyed on the Feishu
 * idempotency key, drain-side persistence) lands in slice-2.
 */

import type { DaemonConnection } from './daemon-connection'

/** Chooses which connected proxy receives a given inbound event, or none. */
export type TargetSelector = (
  connections: ReadonlySet<DaemonConnection>,
  meta: Record<string, string>,
) => DaemonConnection | null

/**
 * Slice-1 default: the primary proxy = the first connection (in accept order,
 * which tracks register order) that has registered a session. Ignores `meta`;
 * slice-3 takeover swaps in a selector that routes by conversation.
 */
export const selectPrimary: TargetSelector = (connections) => {
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
 * Build the `ChannelNotifier` the daemon hands to its channel core: it routes a
 * gated inbound event to the selected proxy's `deliver`. Returns void — delivery
 * is fire-to-proxy; the no-loss/ack semantics live in the proxy ACK + (slice-2)
 * the durable queue.
 */
export function createInboundNotifier(
  deps: InboundNotifierDeps,
): (content: string, meta: Record<string, string>) => void {
  const selectTarget = deps.selectTarget ?? selectPrimary
  const makeEventId = deps.makeEventId ?? defaultEventId
  const logInfo = deps.logInfo ?? (() => {})

  return (content, meta) => {
    const target = selectTarget(deps.getConnections(), meta)
    if (target === null) {
      logInfo(
        'no proxy registered — slice-1 drops this inbound (no-loss lands in slice-2 durable queue)',
      )
      return
    }
    target.deliver(makeEventId(meta), content, meta)
  }
}
