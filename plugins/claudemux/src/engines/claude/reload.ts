/**
 * `tm reload` — fan `/reload-plugins` out to one, many, or all teammates.
 *
 * Over the stream-json broker each `/reload-plugins` is one user turn: the
 * broker submits it and the `claude` child reloads its plugin set. `--all`
 * enumerates the live brokers from the registry.
 */

import { die } from './fs-util'
import { brokerRequest } from './stream-json/client'
import { brokerAlive, listLiveBrokers } from './stream-json/registry'
import type { TmResult } from '../../tm'

export async function claudeReload(args: readonly string[]): Promise<TmResult> {
  let all = false
  const names: string[] = []
  for (const arg of args) {
    if (arg === '--all') all = true
    else if (arg === '-h' || arg === '--help') return die('usage: tm reload <name>... | --all')
    else if (arg.startsWith('-')) return die(`tm reload: unknown flag: ${arg}`)
    else names.push(arg)
  }

  if (all) {
    if (names.length > 0) return die('tm reload: --all conflicts with explicit names')
    names.push(...listLiveBrokers())
    if (names.length === 0) return { code: 0, stdout: '(no running teammates to reload)\n', stderr: '' }
  } else if (names.length === 0) {
    return die('usage: tm reload <name>... | --all')
  }

  let stdout = ''
  for (const name of names) {
    stdout += `→ ${name}: /reload-plugins\n`
    if (!brokerAlive(name)) return { code: 1, stdout, stderr: `tm: no running teammate '${name}'\n` }
    const res = await brokerRequest(name, { op: 'send', prompt: '/reload-plugins', timeoutMs: null })
    if (!res.ok) return { code: 1, stdout, stderr: `tm: reload '${name}' failed: ${res.message}\n` }
  }
  return { code: 0, stdout, stderr: '' }
}
