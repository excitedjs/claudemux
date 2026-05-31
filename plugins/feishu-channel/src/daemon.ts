/**
 * Daemon process body (claudemux#10, slice-1 OS layer).
 *
 * Ties the slice-1 components together behind the idempotent-startup invariant:
 * acquire the daemon lock; if a live daemon already holds it, do nothing (the
 * caller reuses the running one via the socket). Otherwise become the daemon —
 * own the single Feishu connection (lock-free transport; single-instance is the
 * daemon lock's job, NOT the transport's), run the channel core, route gated
 * inbound to the primary proxy, and serve proxies over the unix socket.
 *
 * The transport is injected so the orchestration is testable without a live
 * Feishu connection; the real entrypoint passes the core's lock-free
 * `createFeishuTransport`.
 */

import { acquireDaemonLock, type AcquireDaemonLockDeps, type DaemonLockRecord } from './daemon-lock'
import { DaemonAlreadyRunningError, startDaemonServer, type DaemonServer } from './daemon-server'
import { createInboundNotifier, type TargetSelector } from './daemon-routing'
import { createChannelCore } from './server'
import type { FeishuTransport } from './feishu'

export interface StartDaemonDeps {
  lockPath: string
  socketPath: string
  daemonVersion: string
  generation: number
  /** This daemon's lock record (pid, startedAt, socketPath, daemonVersion). */
  self: DaemonLockRecord
  /** Re-probe (lock invariant ①) for an existing holder; defaults to the socket `hello` probe. */
  probe?: AcquireDaemonLockDeps['probe']
  /** Staleness threshold (ms) for the daemon lock; forwarded to proper-lockfile. */
  staleMs?: number
  /** The Feishu platform boundary — a lock-free transport (or a test fake). */
  transport: FeishuTransport
  /** Path to access.json (the host access policy the core reasons over). */
  accessFile: string
  baseDir?: string
  /** Routing policy; defaults to primary = first-registered proxy. */
  selectTarget?: TargetSelector
  /** Marks an inbound row delivered once a proxy ACKs (slice-2 persists). */
  onAck?(eventId: string): void
  now?(): number
  logInfo?(message: string): void
  logError?(message: string, err?: unknown): void
}

export type StartDaemonResult =
  /** This process became the daemon; `close` tears it down and frees the lock. */
  | { started: true; close(): Promise<void>; server: DaemonServer }
  /** A live daemon already holds the lock/socket — the caller should reuse it. */
  | { started: false; reason: 'held' | 'serving' }

export async function startDaemon(deps: StartDaemonDeps): Promise<StartDaemonResult> {
  const lock = await acquireDaemonLock({
    lockPath: deps.lockPath,
    self: deps.self,
    probe: deps.probe,
    staleMs: deps.staleMs,
    logInfo: deps.logInfo,
  })
  if (!lock.acquired) return { started: false, reason: lock.reason }

  // Lazy connection ref breaks the core<->server<->notify cycle: the notifier is
  // built before the server, but only reads connections at delivery time.
  let server: DaemonServer | null = null
  const notify = createInboundNotifier({
    getConnections: () => server?.connections ?? new Set(),
    selectTarget: deps.selectTarget,
    logInfo: deps.logInfo,
  })

  const core = createChannelCore({
    transport: deps.transport,
    accessFile: deps.accessFile,
    baseDir: deps.baseDir,
    notify,
    now: deps.now,
    logError: deps.logError,
    logInfo: deps.logInfo,
  })

  try {
    server = await startDaemonServer({
      socketPath: deps.socketPath,
      daemonVersion: deps.daemonVersion,
      generation: deps.generation,
      core,
      onAck: deps.onAck,
      logError: deps.logError,
    })
  } catch (err) {
    // Backstop (invariant ③): the socket bind is the last-line arbiter. If we
    // held the lock yet another live daemon owns the socket, stand down rather
    // than crash — release the lock and let the caller reuse the running one.
    await lock.handle.release()
    if (err instanceof DaemonAlreadyRunningError) return { started: false, reason: 'serving' }
    throw err
  }

  // Open the Feishu connection last, once we can route what it delivers.
  await deps.transport.start(core.routes)

  const liveServer = server
  return {
    started: true,
    server: liveServer,
    close: async () => {
      await deps.transport.close()
      await liveServer.close()
      await lock.handle.release()
    },
  }
}
