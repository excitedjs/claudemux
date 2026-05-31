/**
 * Single-instance lock for the standing daemon (claudemux#10, slice-1 OS layer).
 *
 * The lock moves off the per-session servers onto the one daemon. Liveness is
 * deliberately NOT based on parent-watching / `process.ppid`: under bun,
 * `process.ppid` isn't refreshed, so the old watchParent orphan check lets a
 * stale lock-holder survive a `/reload-plugins`. Instead the authority is an
 * active probe of the daemon's own socket — a real daemon answers its socket
 * with a `hello`; a dead/hung/recycled holder does not — backed by a cheap
 * `pid`-alive pre-filter. The lock record also carries `startedAt` so release
 * never deletes a *newer* holder's lock.
 */

import { connect } from 'node:net'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

import { FrameDecoder, type DaemonToProxy } from './ipc'

export interface DaemonLockRecord {
  pid: number
  /** Epoch millis the holder started — distinguishes a recycled pid on release. */
  startedAt: number
  socketPath: string
  daemonVersion: string
}

export interface AcquireDaemonLockDeps {
  lockPath: string
  self: DaemonLockRecord
  /**
   * Is the current holder genuinely alive? Injected for tests; the default
   * (`defaultIsHolderAlive`) is a pid pre-filter + a socket `hello` probe.
   */
  isHolderAlive?(holder: DaemonLockRecord): Promise<boolean>
  /** Bound reclaim attempts so two racing daemons can't livelock. */
  maxAttempts?: number
  logInfo?(message: string): void
}

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; holder: DaemonLockRecord }

export async function acquireDaemonLock(deps: AcquireDaemonLockDeps): Promise<AcquireResult> {
  const isHolderAlive = deps.isHolderAlive ?? defaultIsHolderAlive
  const logInfo = deps.logInfo ?? (() => {})
  const maxAttempts = deps.maxAttempts ?? 3

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      writeFileSync(deps.lockPath, JSON.stringify(deps.self), { flag: 'wx' })
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    const holder = readHolder(deps.lockPath)
    if (holder === null) continue // vanished between create and read — retry

    if (await isHolderAlive(holder)) {
      return { acquired: false, holder }
    }

    // Stale holder (dead pid / unresponsive socket / recycled pid) — reclaim.
    logInfo(`reclaiming stale daemon lock from pid ${holder.pid} (${holder.daemonVersion})`)
    try {
      unlinkSync(deps.lockPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  const holder = readHolder(deps.lockPath)
  return holder ? { acquired: false, holder } : { acquired: false, holder: deps.self }
}

/** Release the lock only if it still belongs to `self` (don't clobber a newer holder). */
export function releaseDaemonLock(lockPath: string, self: DaemonLockRecord): void {
  const holder = readHolder(lockPath)
  if (holder && holder.pid === self.pid && holder.startedAt === self.startedAt) {
    try {
      unlinkSync(lockPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

function readHolder(lockPath: string): DaemonLockRecord | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as DaemonLockRecord
  } catch {
    return null
  }
}

/** pid-alive pre-filter, then the authoritative socket `hello` probe. */
export async function defaultIsHolderAlive(holder: DaemonLockRecord): Promise<boolean> {
  if (!pidAlive(holder.pid)) return false
  return probeDaemonSocket(holder.socketPath)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but not ours → still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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
