/**
 * `tm send` — atomic round-trip by default: send a prompt, block on the
 * Stop hook (or pane-quiet fallback), print the reply to stdout.
 *
 * The stdout/stderr split is load-bearing for piping: status lines
 * (the "sent to ..." preamble, the post-turn ctx echo) ride stderr
 * exclusively.
 *
 * Two exported entry points keep the strangler clean:
 *   - `claudeSend(args, env)` — byte-exact `TmResult`, the cli dispatch
 *     and the conformance harness both pin to this shape.
 *   - the shared parser in `shared/verb-args.ts` is reused by `claudeReload`
 *     (which fans out by calling `claudeSend` directly).
 */

import { writeFileSync } from 'node:fs'

import { sendKeys } from './keys'
import { confirmSubmit, probeStillAlive, waitForTurnEnd, waitPaneQuiet } from './wait-signals'
import { echoCtxToStderr, printLastOrEmpty } from './post-turn'
import { transcriptFile } from './ctx'
import { lastAssistantTextAfter, transcriptSizeBytes } from './turn-jsonl'
import { readIfNonEmpty, resolveSid, rstrip } from './idle'
import { cwdFile, lastFileFor } from '../../persistence/paths'
import { die } from './tmux'
import { isNonNegativeInteger } from './clock'
import { parseSendArgs } from '../../shared/verb-args'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

/**
 * The Claude-side `tm send` body. The wrapper at the CLI layer handles
 * the codex fork; this function is Claude-only.
 */
export async function claudeSend(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseSendArgs(args)
  if ('error' in parsed) return parsed.error
  const { name, prompt, hasPrompt, paneQuiet, timeout } = parsed
  if (name === '') {
    return die(
      'tm send: missing <name>. Usage: tm send <name> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (!hasPrompt) {
    return die(
      'tm send: missing --prompt. Usage: tm send <name> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (timeout !== null && !isNonNegativeInteger(timeout)) {
    return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  // Snapshot the transcript offset BEFORE sending so submit-confirmation
  // and the JSONL wait fallback only read what THIS turn appends — never
  // a prior turn's settled entry. `null` when the transcript path cannot
  // be resolved (no recorded cwd/sid); the JSONL-side checks then no-op
  // and the marker-based behavior stands alone.
  const sid0 = resolveSid(name)
  const cwdRaw = readIfNonEmpty(cwdFile(name))
  const cwd0 = cwdRaw === null ? null : rstrip(cwdRaw)
  const jsonl = sid0 !== null && cwd0 !== null ? transcriptFile(env.projectsDir, cwd0, sid0) : null
  const anchor = { jsonl, sinceBytes: jsonl !== null ? transcriptSizeBytes(jsonl) : 0 }

  const sentResult = await sendKeys(name, prompt, env.runTmux, process.env)
  if (sentResult.code !== 0) return sentResult

  // Confirm the prompt was accepted as a turn (not swallowed by a modal).
  // Warn-and-proceed only — never converts a slow-but-live send into a
  // failure; the wait below still expires to 124 if the turn never runs.
  // Pane-quiet covers TUI commands with no turn to confirm, so skip it.
  let confirmStderr = ''
  if (!paneQuiet) {
    const confirmed = await confirmSubmit(name, anchor, env.runTmux)
    if (!confirmed.ok) confirmStderr = confirmed.warn
  }

  const timeoutSec = timeout === null ? 1800 : Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(name, timeoutSec, env.runTmux)
    : await waitForTurnEnd(name, timeoutSec, false, env.runTmux, anchor)
  if ('code' in verdict) return { ...verdict, stderr: confirmStderr + verdict.stderr }
  if (!verdict.ok) {
    // Re-probe at the timeout moment: a teammate that died mid-wait must
    // NOT be reported as "still running" with code 124, or the dispatcher's
    // bg classifier will (correctly per the documented 124 contract)
    // decide not to respawn and silently wait forever on a corpse. Only
    // promise 124 ("still running") when the session + sid are still there.
    const dead = await probeStillAlive(name, env.runTmux)
    if (dead !== null) {
      return { ...dead, stderr: sentResult.stderr + confirmStderr + dead.stderr }
    }
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: EXIT_SYNC_WAIT_EXPIRED,
      stdout: printLastOrEmpty(name),
      stderr:
        sentResult.stderr +
        confirmStderr +
        `tm send: sync wait expired after ${timeoutSec}s on ${name} ` +
        `(no ${kind} fired; the teammate is still running — tail with ` +
        `'tm wait ${name}' or check 'tm status ${name}'). exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
    }
  }

  // No-hook JSONL fallback: the turn settled in the transcript but the
  // Stop hook never wrote `<sid>.last` (sendKeys' clearIdle wiped it at
  // send time and no hook repopulated it). Recover the reply from THIS
  // turn's appended region — scoped to the send offset, so a prior turn's
  // text is never surfaced — and persist it exactly as `tm spawn --resume`
  // seeds `.last`, so stdout AND `tm last` / `tm states` all surface the
  // reply instead of the "(no text reply...)" sentinel. A textless turn
  // (tool-only) writes an empty `.last`, clearing any stale value. The
  // marker path is left untouched: on-stop writes `.last` before touching
  // the idle marker, so `via: 'marker'` means `.last` is already current.
  if (!paneQuiet && 'via' in verdict && verdict.via === 'jsonl' && jsonl !== null && sid0 !== null) {
    const recovered = lastAssistantTextAfter(jsonl, anchor.sinceBytes)
    try {
      writeFileSync(lastFileFor(sid0), recovered !== null && recovered.length > 0 ? `${recovered}\n` : '')
    } catch {
      // Best-effort: printLastOrEmpty falls back to the sentinel if unwritten.
    }
  }

  let trailingStderr = ''
  if (!paneQuiet) trailingStderr = echoCtxToStderr(name, env)
  return {
    code: 0,
    stdout: printLastOrEmpty(name),
    stderr: sentResult.stderr + confirmStderr + trailingStderr,
  }
}
