/**
 * The Claude stream-json broker process registry.
 *
 * The broker is detached and outlives any single `tm` invocation, so — exactly
 * as for the Codex daemon — there is no resident object holding it. `tm`
 * reconstructs the live broker set from the filesystem: each teammate's broker
 * writes its pid, its `meta.json`, and binds its socket under
 * `claudeStreamDir(name)`. Liveness is `kill(pid, 0)` plus a bound socket.
 *
 * All paths come from the named builders in `persistence/paths.ts` (the
 * path-builder discipline of decision cross-process-cross-platform-invariants);
 * nothing here concatenates a `/tmp` path by hand.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import {
  claudeStreamDir,
  claudeStreamMetaFile,
  claudeStreamPidFile,
  claudeStreamRoot,
  claudeStreamSocket,
} from '../../../persistence/paths'
import type { TeammateName } from '../../types'

/** Broker metadata, written once the `claude` child's `init` envelope lands. */
export interface BrokerMeta {
  readonly name: TeammateName
  readonly repo: string
  readonly cwd: string
  readonly worktreeSlug: string | null
  /** Claude session id from the `init`/`result` envelope; `null` until known. */
  sessionId: string | null
  model: string | null
  readonly remoteControl: boolean
  /** The claude.ai session URL once Remote Control is enabled; `null` otherwise. */
  remoteControlUrl: string | null
  /** Broker start time (epoch seconds), stamped by `tm` at spawn. */
  readonly startedAt: number
}

/** Create the per-teammate broker dir (idempotent). */
export function ensureBrokerDir(name: TeammateName): void {
  mkdirSync(claudeStreamDir(name), { recursive: true })
}

export function writeBrokerPid(name: TeammateName, pid: number): void {
  ensureBrokerDir(name)
  writeFileSync(claudeStreamPidFile(name), `${pid}\n`, 'utf8')
}

export function readBrokerPid(name: TeammateName): number | null {
  try {
    const raw = readFileSync(claudeStreamPidFile(name), 'utf8').trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Whether `pid` names a live process. `kill(pid, 0)` probes without signalling. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but is owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether a teammate's broker is up: a live pid and a bound socket. A pid that
 * has died (broker crashed) or a missing socket (broker mid-teardown) both read
 * as not-alive, so a stale dir never masquerades as a running teammate.
 */
export function brokerAlive(name: TeammateName): boolean {
  const pid = readBrokerPid(name)
  if (pid === null || !pidAlive(pid)) return false
  return existsSync(claudeStreamSocket(name))
}

export function writeMeta(meta: BrokerMeta): void {
  ensureBrokerDir(meta.name)
  writeFileSync(claudeStreamMetaFile(meta.name), `${JSON.stringify(meta)}\n`, 'utf8')
}

export function readMeta(name: TeammateName): BrokerMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(claudeStreamMetaFile(name), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as BrokerMeta
  } catch {
    return null
  }
}

/** Enumerate every teammate name that has a *live* broker. */
export function listLiveBrokers(): TeammateName[] {
  let entries: string[]
  try {
    entries = readdirSync(claudeStreamRoot())
  } catch {
    return []
  }
  const out: TeammateName[] = []
  for (const name of entries) {
    if (brokerAlive(name)) out.push(name)
  }
  return out
}

/** Remove a teammate's entire broker runtime dir (socket, pid, meta, logs). */
export function removeBrokerDir(name: TeammateName): void {
  rmSync(claudeStreamDir(name), { recursive: true, force: true })
}
