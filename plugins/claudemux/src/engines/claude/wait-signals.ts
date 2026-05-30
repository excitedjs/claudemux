/**
 * `tm`'s `_wait_idle_signal` and `_wait_pane_quiet` — the two block-
 * until-the-turn-ends primitives `tm send` and `tm wait` compose. The
 * idle-marker path is the primary signal; pane-quiet is a fallback for
 * sessions whose Stop hook is not loaded.
 */

import { existsSync, statSync } from 'node:fs'

import { clearIdle, resolveSidOrDie, resolveSid, isRegularFile } from './idle'
import { busyMarkerFor, idleMarkerFor, sendAtFile } from '../../persistence/paths'
import { requireSession, resolvePaneTarget } from './tmux'
import { nowSec, sleepMs } from './clock'
import { terminalAssistantAfter, userEntryAppearedAfter } from './turn-jsonl'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'
import type { TmuxRunner } from '../../tmux'

/**
 * A turn's JSONL anchor — the transcript path and the byte offset
 * snapshotted at send time. `tm send` passes this so the submit
 * confirmation and the wait can read only the region appended by THIS
 * turn (never a prior turn's settled entry). `jsonl` is `null` when the
 * transcript path could not be resolved (no recorded cwd / sid), in
 * which case the JSONL-side checks are skipped and the marker-based
 * behavior stands alone.
 */
export interface TurnAnchor {
  readonly jsonl: string | null
  readonly sinceBytes: number
}

/**
 * Total budget (ms) for `confirmSubmit`. Override via
 * `CLAUDEMUX_CONFIRM_SUBMIT_MS`; `0` disables confirmation entirely
 * (the conformance harness and the sync-wait tests set it so a synthetic
 * "send succeeded, wait expires" scenario is not held up — or reshaped —
 * by submit confirmation). Default 4s: a real submission's turn-start
 * signal (the on-busy marker, or the prompt's user entry in the jsonl)
 * lands well under a second, so the budget is a ceiling for the
 * not-submitted case, not a cost every send pays.
 */
function confirmSubmitBudgetMs(): number {
  const raw = process.env['CLAUDEMUX_CONFIRM_SUBMIT_MS']
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 4000
}

/**
 * After `tm send` injects a prompt + Enter, verify the REPL actually
 * accepted it as a turn — rather than the Enter being swallowed by a
 * modal (the bug #2 class) and the prompt text discarded. "Accepted" is
 * any of: the on-busy hook set the `.busy` marker, the idle marker
 * reappeared (a fast turn already ended), or a new user entry landed in
 * the transcript past the send offset (hook-independent). When none of
 * those appears within an attempt's slice, re-send Enter (the common
 * "the first Enter did not register" case) and recheck, up to 3
 * attempts. Returns `{ ok: true }` on confirmation; otherwise a warning
 * the caller prepends to stderr — `tm send` then PROCEEDS to the wait
 * (which expires to 124 if the turn truly never runs), so confirmation
 * never converts a working-but-slow send into a hard failure.
 */
export async function confirmSubmit(
  name: TeammateName,
  anchor: TurnAnchor,
  runTmux: TmuxRunner,
): Promise<{ ok: true } | { ok: false; warn: string }> {
  const totalMs = confirmSubmitBudgetMs()
  if (totalMs <= 0) return { ok: true }

  const submitted = (): boolean => {
    const sid = resolveSid(name)
    if (sid !== null && (isRegularFile(busyMarkerFor(sid)) || existsSync(idleMarkerFor(sid)))) {
      return true
    }
    return anchor.jsonl !== null && userEntryAppearedAfter(anchor.jsonl, anchor.sinceBytes)
  }

  const attempts = 3
  const tickMs = 200
  const ticksPerAttempt = Math.max(1, Math.round(totalMs / attempts / tickMs))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (let tick = 0; tick < ticksPerAttempt; tick++) {
      if (submitted()) return { ok: true }
      await sleepMs(tickMs)
    }
    if (attempt < attempts) {
      // Re-send Enter best-effort. Targets the resolved pane so a
      // prefix-match cannot wrong-route; a failure here is swallowed —
      // the next attempt's poll (or the final warning) covers it.
      try {
        const pane = await resolvePaneTarget(name, runTmux)
        if (pane !== '') await runTmux(['send-keys', '-t', pane, 'Enter'])
      } catch {
        // ignore — best-effort retry.
      }
    }
  }
  if (submitted()) return { ok: true }
  return {
    ok: false,
    warn:
      `tm send: ${name}: no turn-start signal after re-sending Enter ` +
      `${attempts - 1}x in ~${Math.round(totalMs / 1000)}s — the prompt may not have ` +
      `landed (the REPL may be at a modal, or the turn is very slow to start). ` +
      `Proceeding to wait; if no reply arrives, check 'tm status ${name}'.\n`,
  }
}

/** Which signal ended the turn — the Stop-hook idle marker, or the transcript. */
export type TurnEndSignal = 'marker' | 'jsonl'

/**
 * Block until the teammate's turn ends, by either signal: the Stop-hook
 * idle marker `/tmp/claude-idle/<sid>` (the primary path), OR — when the
 * transcript path resolved — a settled assistant entry appended past the
 * send offset (`terminalAssistantAfter`). The JSONL branch is the
 * no-hook fallback: a session whose Stop hook never fired still unblocks
 * here once its turn reaches a terminal stop_reason on disk, instead of
 * burning the full timeout to a 124. When `jsonl` is `null` the JSONL
 * branch never trips, so this is byte-for-byte `waitIdleSignal`.
 *
 * On success it reports WHICH signal ended the turn (`via`). The caller
 * needs this: on `via: 'marker'` the Stop hook already wrote `<sid>.last`
 * (it writes `.last` before touching the idle marker), but on
 * `via: 'jsonl'` no hook ran, so `.last` is absent and the reply must be
 * recovered from the transcript. This function itself stays read-only.
 */
export async function waitForTurnEnd(
  name: TeammateName,
  timeoutSec: number,
  fresh: boolean,
  runTmux: TmuxRunner,
  anchor: TurnAnchor,
): Promise<TmResult | { ok: true; via: TurnEndSignal } | { ok: false }> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(name)
  if ('error' in sidR) return sidR.error
  if (fresh) clearIdle(sidR.sid)

  const end = nowSec() + timeoutSec
  const marker = idleMarkerFor(sidR.sid)
  while (nowSec() < end) {
    if (existsSync(marker)) return { ok: true, via: 'marker' }
    if (anchor.jsonl !== null && terminalAssistantAfter(anchor.jsonl, anchor.sinceBytes)) {
      return { ok: true, via: 'jsonl' }
    }
    await sleepMs(3000)
  }
  return { ok: false }
}

/**
 * Re-probe a teammate's liveness at the moment a sync wait is about to
 * declare 124 ("expired, still running"). Two failure modes count as DEAD
 * here — the dispatcher MUST distinguish "TM dropped during the wait" from
 * "TM is alive and slow":
 *
 *  - The tmux session is gone (manual `tm kill`, crash, terminal closed).
 *  - The `.sid` file is gone (a fresh `tm spawn` would have rewritten it;
 *    its absence proves the teammate's bookkeeping was torn down).
 *
 * Returns `null` when the teammate looks alive (the caller proceeds to its
 * 124 path), or a `TmResult` with exit 1 + a death-flavored stderr line
 * the caller can prepend to its own context. The 124 contract is "still
 * running, re-collect with `tm wait`"; promising that on a dead teammate
 * is exactly the bg-classifier failure mode this whole PR exists to fix,
 * just from the opposite direction — so every wait-expiry path runs this
 * probe before the 124 branch.
 */
export async function probeStillAlive(
  name: TeammateName,
  runTmux: TmuxRunner,
): Promise<TmResult | null> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) {
    return {
      code: 1,
      stdout: '',
      stderr:
        `tm: teammate '${name}' died during the wait — tmux session is gone. ` +
        `Respawn with 'tm spawn ${name}' (or 'tm resume') once you have a ` +
        `target. Original wait-expiry: ` +
        sessionMissing.stderr.replace(/^tm: /, '').trimEnd() +
        '\n',
    }
  }
  const sidR = resolveSidOrDie(name)
  if ('error' in sidR) {
    return {
      code: 1,
      stdout: '',
      stderr:
        `tm: teammate '${name}' died during the wait — sid marker disappeared ` +
        `(typically 'tm kill' run mid-wait). Respawn with 'tm spawn ${name}'. ` +
        `Original wait-expiry: ` +
        sidR.error.stderr.replace(/^tm: /, '').trimEnd() +
        '\n',
    }
  }
  return null
}

/**
 * `tm`'s `_wait_idle_signal`: block until `/tmp/claude-idle/<sid>`
 * exists, or `timeoutSec` elapses. Returns the resolved `TmResult` on
 * early-out (no-such-session / no-sid), or `{ ok }` once the loop has
 * its verdict.
 */
export async function waitIdleSignal(
  name: TeammateName,
  timeoutSec: number,
  fresh: boolean,
  runTmux: TmuxRunner,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(name)
  if ('error' in sidR) return sidR.error
  if (fresh) clearIdle(sidR.sid)

  const end = nowSec() + timeoutSec
  const marker = idleMarkerFor(sidR.sid)
  while (nowSec() < end) {
    if (existsSync(marker)) return { ok: true }
    await sleepMs(3000)
  }
  return { ok: false }
}

/**
 * `tm`'s `_wait_pane_quiet`: block until the teammate's pane has shown
 * no busy marker for ~4s AND at least 3s have passed since the last
 * send. Returns the resolved `TmResult` on early-out or `{ ok }` once
 * decided.
 */
export async function waitPaneQuiet(
  name: TeammateName,
  timeoutSec: number,
  runTmux: TmuxRunner,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(name, runTmux)
  if (sessionMissing !== null) return sessionMissing

  let sendAt = 0
  try {
    sendAt = Math.floor(statSync(sendAtFile(name)).mtimeMs / 1000)
  } catch {
    sendAt = 0
  }

  const end = nowSec() + timeoutSec
  let quietStreak = 0
  while (nowSec() < end) {
    const sid = resolveSid(name)
    const isBusy = sid !== null && isRegularFile(busyMarkerFor(sid))
    if (isBusy) quietStreak = 0
    else quietStreak += 1
    if (quietStreak >= 2 && nowSec() - sendAt >= 3) return { ok: true }
    await sleepMs(2000)
  }
  return { ok: false }
}
