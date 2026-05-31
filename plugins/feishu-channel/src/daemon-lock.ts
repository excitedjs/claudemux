/**
 * Single-instance lock for the standing daemon (claudemux#10, slice-1 OS layer).
 *
 * The lock moves off the per-session servers onto the one daemon. Correctness
 * rests on three invariants (索西雅's review of the stale-reclaim race):
 *
 *   ① Re-probe AFTER acquiring, never act on a pre-acquire probe. `lock()` may
 *      have *stolen* a lock whose mtime merely lapsed under load while the holder
 *      is still serving; only a fresh post-acquire socket probe can tell.
 *   ② Don't hand-roll stale unlink. proper-lockfile owns staleness via the lock
 *      dir's mtime (kernel-atomic `mkdir` to take it, background `utimes` to keep
 *      it fresh, `stale` ms to steal it). No "judge-dead → unlink → recreate"
 *      window for two starters to both pass through.
 *   ③ The unix-socket bind (daemon-server) is the BACKSTOP arbiter, not the
 *      primary one: even if two starters somehow both leave `lock()`, only one
 *      can `listen()` the socket. The lock makes that path cold; the bind makes
 *      it safe. (Bind also doubles as the slice-2 handoff arbiter.)
 *
 * Liveness is deliberately NOT parent-watching / `process.ppid` (unrefreshed
 * under bun → stale holder survives `/reload-plugins`). The authority is the
 * socket `hello` probe + proper-lockfile's mtime — both ppid-independent.
 */

import { connect } from 'node:net'

import lockfile from 'proper-lockfile'

import { FrameDecoder, type DaemonToProxy } from './ipc'

export interface DaemonLockRecord {
  pid: number
  /** Epoch millis the holder started — diagnostics + slice-2 handoff identity. */
  startedAt: number
  socketPath: string
  daemonVersion: string
}

export interface AcquireDaemonLockDeps {
  /**
   * File proper-lockfile guards (it creates `<lockPath>.lock/`). Need not exist;
   * we pass `realpath: false` so a missing target doesn't reject.
   */
  lockPath: string
  self: DaemonLockRecord
  /**
   * Re-probe (invariant ①) — true iff a *live* daemon already answers the
   * socket. Injected for tests; defaults to the `hello` probe on self.socketPath.
   */
  probe?(socketPath: string): Promise<boolean>
  /**
   * Staleness threshold (ms) for the lock's mtime. A holder past this without a
   * refresh is presumed crashed and its lock is stealable. Default 15s.
   */
  staleMs?: number
  logInfo?(message: string): void
}

export interface DaemonLockHandle {
  /** Release the single-instance lock. Idempotent; safe in a finally/close. */
  release(): Promise<void>
}

export type AcquireResult =
  | { acquired: true; handle: DaemonLockHandle }
  /** `held` — a live daemon holds a fresh lock; `serving` — re-probe (①) found one. */
  | { acquired: false; reason: 'held' | 'serving' }

/**
 * Try to become the one daemon. On success the returned handle holds the lock
 * for the daemon's lifetime (proper-lockfile keeps the mtime fresh in the
 * background); call `handle.release()` from the daemon's close path.
 */
export async function acquireDaemonLock(deps: AcquireDaemonLockDeps): Promise<AcquireResult> {
  const probe = deps.probe ?? ((p: string) => probeDaemonSocket(p))
  const logInfo = deps.logInfo ?? (() => {})

  let release: () => Promise<void>
  try {
    // Invariant ②: proper-lockfile is the mutex. `lock()` succeeds iff the lock
    // is free OR stale (mtime older than `stale`), and the steal is atomic — no
    // unlink/recreate window. A fresh holder makes this throw ELOCKED.
    release = await lockfile.lock(deps.lockPath, {
      stale: deps.staleMs ?? 15_000,
      realpath: false,
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') return { acquired: false, reason: 'held' }
    throw err
  }

  // Invariant ①: we may have stolen a merely-lapsed lock from a daemon that is
  // in fact still serving. Probe NOW — never trust a pre-acquire read. If a live
  // daemon answers, stand down and reuse it; releasing returns the (just-stolen)
  // lock so the real holder keeps refreshing it.
  if (await probe(deps.self.socketPath)) {
    await safeRelease(release)
    return { acquired: false, reason: 'serving' }
  }

  logInfo(`acquired daemon lock (pid ${deps.self.pid}, ${deps.self.daemonVersion})`)
  let released = false
  return {
    acquired: true,
    handle: {
      release: async () => {
        if (released) return
        released = true
        await safeRelease(release)
      },
    },
  }
}

async function safeRelease(release: () => Promise<void>): Promise<void> {
  try {
    await release()
  } catch {
    // Already compromised/released — nothing to clean up.
  }
}

/**
 * Connect to the daemon socket and resolve true iff it answers with a `hello`
 * within `timeoutMs`. ppid-independent and recycle-proof: only the real daemon
 * speaks this protocol on this socket.
 */
export function probeDaemonSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const decoder = new FrameDecoder<DaemonToProxy>()
    let settled = false
    const done = (alive: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    const socket = connect(socketPath)
    socket.on('error', () => done(false))
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const m of decoder.push(chunk)) {
          if (m.t === 'hello') return done(true)
        }
      } catch {
        done(false)
      }
    })
  })
}
