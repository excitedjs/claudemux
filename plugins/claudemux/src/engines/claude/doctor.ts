/**
 * `tm doctor` — a read-only environment self-check. Sections fire top-down: the
 * `tm` executable, the dispatcher dir, the `claude` binary, the stream-json
 * brokers, and the codex teammates. Soft-fails throughout (every probe is
 * guarded) and always exits 0; output is meant to be eyeballed, not parsed.
 *
 * The path the "tm executable" section reports is the `<plugin-root>/bin/tm`
 * launcher, resolved by the caller (`tmWrapper`, `pluginJson`) because the
 * relative-`../..` computation must be done from a file one directory inside
 * the plugin root, not from here three directories deeper.
 */

import { readFileSync, statSync } from 'node:fs'

import { die, isDirectory } from './fs-util'
import { fmtLocalDateTime } from './clock'
import { claudeBinary } from './stream-json/launch'
import { listLiveBrokers, readBrokerPid, readMeta } from './stream-json/registry'
import { spawnCapture } from '../../proc'
import {
  isProcessAlive as codexProcessAlive,
  listDaemons as listCodexDaemons,
  readDaemonState as readCodexState,
  reapDaemon as reapCodexDaemon,
} from '../codex/supervisor'
import { removeBaseRecord as removeCodexBaseRecord } from '../codex/persistence'
import type { TmResult } from '../../tm'

export interface DoctorPaths {
  /** Absolute path to the `<plugin-root>/bin/tm` launcher. */
  tmWrapper: string
  /** Absolute path to `<plugin-root>/.claude-plugin/plugin.json`. */
  pluginJson: string
  /** Resolved dispatcher dir. */
  dispatcherDir: string
}

export async function claudeDoctor(args: readonly string[], paths: DoctorPaths): Promise<TmResult> {
  if (args.length > 0) return die(`tm doctor: takes no arguments (got: ${args.join(' ')})`)

  const kv = (label: string, value: string): string => `  ${`${label}:`.padEnd(20, ' ')}${value}\n`
  let out = ''

  // --- tm executable ---
  const { tmWrapper, pluginJson, dispatcherDir } = paths
  let version = 'unknown'
  let pluginJsonPresent = false
  try {
    if (statSync(pluginJson).isFile()) {
      pluginJsonPresent = true
      const parsed = JSON.parse(readFileSync(pluginJson, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) version = parsed.version
    }
  } catch {
    pluginJsonPresent = false
  }
  out += 'tm executable:\n'
  out += kv('path', tmWrapper)
  out += kv('version', version)
  if (!pluginJsonPresent) out += kv('note', `plugin.json not found at ${pluginJson}`)
  out += '\n'

  // --- dispatcher dir ---
  out += 'dispatcher dir:\n'
  out += kv('resolved', dispatcherDir)
  const envSet = process.env.TM_DISPATCHER_DIR
  out += kv('TM_DISPATCHER_DIR', envSet !== undefined && envSet.length > 0 ? `set (= ${envSet})` : 'unset — falling back to $PWD (run /claudemux:setup to inoculate against cwd drift)')
  const pwd = process.cwd()
  out += kv('$PWD', pwd)
  out += kv('status', dispatcherDir !== pwd ? 'DIVERGED — dispatcher dir != $PWD; env override keeps tm correct despite the drifted PWD' : 'matched')
  if (!isDirectory(dispatcherDir)) out += kv('warning', `${dispatcherDir} does not exist as a directory`)
  out += '\n'

  // --- claude binary (stream-json transport) ---
  out += 'claude binary:\n'
  const bin = claudeBinary(process.env)
  out += kv('resolved', bin)
  try {
    const v = await spawnCapture([bin, '--version'])
    if (v.code === 0) out += kv('version', (v.stdout.split('\n')[0] ?? '?').trim())
    else out += kv('installed', `probe exited ${v.code} — is '${bin}' a working claude install?`)
  } catch {
    out += kv('installed', `no ('${bin}' not on PATH — set CLAUDEMUX_CLAUDE or install Claude Code)`)
  }
  out += '\n'

  // --- stream-json brokers ---
  out += 'claude teammates (stream-json):\n'
  const brokers = listLiveBrokers()
  if (brokers.length === 0) {
    out += "  (none — use 'tm spawn <repo>' to launch one)\n"
  } else {
    out += kv('count', String(brokers.length))
    for (const name of brokers) {
      const meta = readMeta(name)
      const pid = readBrokerPid(name)
      const started = meta !== null ? `, started ${fmtLocalDateTime(meta.startedAt)}` : ''
      out += `  ${name} (pid=${pid ?? '?'}${started})\n`
    }
  }
  out += '\n'

  // --- codex teammates ---
  out += 'codex teammates:\n'
  const codexNames = listCodexDaemons()
  if (codexNames.length === 0) {
    out += "  (none — use 'tm spawn <name> --engine codex' to launch one)\n"
  } else {
    const reaped: string[] = []
    const live: { name: string; pid: number; startedAt: number }[] = []
    for (const name of codexNames) {
      const state = readCodexState(name)
      if (state === null || !codexProcessAlive(state.pid)) {
        reaped.push(name)
        await reapCodexDaemon(name)
        removeCodexBaseRecord(name)
      } else {
        live.push({ name, pid: state.pid, startedAt: state.startedAt })
      }
    }
    out += kv('count', String(live.length))
    for (const t of live) out += `  ${t.name} (pid=${t.pid}, started ${fmtLocalDateTime(t.startedAt)})\n`
    if (reaped.length > 0) {
      out += kv('reaped orphans', String(reaped.length))
      for (const name of reaped) out += `  ${name}\n`
    }
  }

  return { code: 0, stdout: out, stderr: '' }
}
