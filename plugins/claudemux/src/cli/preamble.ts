/**
 * `tm spawn` prompt preamble (issue #25).
 *
 * An operator who dispatches teammates into the same repo over and over
 * often hand-pastes the same standing first-turn reminder into every
 * `--prompt`. The preamble mechanism lets that reminder live in one
 * per-dispatcher profile file and ride on the dispatch automatically.
 *
 * The feature is opt-in: with no profile file the resolver is a no-op and
 * `tm spawn` behaves exactly as before. When a profile is present, a fresh
 * `tm spawn --prompt` looks up the entry for the resolved repo path
 * (falling back to a dispatcher-wide `default`) and the CLI prepends it to
 * the operator's `--prompt`. `--no-preamble` opts a single spawn out, and
 * is the escape hatch even when the profile file is malformed.
 *
 * The profile is keyed by repo path, matching what `tm` records as a
 * teammate's `repo` (the `realpath`-resolved source repo). Keys are
 * `realpath`-normalised on read so a profile written with a symlinked path
 * still matches the canonical path the spawn resolves — otherwise the
 * lookup would silently miss and the reminder would be dropped, which is
 * exactly the failure this feature exists to prevent.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { die } from './errors'
import type { TmResult } from '../tm'

/**
 * The per-dispatcher preamble profile: `<dispatcherDir>/.tm-preamble.json`.
 * Named builder so the on-disk shape lives in one place rather than being
 * concatenated at the use site (repo CLAUDE.md path-builder discipline).
 */
export function preambleProfilePath(dispatcherDir: string): string {
  return join(dispatcherDir, '.tm-preamble.json')
}

/** The on-disk shape of `.tm-preamble.json`. */
interface PreambleProfile {
  /** Dispatcher-wide default, used when no per-repo entry matches. */
  readonly default?: unknown
  /** Per-repo preambles, keyed by the repo's `realpath`-resolved path. */
  readonly repos?: Record<string, unknown>
}

/** Trim only trailing whitespace, so a multi-line preamble keeps its shape. */
function trimEnd(text: string): string {
  return text.replace(/\s+$/, '')
}

/** A profile entry counts only when it is a non-empty (post-trim) string. */
function usableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = trimEnd(value)
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Best-effort `realpath` of a profile's repo key so a key written with a
 * symlinked path still matches the canonical `repo`. A key that does not
 * resolve (stale path, typo) falls back to its literal form.
 */
function normalizeKey(key: string): string {
  try {
    return realpathSync(key)
  } catch {
    return key
  }
}

/**
 * Resolve the preamble for a fresh `tm spawn` into `repo`.
 *
 *  - No profile file (`ENOENT`) → `{ preamble: null }` (feature is opt-in;
 *    no-op).
 *  - Profile present but unreadable / a directory / invalid JSON / wrong
 *    top-level shape → `{ error }` (fail loud: the operator put something
 *    there, so a silently dropped reminder is worse than a clear config
 *    error they can fix).
 *  - Per-repo entry present → that text wins. An explicit empty entry opts
 *    that repo out (returns `null`) without falling through to `default`.
 *  - Otherwise → the dispatcher-wide `default`, or `null` when absent.
 *
 * `repo` is the spawn's `realpath`-resolved source repo (what `tm` records
 * as the teammate's `repo`); profile keys are normalised the same way.
 */
export function resolvePreamble(
  dispatcherDir: string,
  repo: string,
): { preamble: string | null } | { error: TmResult } {
  const path = preambleProfilePath(dispatcherDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // A genuinely missing file is the opt-out-by-default case — a true
    // no-op. Any other read error (unreadable, a directory, …) means the
    // operator put something there, so fail loud rather than silently
    // dropping the reminder they opted in to.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { preamble: null }
    }
    const reason = err instanceof Error ? err.message : String(err)
    return {
      error: die(
        `tm spawn: ${path} could not be read (${reason}). ` +
          'Fix it or pass --no-preamble.',
      ),
    }
  }

  let profile: PreambleProfile
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        error: die(
          `tm spawn: ${path} must be a JSON object ` +
            '({ "default": "…", "repos": { "<repo>": "…" } }). ' +
            'Fix it or pass --no-preamble.',
        ),
      }
    }
    profile = parsed as PreambleProfile
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      error: die(
        `tm spawn: ${path} is not valid JSON (${reason}). ` +
          'Fix it or pass --no-preamble.',
      ),
    }
  }

  const repos = profile.repos
  if (repos !== undefined && repos !== null && typeof repos === 'object') {
    for (const key of Object.keys(repos)) {
      if (normalizeKey(key) === repo) {
        // An explicit (even empty) per-repo entry is authoritative: a blank
        // value opts the repo out rather than falling back to `default`.
        return { preamble: usableText(repos[key]) }
      }
    }
  }

  return { preamble: usableText(profile.default) }
}

/**
 * Prepend a resolved preamble to the operator's prompt. The blank line keeps
 * the standing reminder visually distinct from the hand-off it rides on.
 */
export function applyPreamble(preamble: string, prompt: string): string {
  return `${preamble}\n\n${prompt}`
}
