/**
 * Small filesystem/string helpers shared by the Claude engine's verb modules.
 *
 * These were spread across the retired tmux-bridge modules (`idle.ts`,
 * `state.ts`, `tmux.ts`); they survive the stream-json switch because they read
 * the `/tmp` sid pointer and the transcript-locating files, which the broker
 * now writes. Collected here so the transport-specific modules could be deleted
 * without dragging these utilities down with them.
 */

import { readFileSync, statSync } from 'node:fs'

import { sidFile } from '../../persistence/paths'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'

/** Trim trailing newlines without touching the rest of the string. */
export function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Read a file only if it exists and is non-empty (`tm`'s `[[ -s file ]]`). */
export function readIfNonEmpty(path: string): string | null {
  try {
    if (statSync(path).size === 0) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A teammate's current session id, or `null` when the pointer is missing. */
export function readSid(name: TeammateName): string | null {
  const raw = readIfNonEmpty(sidFile(name))
  return raw === null ? null : rstrip(raw)
}

/** The standard `tm: <message>` error result. */
export function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}
