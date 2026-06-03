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

import {
  acquireDaemonLock,
  probeDaemonSocketInfo,
  type AcquireDaemonLockDeps,
  type DaemonLockRecord,
  type DaemonSocketInfo,
} from './daemon-lock'
import { DaemonAlreadyRunningError, startDaemonServer, type DaemonServer } from './daemon-server'
import { createInboundNotifier, defaultEventId } from './daemon-routing'
import { openInboundQueue, type InboundQueue } from './daemon-queue'
import { createChannelCore } from './server'
import type { FeishuTransport } from './feishu'
import {
  acquireInstanceLockWithEviction,
  defaultEvictionDeps,
  releaseInstanceLock,
  type EvictionResult,
} from './instance-lock'
import { ChannelOwnerState } from './channel-owner'
import { comparePluginVersions } from './version'

export interface StartDaemonDeps {
  lockPath: string
  socketPath: string
  daemonVersion: string
  generation: number
  /**
   * The dir this daemon was launched from (its plugin root, resolved from
   * `import.meta.url`). Surfaced in `feishu_channel_status` as the authoritative
   * daemon launch path for `feishu_channel_doctor`.
   */
  launchPath?: string
  /** This daemon's lock record (pid, startedAt, socketPath, daemonVersion). */
  self: DaemonLockRecord
  /** Re-probe (lock invariant ①) for an existing holder; defaults to the socket `hello` probe. */
  probe?: AcquireDaemonLockDeps['probe']
  /** Read the serving daemon's `hello` identity for version-aware replacement. */
  probeDaemonInfo?(socketPath: string): Promise<DaemonSocketInfo | null>
  /** Staleness threshold (ms) for the daemon lock; forwarded to proper-lockfile. */
  staleMs?: number
  /** The Feishu platform boundary — a lock-free transport (or a test fake). */
  transport: FeishuTransport
  /** Path to access.json (the host access policy the core reasons over). */
  accessFile: string
  /** Path to the durable received/delivered inbound queue. */
  queueFile: string
  /**
   * Compatibility lock for pre-daemon feishu-channel servers. The daemon owns
   * the real single-instance lock, but it also holds the legacy inbound lock so
   * an old per-session server cannot keep a second Feishu WebSocket alive
   * during plugin upgrades.
   */
  legacyInboundLockPath?: string
  baseDir?: string
  /** Marks an inbound row delivered once a proxy ACKs (slice-2 persists). */
  onAck?(eventId: string): void
  acquireLegacyInboundLock?(path: string): Promise<EvictionResult>
  releaseLegacyInboundLock?(path: string): void
  sleep?(ms: number): Promise<void>
  now?(): number
  logInfo?(message: string): void
  logError?(message: string, err?: unknown): void
}

export type StartDaemonResult =
  /** This process became the daemon; `close` tears it down and frees the lock. */
  | { started: true; close(): Promise<void>; server: DaemonServer }
  /** A live daemon already holds the lock/socket — the caller should reuse it. */
  | { started: false; reason: 'held' | 'serving' }

const POST_EVICTION_DAEMON_LOCK_STALE_MS = 2_000

export async function startDaemon(deps: StartDaemonDeps): Promise<StartDaemonResult> {
  let lock = await acquireDaemonLock({
    lockPath: deps.lockPath,
    self: deps.self,
    probe: deps.probe,
    staleMs: deps.staleMs,
    logInfo: deps.logInfo,
    logError: deps.logError,
  })
  if (!lock.acquired && await tryEvictOlderDaemon(deps)) {
    lock = await acquireDaemonLockAfterEviction(deps)
  }
  if (!lock.acquired) return { started: false, reason: lock.reason }

  const queue = openInboundQueue(deps.queueFile)
  let routePending = () => {}
  const owner = new ChannelOwnerState(
    () => routePending(),
    () => ({
      version: deps.daemonVersion,
      pid: deps.self.pid,
      generation: deps.generation,
      started_at: deps.self.startedAt,
      // The daemon's cwd is its launch dir (the spawner sets cwd to the plugin
      // root), so it is the right fallback when an explicit path was not passed.
      launch_path: deps.launchPath ?? process.cwd(),
    }),
  )

  // Lazy connection ref breaks the core<->server<->notify cycle: the router is
  // built before the server, but only reads connections at delivery time.
  let server: DaemonServer | null = null
  const route = createInboundNotifier({
    getConnections: () => server?.connections ?? new Set(),
    selectTarget: (connections) => owner.select(connections),
    logInfo: deps.logInfo,
  })
  routePending = () => replayPending(queue, route)
  const notify = createDurableNotifier({
    queue,
    generation: deps.generation,
    route,
    now: deps.now ?? Date.now,
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
      onAck: (eventId) => {
        queue.markDelivered(eventId, (deps.now ?? Date.now)())
        deps.onAck?.(eventId)
      },
      onRegister: (conn) => {
        owner.register(conn)
        replayPending(queue, route)
      },
      handleOwnershipTool: (conn, name, args) =>
        owner.handleTool(conn, name, args, server?.connections ?? new Set()),
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

  let legacyInboundLockHeld = false
  if (deps.legacyInboundLockPath) {
    const acquireLegacyInboundLock = deps.acquireLegacyInboundLock ?? acquireInstanceLockWithEviction
    const legacy = await acquireLegacyInboundLock(deps.legacyInboundLockPath)
    if (!legacy.acquired) {
      deps.logInfo?.(
        `legacy inbound lock is still held by pid ${legacy.holderPid ?? 'unknown'}; standing down`,
      )
      await server.close()
      await lock.handle.release()
      return { started: false, reason: 'held' }
    }
    legacyInboundLockHeld = true
    if (legacy.evicted) deps.logInfo?.('evicted an older per-session channel server')
  }

  try {
    // Open the Feishu connection last, once we can route what it delivers.
    await deps.transport.start(core.routes)
  } catch (err) {
    if (legacyInboundLockHeld) {
      ;(deps.releaseLegacyInboundLock ?? releaseInstanceLock)(deps.legacyInboundLockPath!)
    }
    await server.close()
    await lock.handle.release()
    throw err
  }
  replayPending(queue, route)

  const liveServer = server
  return {
    started: true,
    server: liveServer,
    close: async () => {
      await deps.transport.close()
      await liveServer.close()
      if (legacyInboundLockHeld) {
        ;(deps.releaseLegacyInboundLock ?? releaseInstanceLock)(deps.legacyInboundLockPath!)
      }
      await lock.handle.release()
    },
  }
}

async function tryEvictOlderDaemon(deps: StartDaemonDeps): Promise<boolean> {
  if (!deps.legacyInboundLockPath) return false
  const probeDaemonInfo = deps.probeDaemonInfo ?? probeDaemonSocketInfo
  const info = await probeDaemonInfo(deps.socketPath)
  if (!info) return false
  let isOlder = false
  try {
    isOlder = comparePluginVersions(info.daemonVersion, deps.daemonVersion) < 0
  } catch {
    return false
  }
  if (!isOlder) return false

  const acquireLegacyInboundLock = deps.acquireLegacyInboundLock ?? acquireLegacyInboundLockAfterVersionDecision
  const legacy = await acquireLegacyInboundLock(deps.legacyInboundLockPath)
  if (legacy.acquired) {
    ;(deps.releaseLegacyInboundLock ?? releaseInstanceLock)(deps.legacyInboundLockPath)
  }
  if (legacy.evicted) {
    deps.logInfo?.(
      `evicted older Feishu daemon ${info.daemonVersion}; retrying daemon startup as ${deps.daemonVersion}`,
    )
  }
  return legacy.evicted
}

async function acquireDaemonLockAfterEviction(
  deps: StartDaemonDeps,
): Promise<Awaited<ReturnType<typeof acquireDaemonLock>>> {
  const lock = await acquireDaemonLock({
    lockPath: deps.lockPath,
    self: deps.self,
    probe: deps.probe,
    staleMs: POST_EVICTION_DAEMON_LOCK_STALE_MS,
    logInfo: deps.logInfo,
    logError: deps.logError,
  })
  if (lock.acquired || lock.reason !== 'held') return lock

  // proper-lockfile clamps stale thresholds to a 2s floor. If the old daemon
  // was SIGKILLed after confirmed exit, its lock can still be mtime-fresh; wait
  // out the floor, then rely on the normal post-acquire socket probe.
  await (deps.sleep ?? sleep)(POST_EVICTION_DAEMON_LOCK_STALE_MS)
  return acquireDaemonLock({
    lockPath: deps.lockPath,
    self: deps.self,
    probe: deps.probe,
    staleMs: POST_EVICTION_DAEMON_LOCK_STALE_MS,
    logInfo: deps.logInfo,
    logError: deps.logError,
  })
}

function acquireLegacyInboundLockAfterVersionDecision(path: string): Promise<EvictionResult> {
  return acquireInstanceLockWithEviction(path, {
    ...defaultEvictionDeps(),
    requireDifferentSelfDir: false,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createDurableNotifier(deps: {
  queue: InboundQueue
  generation: number
  now(): number
  route(content: string, meta: Record<string, string>): boolean
}): (content: string, meta: Record<string, string>) => void {
  return (content, meta) => {
    const eventId = defaultEventId(meta)
    deps.queue.enqueue({
      eventId,
      content,
      meta,
      receivedAt: deps.now(),
      byGeneration: deps.generation,
    })
    deps.route(content, meta)
  }
}

function replayPending(
  queue: InboundQueue,
  route: (content: string, meta: Record<string, string>) => boolean,
): void {
  for (const row of queue.pending()) {
    if (!route(row.content, row.meta)) return
  }
}
