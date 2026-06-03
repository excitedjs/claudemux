/**
 * Real probe implementations for {@link collectDiagnosis} (see `./doctor`).
 *
 * Every function here is the OS / disk / socket boundary the pure check core is
 * kept away from, so the core stays testable with fakes. Each probe is
 * fail-soft: it returns `null` / `undefined` / `[]` on any failure rather than
 * throwing, mirroring the discipline in `./holder-probe` — a probe that cannot
 * read its target reports "unknown", never crashes the diagnosis.
 *
 * The status probe is deliberately a transient, read-only, no-register socket
 * read: it never sends a `register` frame, so it adds no session, triggers no
 * ownership side-effect, and spawns nothing. Both the MCP tool and the CLI use
 * it, so neither entry mutates the scene it is diagnosing.
 */

import { readFileSync, existsSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { probeDaemonSocketInfo } from './daemon-lock'
import {
  classifyInstallSource,
  type DaemonHello,
  type DoctorDeps,
  type LockHolder,
  type PinnedInstall,
  type RunBy,
  type ServerProcess,
  type StateDirHealth,
  type StatusSnapshot,
} from './doctor'
import { enumerateProcesses, probeProcess, readProcessCwd } from './holder-probe'
import { FrameDecoder, encodeFrame, type DaemonToProxy, type ProxyToDaemon } from './ipc'
import {
  accessFile,
  daemonInboundQueueFile,
  daemonSocketFile,
  envFile,
  lockFile,
  stateDir,
} from './paths'

/** Default timeout for the read-only status socket read. */
const STATUS_PROBE_TIMEOUT_MS = 1_500

/** How the doctor is being run; the rest is derived from the state dir. */
export interface DefaultDoctorDepsOptions {
  runBy: RunBy
  verbose: boolean
  /** State dir root; defaults to `stateDir()`. Injected by tests. */
  baseDir?: string
}

/** Wire the real probes into a {@link DoctorDeps} for production use. */
export function defaultDoctorDeps(opts: DefaultDoctorDepsOptions): DoctorDeps {
  const base = opts.baseDir ?? stateDir()
  const socketPath = daemonSocketFile(base)
  return {
    now: () => Date.now(),
    platform: process.platform,
    stateDir: base,
    runBy: opts.runBy,
    verbose: opts.verbose,
    probeHello: () => probeHello(socketPath),
    probeStatus: () => probeChannelStatus(socketPath),
    readPinnedInstall: () => readPinnedInstall(),
    readManifestVersionAt: (dir) => readManifestVersionAt(dir),
    readConnectionLockHolder: () => readConnectionLockHolder(lockFile(base)),
    enumerateServers: () => enumerateServers(),
    isPidAlive: (pid) => isPidAlive(pid),
    readStateDirHealth: () => readStateDirHealth(base),
    socketExists: () => existsSync(socketPath),
  }
}

/** The daemon's `hello` greeting, or `null` when no daemon answers. */
async function probeHello(socketPath: string): Promise<DaemonHello | null> {
  const info = await probeDaemonSocketInfo(socketPath)
  if (!info) return null
  return {
    daemonVersion: info.daemonVersion,
    generation: info.generation,
    ...(info.pid !== undefined ? { pid: info.pid } : {}),
  }
}

/**
 * Read `feishu_channel_status` over a transient connection that never registers.
 * Connects, waits for the daemon's `hello`, sends one `feishu_channel_status`
 * tool frame, parses the returned JSON, and disconnects. Resolves `null` on any
 * failure or timeout — including no daemon listening.
 */
export function probeChannelStatus(
  socketPath: string,
  timeoutMs = STATUS_PROBE_TIMEOUT_MS,
): Promise<StatusSnapshot | null> {
  return new Promise<StatusSnapshot | null>((resolve) => {
    const decoder = new FrameDecoder<DaemonToProxy>()
    let settled = false
    const done = (value: StatusSnapshot | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    const socket = connect(socketPath)
    socket.on('error', () => done(null))
    socket.on('data', (chunk: Buffer) => {
      let messages: DaemonToProxy[]
      try {
        messages = decoder.push(chunk)
      } catch {
        return done(null)
      }
      for (const m of messages) {
        if (m.t === 'hello') {
          // The status tool needs no registration: it reads only the connection
          // set, never caller.session, so an unregistered probe gets the full
          // status and contributes no session of its own.
          const call: ProxyToDaemon = { t: 'tool', id: 1, name: 'feishu_channel_status', args: {} }
          socket.write(encodeFrame(call))
        } else if (m.t === 'tool_result' && m.id === 1) {
          if (!m.ok) return done(null)
          return done(parseStatusResult(m.result))
        }
      }
    })
  })
}

/** Parse the `CallToolResult` a `feishu_channel_status` call returns into a snapshot. */
function parseStatusResult(result: unknown): StatusSnapshot | null {
  // The daemon wraps status as a CallToolResult: { content: [{ type, text }] }.
  if (typeof result !== 'object' || result === null) return null
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  const first = content[0]
  const text = first && typeof first === 'object' ? (first as { text?: unknown }).text : undefined
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text) as StatusSnapshot
  } catch {
    return null
  }
}

/** Claude Code's plugin config dir: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
function pluginsConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR
  const root = configured && configured.length > 0 ? configured : join(homedir(), '.claude')
  return join(root, 'plugins')
}

/**
 * The pinned feishu-channel install from Claude Code's installer record. The
 * file path and shape are an Anthropic-controlled contract, so this is
 * best-effort: a missing/unparseable file, or a dev source with no record,
 * yields `null` (the check then reports `unknown`, not a fault).
 */
export function readPinnedInstall(): PinnedInstall | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(pluginsConfigDir(), 'installed_plugins.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  // The installer keys plugins under a top-level `plugins` map; tolerate a flat
  // root too, since the file's shape is an Anthropic-controlled contract.
  const nested = (parsed as { plugins?: unknown }).plugins
  const record =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : (parsed as Record<string, unknown>)
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('feishu-channel@')) continue
    const entry = Array.isArray(value) ? value[0] : value
    if (typeof entry !== 'object' || entry === null) continue
    const version = (entry as { version?: unknown }).version
    const installPath = (entry as { installPath?: unknown }).installPath
    if (typeof version === 'string' && typeof installPath === 'string') {
      return { version, installPath }
    }
  }
  return null
}

/** Read the `version` from a plugin manifest at `dir`, or `undefined` on any failure. */
export function readManifestVersionAt(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Read the legacy inbound lock (`connection.lock`) holder, or `null` when no lockfile. */
export function readConnectionLockHolder(path: string): LockHolder | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  const alive = isPidAlive(pid)
  const probe = alive ? probeProcess(pid) : undefined
  const holder: LockHolder = { pid, alive }
  if (probe) {
    holder.command = probe.command
    holder.cwd = probe.cwd
  }
  return holder
}

/**
 * Enumerate and classify the feishu-channel `server.ts` processes. A match needs
 * the `server.ts` entry AND a feishu-channel signal (the command or the cwd
 * references a feishu-channel install) so an unrelated `server.ts` is not
 * mistaken for the channel; a match with a resolved install dir is high
 * confidence, an argv-only match is low.
 */
export function enumerateServers(): ServerProcess[] {
  const out: ServerProcess[] = []
  for (const row of enumerateProcesses()) {
    if (!row.command.includes('server.ts')) continue
    const cwd = readProcessCwd(row.pid)
    const cwdLooksChannel = cwd !== undefined && /feishu-channel/.test(cwd)
    const cmdLooksChannel = row.command.includes('feishu-channel')
    if (!cwdLooksChannel && !cmdLooksChannel) continue
    const installDir = cwd && classifyInstallSource(cwd) !== 'unknown' ? cwd : installDirFromCommand(row.command)
    const source = installDir ? classifyInstallSource(installDir) : 'unknown'
    const proc: ServerProcess = {
      pid: row.pid,
      ppid: row.ppid,
      command: row.command,
      kind: row.command.includes('--daemon') ? 'daemon' : 'proxy',
      source,
      confidence: installDir ? 'high' : 'low',
    }
    if (cwd !== undefined) proc.cwd = cwd
    if (installDir !== undefined) {
      proc.installDir = installDir
      const v = readManifestVersionAt(installDir)
      if (v !== undefined) proc.manifestVersion = v
    }
    out.push(proc)
  }
  return collapseWrappers(out)
}

/**
 * Drop wrapper parents from the matched set. `tsx src/server.ts` runs as a
 * launcher process (`.../.bin/tsx ...`) that forks the real worker (`node
 * --require .../tsx/loader ... src/server.ts`); both carry `server.ts` in their
 * argv, so a single logical server appears twice. A matched process that is the
 * parent of another matched process is the wrapper — keep the leaf (the worker,
 * which is the one that binds the socket), drop the parent. Without this, one
 * daemon reads as two and daemon-singleton false-positives.
 */
export function collapseWrappers(procs: ServerProcess[]): ServerProcess[] {
  const pids = new Set(procs.map((p) => p.pid))
  const parents = new Set(procs.map((p) => p.ppid).filter((ppid) => pids.has(ppid)))
  return procs.filter((p) => !parents.has(p.pid))
}

/** Pull a feishu-channel install dir out of a command line, when one is present. */
function installDirFromCommand(command: string): string | undefined {
  const cache = /(\/[^\s]*\/cache\/[^/]+\/feishu-channel\/[^/\s]+)/.exec(command)
  if (cache) return cache[1]
  const market = /(\/[^\s]*\/marketplaces\/[^/]+\/plugins\/feishu-channel)(?=[/\s]|$)/.exec(command)
  if (market) return market[1]
  return undefined
}

/**
 * Inspect the state dir's health WITHOUT reading any secret value: only the
 * presence of the credential KEYS in `.env`, and whether `access.json` and the
 * inbound queue parse.
 */
export function readStateDirHealth(base: string): StateDirHealth {
  const env = readEnvKeys(envFile(base))
  return {
    envPresent: env.present,
    hasAppId: env.hasAppId,
    hasAppSecret: env.hasAppSecret,
    accessParse: parseState(accessFile(base), 'json'),
    queueParse: parseState(daemonInboundQueueFile(base), 'jsonl'),
  }
}

/**
 * Read which credential keys are present AND non-empty in `.env`, never the
 * values. An empty assignment (`FEISHU_APP_ID=`) is reported as missing — the
 * channel cannot connect on a blank credential, so a present-but-empty key must
 * not read as set.
 */
function readEnvKeys(path: string): { present: boolean; hasAppId: boolean; hasAppSecret: boolean } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { present: false, hasAppId: false, hasAppSecret: false }
  }
  let hasAppId = false
  let hasAppSecret = false
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1]
    // Mirror readEnvFile's quote-stripping so a `KEY=""` is also seen as empty.
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (value.length === 0) continue
    if (key === 'FEISHU_APP_ID') hasAppId = true
    if (key === 'FEISHU_APP_SECRET') hasAppSecret = true
  }
  return { present: true, hasAppId, hasAppSecret }
}

/** Classify a state file as parseable / missing / corrupt without surfacing its contents. */
function parseState(path: string, kind: 'json' | 'jsonl'): 'ok' | 'missing' | 'corrupt' {
  if (!existsSync(path)) return 'missing'
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return 'corrupt'
  }
  try {
    if (kind === 'json') {
      JSON.parse(text)
    } else {
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) JSON.parse(line)
      }
    }
    return 'ok'
  } catch {
    return 'corrupt'
  }
}

/**
 * Whether `pid` is a live process. Signal 0 runs the kernel's existence check
 * without delivering a signal: success → alive, `EPERM` → alive but not ours to
 * signal, anything else → gone.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
