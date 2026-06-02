/**
 * `tm poll <name> <regex> [timeout]` — block until a teammate's latest reply
 * text matches a regex, or a timeout elapses (a diagnostic verb).
 *
 * The headless stream-json transport has no pane to scrape, so the match runs
 * against the broker's latest assistant text (`.last`, surfaced over the broker
 * socket) rather than a `capture-pane` buffer. The match itself still delegates
 * to the real `grep -E`, the way `states` delegates alignment to `column`.
 *
 * Claude-only at the verb level: a Codex teammate has no broker socket here, so
 * `tm poll codex-1 …` falls through to the no-teammate error.
 */

import { isNonNegativeInteger, sleepMs } from '../engines/claude/clock'
import { brokerRequest } from '../engines/claude/stream-json/client'
import { brokerAlive } from '../engines/claude/stream-json/registry'
import type { TmResult } from '../tm'
import type { GrepRunner } from '../grep'

export interface PollEnv {
  readonly runGrep: GrepRunner
}

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

export async function pollVerb(args: readonly string[], env: PollEnv): Promise<TmResult> {
  const name = args[0] ?? ''
  const pattern = args[1] ?? ''
  if (name === '' || pattern === '') {
    return die('usage: tm poll <name> <regex> [timeout=180]')
  }
  // `||`, not `??`: `tm`'s `${3:-180}` also defaults on an empty-string arg.
  const timeoutArg = args[2] || '180'
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: '', stderr: '' }

  if (!brokerAlive(name)) return die(`no running teammate '${name}'`)

  const end = Math.floor(Date.now() / 1000) + Number(timeoutArg)
  while (Math.floor(Date.now() / 1000) < end) {
    const res = await brokerRequest(name, { op: 'last' })
    if (res.ok && res.kind === 'last' && (await env.runGrep(pattern, res.text)) === 0) {
      return { code: 0, stdout: `matched: ${pattern}\n`, stderr: '' }
    }
    await sleepMs(3000)
  }
  return { code: 1, stdout: '', stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${name}\n` }
}
