/**
 * feishu-channel runtime self-diagnosis (`feishu_channel_doctor`).
 *
 * One pass over the channel's known runtime foot-guns — daemon/proxy version
 * skew, a stale server holding the inbound lock, multiple daemons contending for
 * the socket, channel ownership stolen by a teammate, and the broker handoff gap
 * — returning a structured, ranked report instead of the manual `ps` / `lsof` /
 * `grep installed_plugins.json` ritual.
 *
 * This module is the pure core: {@link collectDiagnosis} awaits a set of
 * injected probes (process enumeration, socket greeting, a read-only status
 * read, lockfile and disk reads) and runs the checks over the gathered evidence.
 * Every platform effect is a dependency, so the whole catalogue is unit-testable
 * with fakes and no live daemon. The real probe implementations and the default
 * wiring live in `./doctor-probes`.
 *
 * Two entries drive it (see `./server`): the proxy-local MCP tool
 * `feishu_channel_doctor` (reachable while the channel is up) and a `--doctor`
 * CLI (the authoritative entry for the daemon-unreachable / stale-socket /
 * stale-lock cases, since it registers no proxy and spawns nothing). Both share
 * this module and the same read-only, never-spawn probes.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { comparePluginVersions, isPluginVersion } from './version'

/** The MCP tool name; shared so the proxy can route it locally. */
export const DOCTOR_TOOL_NAME = 'feishu_channel_doctor'

/** The `feishu_channel_doctor` MCP tool definition. */
export const DOCTOR_TOOL: Tool = {
  name: DOCTOR_TOOL_NAME,
  description:
    'Diagnose the Feishu channel runtime in one pass: daemon/proxy version skew, a stale server holding the inbound lock, multiple daemons contending for the socket, channel ownership stolen by a teammate, and the broker handoff gap. Returns a ranked report of checks, each with severity, detail, and a remediation hint. Read-only; takes no required arguments. Runs inside the live session whose proxy, on startup, connects to (and may spawn) the daemon as normal — so to inspect a daemon-missing or stale-socket scene without disturbing it, run the CLI instead: `npm run doctor` in the plugin dir registers no proxy and spawns nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      verbose: {
        type: 'boolean',
        description: 'Attach raw evidence (pids, paths, version triples) to each check. Defaults to false.',
      },
    },
  },
}

/** Per-check outcome. `unknown` means a probe could not run — never a failure. */
export type Severity = 'ok' | 'warn' | 'error' | 'unknown'

/** Ordering for ranking the report worst-first and rolling up the summary. */
const SEVERITY_RANK: Record<Severity, number> = { error: 3, warn: 2, unknown: 1, ok: 0 }

/** One diagnosis result. */
export interface DoctorCheck {
  id: string
  title: string
  severity: Severity
  detail: string
  remediation: string
  /** Raw supporting data; attached only when the caller asked for verbose output. */
  evidence?: Record<string, unknown>
}

/** Identity of whatever code is running the diagnosis — the lens it is seen through. */
export interface RunBy {
  entry: 'proxy' | 'cli'
  /** Version of the running code (`pluginRoot()` of this process). */
  version: string | undefined
  /** Present only for the proxy entry. */
  sessionId?: string
}

/** The daemon's `hello` greeting on the socket. */
export interface DaemonHello {
  daemonVersion: string
  generation: number
  pid?: number
}

/** One registered proxy as reported by `feishu_channel_status`. */
export interface SessionInfo {
  sessionId: string
  pid: number
  proxyVersion: string
  role: 'dispatcher' | 'session'
  metadata: Record<string, string>
}

/** Authoritative daemon identity, present only when the daemon is new enough (see §5). */
export interface DaemonStatusBlock {
  version: string
  pid: number
  generation: number
  started_at: number
  launch_path: string
}

/** Parsed `feishu_channel_status` payload. */
export interface StatusSnapshot {
  owner_session_id: string | null
  dispatcher_session_id: string | null
  granted_session_id: string | null
  effective_target_session_id: string | null
  lease_epoch: number
  sessions: SessionInfo[]
  daemon?: DaemonStatusBlock
}

/** The pinned install as recorded by Claude Code's plugin installer. */
export interface PinnedInstall {
  version: string
  installPath: string
}

/** Where a feishu-channel install dir came from. */
export type InstallSource = 'cache' | 'marketplace' | 'unknown'

/** Holder of the legacy inbound lock (`connection.lock`). */
export interface LockHolder {
  pid: number
  alive: boolean
  /** Process command line, when it could be inspected. */
  command?: string
  /** Process cwd, when it could be inspected. */
  cwd?: string
}

/** A classified feishu-channel `server.ts` process. */
export interface ServerProcess {
  pid: number
  ppid: number
  command: string
  cwd?: string
  kind: 'daemon' | 'proxy' | 'unknown'
  installDir?: string
  manifestVersion?: string
  source: InstallSource
  /** `high` when an install dir corroborated the match; `low` when only argv matched. */
  confidence: 'high' | 'low'
}

/** Health of the on-disk state directory (never carries secret values). */
export interface StateDirHealth {
  envPresent: boolean
  hasAppId: boolean
  hasAppSecret: boolean
  /** `ok` parses, `missing` absent, `corrupt` present but unparseable. */
  accessParse: 'ok' | 'missing' | 'corrupt'
  queueParse: 'ok' | 'missing' | 'corrupt'
}

/** Everything {@link collectDiagnosis} needs; every platform effect is injected. */
export interface DoctorDeps {
  now: () => number
  platform: string
  stateDir: string
  runBy: RunBy
  verbose: boolean
  probeHello: () => Promise<DaemonHello | null>
  probeStatus: () => Promise<StatusSnapshot | null>
  readPinnedInstall: () => PinnedInstall | null
  readManifestVersionAt: (dir: string) => string | undefined
  readConnectionLockHolder: () => LockHolder | null
  enumerateServers: () => ServerProcess[]
  isPidAlive: (pid: number) => boolean
  readStateDirHealth: () => StateDirHealth
  /** Whether the daemon socket file exists on disk (distinguishes stale-socket from no-daemon). */
  socketExists: () => boolean
}

/** The full diagnosis report. */
export interface DoctorReport {
  schema_version: 1
  generated_at: number
  platform: string
  state_dir: string
  run_by: RunBy
  summary: { worst_severity: Severity; counts: Record<Severity, number> }
  checks: DoctorCheck[]
  limitations: string[]
}

/** Evidence gathered once, then handed to every (pure) check. */
interface Evidence {
  hello: DaemonHello | null
  status: StatusSnapshot | null
  pinned: PinnedInstall | null
  lockHolder: LockHolder | null
  servers: ServerProcess[]
  stateHealth: StateDirHealth | null
  socketExists: boolean
  /** Fail-soft wrappers for the per-input probes the checks call directly. */
  isPidAlive: (pid: number) => boolean
  readManifestVersionAt: (dir: string) => string | undefined
}

const LIMITATIONS = [
  'Scoped to one FEISHU_CHANNEL_STATE_DIR; a daemon launched under a different state dir has its own socket and connection.lock and is invisible to this run.',
  'The MCP tool runs inside a live session, whose proxy connects to (and may spawn) the daemon as normal startup behavior — so it cannot observe a daemon-missing or stale-socket scene without disturbing it. The diagnosis is also only as new as that proxy, which a resumed session keeps from when it started. For a current, daemon-independent, no-spawn diagnosis (and to inspect daemon-missing / stale-socket as found), run the CLI: `npm run doctor` from the pinned install registers no proxy and spawns nothing.',
  'broker-owner-handoff-gap relies on the launcher injecting CLAUDEMUX_CHANNEL_TRANSPORT so the proxy can self-report metadata.transport. When that env is absent (a teammate the spawner did not tag), the check degrades to an annotation rather than a positive detection.',
]

/**
 * Run the full diagnosis. Gathers evidence from the injected probes (each
 * fail-soft on its own), then evaluates every check over it and assembles a
 * ranked report. Never throws on a probe failure — a failed probe surfaces as an
 * `unknown` check.
 */
export async function collectDiagnosis(deps: DoctorDeps): Promise<DoctorReport> {
  const ev = await gather(deps)

  const checks: DoctorCheck[] = [
    checkDaemonReachable(ev),
    checkSocketStaleness(ev),
    checkVersionSkew(ev, deps),
    checkProxyVersionConsistency(ev),
    checkDaemonLaunchSource(ev, deps),
    checkPinnedVsDisk(ev),
    checkConnectionLock(ev),
    checkDaemonSingleton(ev),
    checkCoexistingServers(ev),
    checkOrphanServers(ev),
    checkOrphanProxies(ev),
    checkOwnershipOnTeammate(ev),
    checkBrokerOwnerHandoff(ev),
    checkStateDir(ev),
  ]

  const ranked = [...checks].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const counts: Record<Severity, number> = { ok: 0, warn: 0, error: 0, unknown: 0 }
  for (const c of checks) counts[c.severity] += 1
  if (!deps.verbose) for (const c of ranked) delete c.evidence

  return {
    schema_version: 1,
    generated_at: deps.now(),
    platform: deps.platform,
    state_dir: deps.stateDir,
    run_by: deps.runBy,
    summary: { worst_severity: worstOf(checks), counts },
    checks: ranked,
    limitations: LIMITATIONS,
  }
}

async function gather(deps: DoctorDeps): Promise<Evidence> {
  const [hello, status] = await Promise.all([
    safeAsync(deps.probeHello, null),
    safeAsync(deps.probeStatus, null),
  ])
  // Every per-input probe a check calls directly is wrapped here so a throwing
  // probe degrades that check to a falsy/undefined reading instead of crashing
  // the whole diagnosis — collectDiagnosis must never throw on a probe failure.
  return {
    hello,
    status,
    pinned: safeSync(deps.readPinnedInstall, null),
    lockHolder: safeSync(deps.readConnectionLockHolder, null),
    servers: safeSync(deps.enumerateServers, [] as ServerProcess[]),
    stateHealth: safeSync(deps.readStateDirHealth, null),
    socketExists: safeSync(deps.socketExists, false),
    isPidAlive: (pid) => safeSync(() => deps.isPidAlive(pid), false),
    readManifestVersionAt: (dir) => safeSync(() => deps.readManifestVersionAt(dir), undefined),
  }
}

function checkSocketStaleness(ev: Evidence): DoctorCheck {
  const id = 'socket-staleness'
  const title = 'No stale daemon socket file'
  if (!ev.socketExists) {
    return mk(id, title, 'ok', {
      detail: ev.hello ? 'Daemon socket is live.' : 'No daemon socket file (the daemon is simply not running).',
      remediation: 'No action needed.',
    })
  }
  if (ev.hello) {
    return mk(id, title, 'ok', {
      detail: 'Daemon socket file exists and a live daemon answers it.',
      remediation: 'No action needed.',
    })
  }
  // File present but nothing answers — a crash left the socket behind. It can
  // make a fresh daemon hit EADDRINUSE; the next proxy unlinks and rebinds it.
  return mk(id, title, 'warn', {
    detail: 'A daemon socket file is present but no daemon answers it — a stale socket left by a crashed daemon, distinct from "no daemon running". It can block a fresh bind until removed.',
    remediation: 'Start a session so a fresh proxy unlinks the stale socket and rebinds, or remove daemon.sock from the state dir.',
  })
}

// --- checks ---------------------------------------------------------------

function checkDaemonReachable(ev: Evidence): DoctorCheck {
  if (ev.hello) {
    return mk('daemon-reachable', 'Daemon answers the socket', 'ok', {
      detail: `Daemon ${ev.hello.daemonVersion} (pid ${ev.hello.pid ?? 'unknown'}, generation ${ev.hello.generation}) answered the socket greeting.`,
      remediation: 'No action needed.',
      evidence: { hello: ev.hello },
    })
  }
  // No hello is not automatically an error: an old per-session server may still
  // hold the inbound lock with no daemon at all (see connection-lock-consistency).
  return mk('daemon-reachable', 'Daemon answers the socket', 'error', {
    detail:
      'No daemon answered the socket greeting. Inbound delivery is down unless a legacy server still holds the inbound connection (see connection-lock-consistency).',
    remediation:
      'Start (or restart) a session so the proxy spawns a daemon, or run the channel; if a stale socket file is blocking the bind, a fresh proxy unlinks and rebinds it.',
  })
}

function checkVersionSkew(ev: Evidence, deps: DoctorDeps): DoctorCheck {
  const pinned = ev.pinned?.version
  const daemon = ev.status?.daemon?.version ?? ev.hello?.daemonVersion
  const invoking = deps.runBy.version
  const sessions = ev.status?.sessions.map((s) => s.proxyVersion) ?? []
  const evidence = {
    pinned: pinned ?? null,
    daemon_loaded: daemon ?? null,
    invoking: invoking ?? null,
    session_proxies: sessions,
  }

  const daemonVsPinned = pinned && daemon ? cmp(daemon, pinned) : undefined
  // Hard fault: the live daemon loaded an OLDER version than is pinned on disk —
  // an on-disk upgrade that never hot-reloaded into the running daemon.
  if (daemonVsPinned === -1) {
    return mk('version-skew', 'Daemon vs pinned vs proxy versions', 'error', {
      detail: `Daemon is running ${daemon} but ${pinned} is pinned on disk; the upgrade did not hot-reload into the daemon.`,
      remediation:
        'Restart the daemon so it loads the pinned version: stop the daemon process and re-trigger the channel (a fresh session will spawn the current daemon). A stuck old daemon may need a session/host restart.',
      evidence,
    })
  }
  // Soft: the daemon loaded a NEWER version than is pinned — a rollback or a
  // reverted pin, still a live-daemon/disk mismatch worth surfacing.
  if (daemonVsPinned === 1) {
    return mk('version-skew', 'Daemon vs pinned vs proxy versions', 'warn', {
      detail: `Daemon is running ${daemon}, newer than the pinned ${pinned} — a rollback or a reverted pin. The live daemon does not match the install on disk.`,
      remediation:
        'If the pin was intentional, restart the daemon to load the pinned version; otherwise re-pin to the intended version.',
      evidence,
    })
  }
  // Soft: the code running this check predates the pinned upgrade (resumed session).
  if (pinned && invoking && cmp(invoking, pinned) === -1) {
    return mk('version-skew', 'Daemon vs pinned vs proxy versions', 'warn', {
      detail: `This diagnosis is running ${invoking} while ${pinned} is pinned; the result reflects older logic. Daemon-loaded version is ${daemon ?? 'unknown'}.`,
      remediation:
        'Re-run from a freshly started session, or run the CLI (npm run doctor) from the pinned install for a current diagnosis.',
      evidence,
    })
  }
  // Anything we could not positively compare — a missing version, a dev source,
  // a prerelease/rollback that does not parse — is unknown, never a clean "ok".
  if (!pinned || !daemon || daemonVsPinned === undefined) {
    return mk('version-skew', 'Daemon vs pinned vs proxy versions', 'unknown', {
      detail: `Could not confirm version consistency (pinned=${pinned ?? 'unknown'}, daemon=${daemon ?? 'unknown'}, invoking=${invoking ?? 'unknown'}). A dev source, a rollback, or an unparseable version lands here.`,
      remediation: 'No action needed unless a skew is suspected; the CLI from the pinned install reports the disk-side versions.',
      evidence,
    })
  }
  return mk('version-skew', 'Daemon vs pinned vs proxy versions', 'ok', {
    detail: `Pinned ${pinned}, daemon-loaded ${daemon}, invoking ${invoking ?? 'unknown'} are consistent.`,
    remediation: 'No action needed.',
    evidence,
  })
}

function checkProxyVersionConsistency(ev: Evidence): DoctorCheck {
  const sessions = ev.status?.sessions ?? []
  if (!ev.status) {
    return mk('proxy-version-consistency', 'Registered proxies agree on version', 'unknown', {
      detail: 'Could not read channel status, so registered proxy versions are unknown.',
      remediation: 'Run the CLI doctor, or retry once the daemon is reachable.',
    })
  }
  const versions = [...new Set(sessions.map((s) => s.proxyVersion))]
  if (versions.length <= 1) {
    return mk('proxy-version-consistency', 'Registered proxies agree on version', 'ok', {
      detail:
        sessions.length === 0
          ? 'No registered proxies.'
          : `All ${sessions.length} registered proxies are on ${versions[0]}.`,
      remediation: 'No action needed.',
      evidence: { versions },
    })
  }
  const breakdown = sessions.map((s) => ({ session: s.sessionId, version: s.proxyVersion, role: s.role }))
  return mk('proxy-version-consistency', 'Registered proxies agree on version', 'warn', {
    detail: `Registered proxies span ${versions.length} versions (${versions.join(', ')}); a resumed teammate likely carries an older broker than the dispatcher.`,
    remediation:
      'Restart the lagging session(s) so they reload the current proxy; the older proxy is harmless to others but its own delivery contract may differ.',
    evidence: { breakdown },
  })
}

function checkDaemonLaunchSource(ev: Evidence, deps: DoctorDeps): DoctorCheck {
  // Authoritative: the daemon self-reports its launch path. Fallback: the cwd of
  // the daemon process (its spawn cwd is the plugin root).
  const launchPath =
    ev.status?.daemon?.launch_path ??
    (ev.hello?.pid ? ev.servers.find((s) => s.pid === ev.hello?.pid)?.cwd : undefined)
  if (!launchPath) {
    return mk('daemon-launch-source', 'Daemon launched from a versioned dir', 'unknown', {
      detail: 'Could not determine the daemon launch path (no daemon block in status and no inspectable daemon cwd).',
      remediation: 'No action needed unless a floating-version daemon is suspected.',
    })
  }
  const source = classifyInstallSource(launchPath)
  if (source === 'marketplace') {
    return mk('daemon-launch-source', 'Daemon launched from a versioned dir', 'warn', {
      detail: `Daemon launched from the marketplace source dir (${redactHome(launchPath, deps)}); its version floats with the checkout and may not match its tag after a pull.`,
      remediation:
        'Prefer launching from the versioned cache dir. If the source dir is intentional (development), this is expected.',
      evidence: { launch_path: launchPath, source },
    })
  }
  return mk('daemon-launch-source', 'Daemon launched from a versioned dir', 'ok', {
    detail: `Daemon launched from ${source === 'cache' ? 'a versioned cache dir' : 'an install dir'} (${redactHome(launchPath, deps)}).`,
    remediation: 'No action needed.',
    evidence: { launch_path: launchPath, source },
  })
}

function checkPinnedVsDisk(ev: Evidence): DoctorCheck {
  if (!ev.pinned) {
    return mk('pinned-vs-disk', 'Pinned version matches the install on disk', 'unknown', {
      detail: 'Could not read the pinned install record (installed_plugins.json missing, unreadable, or a dev source).',
      remediation: 'No action needed for a dev checkout; otherwise verify the plugin install.',
    })
  }
  const onDisk = ev.readManifestVersionAt(ev.pinned.installPath)
  if (!onDisk) {
    return mk('pinned-vs-disk', 'Pinned version matches the install on disk', 'unknown', {
      detail: `Pinned version is ${ev.pinned.version} but the plugin manifest at the install path could not be read.`,
      remediation: 'Verify the install path exists and contains a valid plugin.json.',
      evidence: { pinned: ev.pinned },
    })
  }
  if (onDisk !== ev.pinned.version) {
    return mk('pinned-vs-disk', 'Pinned version matches the install on disk', 'error', {
      detail: `Pinned version ${ev.pinned.version} does not match the manifest version ${onDisk} at the install path — a half-applied or corrupt install.`,
      remediation: 'Reinstall/repair the feishu-channel plugin so the pinned version and the on-disk manifest agree.',
      evidence: { pinned: ev.pinned, on_disk: onDisk },
    })
  }
  return mk('pinned-vs-disk', 'Pinned version matches the install on disk', 'ok', {
    detail: `Pinned version ${ev.pinned.version} matches the install on disk.`,
    remediation: 'No action needed.',
    evidence: { pinned: ev.pinned },
  })
}

function checkConnectionLock(ev: Evidence): DoctorCheck {
  const id = 'connection-lock-consistency'
  const title = 'Inbound lock held by the live daemon'
  const holder = ev.lockHolder
  const daemonAlive = ev.hello !== null || ev.status?.daemon !== undefined
  if (!holder) {
    // A healthy daemon takes the legacy inbound lock at startup. If a daemon is
    // proven alive (hello/status) yet no holder exists, that is protocol drift —
    // the live daemon is not holding the inbound lock — not a clean state.
    if (daemonAlive) {
      return mk(id, title, 'warn', {
        detail: 'A daemon is alive but connection.lock is absent — the live daemon is not holding the inbound lock (protocol drift). This may also be a brief startup window before the lock is acquired.',
        remediation: 'Re-run; if it persists, restart the daemon so it reacquires the inbound lock.',
        evidence: { hello_pid: ev.hello?.pid ?? null },
      })
    }
    return mk(id, title, 'ok', {
      detail: 'No connection.lock present and no daemon alive — no legacy inbound-lock holder.',
      remediation: 'No action needed.',
    })
  }
  if (!holder.alive) {
    return mk(id, title, 'warn', {
      detail: `connection.lock names pid ${holder.pid}, which is no longer alive — a stale pidfile from a crashed holder.`,
      remediation: 'Harmless; the next server reclaims the stale lock. Remove connection.lock if it lingers.',
      evidence: { holder },
    })
  }
  const helloPid = ev.hello?.pid
  if (helloPid !== undefined && holder.pid === helloPid) {
    return mk(id, title, 'ok', {
      detail: `connection.lock is held by the live daemon (pid ${holder.pid}).`,
      remediation: 'No action needed.',
      evidence: { holder, hello_pid: helloPid },
    })
  }
  // Holder is alive but is NOT the live daemon (no hello, or a different pid).
  // If it is a server.ts process, it is an old/second server still owning the
  // Feishu inbound WebSocket — the double-consumption vector.
  const isServer = holder.command !== undefined && holder.command.includes('server.ts')
  if (isServer) {
    return mk(id, title, 'error', {
      detail:
        helloPid === undefined
          ? `connection.lock is held by a live feishu-channel server (pid ${holder.pid}) but no daemon answers the socket — an old per-session server is still holding the Feishu inbound connection.`
          : `connection.lock is held by pid ${holder.pid} but the socket listener is pid ${helloPid} — a second feishu-channel server is holding the Feishu inbound connection, so inbound is split between two connections.`,
      remediation:
        'Stop the stale holder (its command/cwd are in the evidence). If SIGTERM does not clear it (parent dead, un-signalable), a session/host restart releases the inbound lock.',
      evidence: { holder, hello_pid: helloPid ?? null },
    })
  }
  return mk(id, title, 'warn', {
    detail: `connection.lock is held by a live process (pid ${holder.pid}) that does not look like a feishu-channel server.`,
    remediation: 'Inspect the holder (command/cwd in evidence); if it is unrelated, the lock path may be misconfigured.',
    evidence: { holder, hello_pid: helloPid ?? null },
  })
}

function checkDaemonSingleton(ev: Evidence): DoctorCheck {
  const id = 'daemon-singleton'
  const title = 'Exactly one daemon owns the socket'
  const daemons = ev.servers.filter((s) => s.kind === 'daemon')
  const listener = ev.hello?.pid
  if (daemons.length === 0) {
    if (ev.hello) {
      return mk(id, title, 'warn', {
        detail: `A daemon answers the socket${listener ? ` (pid ${listener})` : ''} but process enumeration found no '--daemon' process — ps output may be truncated or the daemon launched without the flag.`,
        remediation: 'No action needed if the channel works; re-run if process enumeration was unreliable.',
        evidence: { listener_pid: listener ?? null },
      })
    }
    return mk(id, title, 'ok', {
      detail: 'No daemon process found and none answering the socket.',
      remediation: 'No action needed (the channel is simply not running).',
    })
  }
  if (daemons.length > 1) {
    return mk(id, title, 'error', {
      detail: `Found ${daemons.length} daemon processes (pids ${daemons.map((d) => d.pid).join(', ')}); only one can bind the socket, the rest should have stood down. Extra daemon processes are an abnormal lifecycle state — leftover processes still holding the inbound lock or a Feishu connection — and should be cleared.`,
      remediation: 'Stop the extra daemon process(es); keep the one whose pid equals the socket listener.',
      evidence: { daemon_pids: daemons.map((d) => d.pid), listener_pid: listener ?? null },
    })
  }
  const only = daemons[0]!
  if (listener === undefined) {
    return mk(id, title, 'unknown', {
      detail: `One daemon process (pid ${only.pid}) found, but the socket greeting did not report a listener pid (an older daemon), so listener identity is unconfirmed.`,
      remediation: 'No action needed; upgrade the daemon to get a pid in the greeting.',
      evidence: { daemon_pid: only.pid },
    })
  }
  if (only.pid !== listener) {
    return mk(id, title, 'warn', {
      detail: `The lone daemon process (pid ${only.pid}) is not the socket listener (pid ${listener}); the listener may be a daemon enumeration missed.`,
      remediation: 'Re-run; if it persists, inspect both pids — one may be a dying or wrong-version daemon.',
      evidence: { daemon_pid: only.pid, listener_pid: listener },
    })
  }
  return mk(id, title, 'ok', {
    detail: `Exactly one daemon (pid ${only.pid}) owns the socket.`,
    remediation: 'No action needed.',
    evidence: { daemon_pid: only.pid },
  })
}

function checkCoexistingServers(ev: Evidence): DoctorCheck {
  const id = 'coexisting-server-versions'
  const title = 'No stale-version server lingering'
  const servers = ev.servers
  if (servers.length === 0) {
    return mk(id, title, 'unknown', {
      detail: 'No feishu-channel server processes were enumerated.',
      remediation: 'No action needed; re-run if the channel is expected to be running.',
    })
  }
  // Group by install: launch dir + manifest version + source. N proxies of the
  // same install are normal; ≥2 distinct installs/versions is the foot-gun. Only
  // processes whose install dir resolved are counted as a distinct install — a
  // process we could not attribute (a proxy whose cwd is a session workspace)
  // must not masquerade as a separate version.
  const installs = new Map<string, { dir?: string; version?: string; source: InstallSource; pids: number[] }>()
  for (const s of servers) {
    if (s.installDir === undefined) continue
    const key = `${s.installDir}|${s.manifestVersion ?? 'unknown'}`
    const entry = installs.get(key) ?? { dir: s.installDir, version: s.manifestVersion, source: s.source, pids: [] }
    entry.pids.push(s.pid)
    installs.set(key, entry)
  }
  const distinct = [...installs.values()]
  if (distinct.length === 0) {
    return mk(id, title, 'unknown', {
      detail: `${servers.length} server process(es) found, but none could be attributed to a resolved install dir.`,
      remediation: 'No action needed; re-run if a version conflict is suspected.',
    })
  }
  const hasMarketplace = distinct.some((d) => d.source === 'marketplace')
  if (distinct.length <= 1 && !hasMarketplace) {
    return mk(id, title, 'ok', {
      detail: `All ${servers.length} server process(es) run from one install (${distinct[0]?.version ?? 'unknown'}).`,
      remediation: 'No action needed.',
      evidence: { installs: distinct },
    })
  }
  if (distinct.length <= 1 && hasMarketplace) {
    return mk(id, title, 'warn', {
      detail: 'Server process(es) run from the marketplace source dir — a floating version that can drift from its tag.',
      remediation: 'Expected during development; for a stable runtime, launch from the versioned cache dir.',
      evidence: { installs: distinct },
    })
  }
  return mk(id, title, 'warn', {
    detail: `${distinct.length} distinct installs/versions of the server coexist; a stale old-version server is lingering (it will not be cleared until its process exits).`,
    remediation:
      'Stop the stale server process(es); the listed install dirs identify which is which. A lingering old server can keep holding the inbound lock.',
    evidence: { installs: distinct },
  })
}

function checkOrphanServers(ev: Evidence): DoctorCheck {
  const id = 'orphan-servers'
  const title = 'No stranded reparented server'
  // A live server reparented to pid 1 (parent dead) is a legacy-shape symptom.
  // Current shutdown watches the parent via stdin EOF, not ppid, so this flags a
  // stranded old process, not an active reliance on ppid.
  const orphans = ev.servers.filter((s) => s.ppid === 1 && ev.isPidAlive(s.pid))
  if (orphans.length === 0) {
    return mk(id, title, 'ok', {
      detail: 'No reparented (orphaned) server processes.',
      remediation: 'No action needed.',
    })
  }
  return mk(id, title, 'warn', {
    detail: `${orphans.length} server process(es) are reparented to pid 1 (parent gone): pids ${orphans.map((o) => o.pid).join(', ')}. A stranded old-shape process can keep a Feishu connection or the inbound lock.`,
    remediation: 'Stop the orphaned process(es) if they are stale; a current server exits on its own when its session ends.',
    evidence: { orphan_pids: orphans.map((o) => o.pid) },
  })
}

function checkOrphanProxies(ev: Evidence): DoctorCheck {
  const id = 'orphan-proxies'
  const title = 'No dead proxy still registered'
  if (!ev.status) {
    return mk(id, title, 'unknown', {
      detail: 'Could not read channel status, so registered proxies could not be checked for liveness.',
      remediation: 'Run the CLI doctor or retry once the daemon is reachable.',
    })
  }
  const dead = ev.status.sessions.filter((s) => !ev.isPidAlive(s.pid))
  if (dead.length === 0) {
    return mk(id, title, 'ok', {
      detail: `All ${ev.status.sessions.length} registered proxies are alive.`,
      remediation: 'No action needed.',
    })
  }
  return mk(id, title, 'warn', {
    detail: `${dead.length} registered proxy session(s) name a dead pid: ${dead.map((d) => `${d.sessionId} (pid ${d.pid})`).join(', ')}. Stale registrations can confuse ownership selection.`,
    remediation: 'They clear when their socket closes; if they persist, the daemon may need a restart.',
    evidence: { dead: dead.map((d) => ({ session: d.sessionId, pid: d.pid })) },
  })
}

function checkOwnershipOnTeammate(ev: Evidence): DoctorCheck {
  const id = 'ownership-on-teammate'
  const title = 'Channel owner is the dispatcher, not a teammate'
  const st = ev.status
  if (!st) {
    return mk(id, title, 'unknown', {
      detail: 'Could not read channel status, so ownership could not be evaluated.',
      remediation: 'Run the CLI doctor or retry once the daemon is reachable.',
    })
  }
  const byId = new Map(st.sessions.map((s) => [s.sessionId, s]))
  const targetId = st.effective_target_session_id ?? st.owner_session_id
  const target = targetId ? byId.get(targetId) : undefined
  const dispatcherRole = st.sessions.filter((s) => s.role === 'dispatcher')
  const dispatcher = st.dispatcher_session_id ? byId.get(st.dispatcher_session_id) : undefined

  // A named owner that is no longer among the live sessions is a dangling owner:
  // inbound has a target that does not exist, so messages reach nothing until the
  // channel is reclaimed. Distinct from "no owner set" (targetId null).
  if (targetId && !target) {
    return mk(id, title, 'warn', {
      detail: `Channel owner ${targetId} is not among the live sessions — a dangling owner; inbound is routed to a session that is gone.`,
      remediation: 'Run feishu_channel_reclaim from the dispatcher to return the channel to a live owner.',
      evidence: { owner: targetId, live_sessions: st.sessions.map((s) => s.sessionId) },
    })
  }

  const reasons: string[] = []
  // (b) More than one dispatcher-role session registered.
  if (dispatcherRole.length > 1) {
    reasons.push(`${dispatcherRole.length} sessions registered with role=dispatcher (${dispatcherRole.map((s) => s.sessionId).join(', ')})`)
  }
  if (target) {
    // (a) The effective owner is a dispatcher-role session that is not THE dispatcher.
    if (target.role === 'dispatcher' && st.dispatcher_session_id && target.sessionId !== st.dispatcher_session_id) {
      reasons.push(`owner ${target.sessionId} has role=dispatcher but is not the registered dispatcher (${st.dispatcher_session_id})`)
    }
    // (c) The owning dispatcher-role session carries a teammate name.
    if (target.role === 'dispatcher' && target.metadata.teammate_name) {
      reasons.push(`owner ${target.sessionId} is tagged teammate_name=${target.metadata.teammate_name} yet registered as dispatcher`)
    }
    // (d) The owning dispatcher-role session's cwd is plainly not the dispatcher's.
    if (
      target.role === 'dispatcher' &&
      dispatcher &&
      target.sessionId !== dispatcher.sessionId &&
      target.metadata.cwd &&
      dispatcher.metadata.cwd &&
      target.metadata.cwd !== dispatcher.metadata.cwd
    ) {
      reasons.push(`owner cwd ${target.metadata.cwd} differs from the dispatcher cwd ${dispatcher.metadata.cwd}`)
    }
  }

  if (reasons.length === 0) {
    return mk(id, title, 'ok', {
      detail: target
        ? `Channel owner ${target.sessionId} (role=${target.role}${target.metadata.teammate_name ? `, teammate ${target.metadata.teammate_name}` : ''}) looks legitimate.`
        : 'No effective channel owner is set.',
      remediation: 'No action needed.',
      evidence: { owner: targetId, dispatcher: st.dispatcher_session_id },
    })
  }
  return mk(id, title, 'error', {
    detail: `Channel ownership looks misrouted: ${reasons.join('; ')}. A teammate that inherited the dispatcher env can register as dispatcher and steal inbound.`,
    remediation: 'Run feishu_channel_reclaim from the real dispatcher to take the channel back, then re-grant/acquire intentionally.',
    evidence: { owner: targetId, dispatcher: st.dispatcher_session_id, reasons },
  })
}

function checkBrokerOwnerHandoff(ev: Evidence): DoctorCheck {
  const id = 'broker-owner-handoff-gap'
  const title = 'Channel owner can receive inbound (handoff)'
  const st = ev.status
  if (!st) {
    return mk(id, title, 'unknown', {
      detail: 'Could not read channel status, so the owner transport could not be checked.',
      remediation: 'Run the CLI doctor or retry once the daemon is reachable.',
    })
  }
  const targetId = st.effective_target_session_id ?? st.owner_session_id
  const target = targetId ? st.sessions.find((s) => s.sessionId === targetId) : undefined
  if (!target) {
    return mk(id, title, 'ok', {
      detail: 'No effective owner set.',
      remediation: 'No action needed.',
    })
  }
  const transport = target.metadata.transport
  const teammate = target.metadata.teammate_name
  const who = teammate ? `teammate ${teammate}` : `session ${target.sessionId}`
  // Transport is the authoritative capability signal — prefer it over the
  // teammate label. A self-reported `broker` owner cannot receive inbound
  // regardless of whether a teammate_name was also set.
  if (transport === 'broker') {
    return mk(id, title, 'warn', {
      detail: `Owner is a broker ${who}; broker control-planes cannot receive channel inbound, so the handoff may be silently broken.`,
      remediation: 'Return the channel to the dispatcher, or hand it to a stdio teammate instead.',
      evidence: { owner: target.sessionId, transport },
    })
  }
  if (transport === 'stdio') {
    return mk(id, title, 'ok', {
      detail: `Owner is a stdio ${who}; inbound delivery is supported.`,
      remediation: 'No action needed.',
      evidence: { owner: target.sessionId, transport },
    })
  }
  // No transport reported. Only a teammate owner is at risk (the dispatcher
  // always receives); annotate rather than assert.
  if (teammate === undefined) {
    return mk(id, title, 'ok', {
      detail: `Owner ${target.sessionId} is not a teammate; no handoff gap applies.`,
      remediation: 'No action needed.',
    })
  }
  return mk(id, title, 'unknown', {
    detail: `Owner is teammate ${teammate}; its control-plane transport is not self-reported, so a broker handoff gap cannot be ruled out. If it is a stream-json/broker teammate, inbound may not arrive.`,
    remediation: 'If the teammate is not receiving channel messages, return the channel to the dispatcher (feishu_channel_return_to_dispatcher) or use a stdio teammate. Tag the spawn with CLAUDEMUX_CHANNEL_TRANSPORT to make this check definitive.',
    evidence: { owner: target.sessionId, teammate_name: teammate },
  })
}

function checkStateDir(ev: Evidence): DoctorCheck {
  const id = 'state-dir'
  const title = 'State dir and credentials are present'
  const h = ev.stateHealth
  if (!h) {
    return mk(id, title, 'unknown', {
      detail: 'Could not inspect the channel state directory.',
      remediation: 'Verify the state dir path is readable.',
    })
  }
  if (!h.envPresent || !h.hasAppId || !h.hasAppSecret) {
    return mk(id, title, 'error', {
      detail: `Feishu credentials are incomplete: .env ${h.envPresent ? 'present' : 'missing'}, FEISHU_APP_ID ${h.hasAppId ? 'set' : 'missing'}, FEISHU_APP_SECRET ${h.hasAppSecret ? 'set' : 'missing'}. The channel cannot connect without both.`,
      remediation: 'Run the configure flow to write .env with FEISHU_APP_ID and FEISHU_APP_SECRET.',
      evidence: { env_present: h.envPresent, has_app_id: h.hasAppId, has_app_secret: h.hasAppSecret },
    })
  }
  if (h.accessParse === 'corrupt' || h.queueParse === 'corrupt') {
    return mk(id, title, 'warn', {
      detail: `Credentials are present, but ${h.accessParse === 'corrupt' ? 'access.json' : 'the inbound queue'} did not parse.`,
      remediation: 'Inspect (and if needed reset) the unparseable file; a corrupt access.json can break the access gate.',
      evidence: { access_parse: h.accessParse, queue_parse: h.queueParse },
    })
  }
  return mk(id, title, 'ok', {
    detail: 'State dir present with Feishu credentials; access.json and the inbound queue parse.',
    remediation: 'No action needed.',
  })
}

// --- helpers --------------------------------------------------------------

interface MkBody {
  detail: string
  remediation: string
  evidence?: Record<string, unknown>
}

function mk(id: string, title: string, severity: Severity, body: MkBody): DoctorCheck {
  const check: DoctorCheck = { id, title, severity, detail: body.detail, remediation: body.remediation }
  if (body.evidence) check.evidence = body.evidence
  return check
}

function worstOf(checks: DoctorCheck[]): Severity {
  let worst: Severity = 'ok'
  for (const c of checks) if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[worst]) worst = c.severity
  return worst
}

/** Compare two plugin versions, returning -1/0/1, or `undefined` when unparseable. */
function cmp(a: string, b: string): -1 | 0 | 1 | undefined {
  if (!isPluginVersion(a) || !isPluginVersion(b)) return undefined
  try {
    const r = comparePluginVersions(a, b)
    return r < 0 ? -1 : r > 0 ? 1 : 0
  } catch {
    return undefined
  }
}

/**
 * A feishu-channel install dir is `.../cache/<marketplace>/feishu-channel/<ver>`
 * (versioned) or `.../marketplaces/<marketplace>/plugins/feishu-channel` (a
 * floating source checkout).
 */
export function classifyInstallSource(dir: string): InstallSource {
  if (/\/marketplaces\/[^/]+\/plugins\/feishu-channel\/?$/.test(dir)) return 'marketplace'
  if (/\/cache\/[^/]+\/feishu-channel\/[^/]+\/?$/.test(dir)) return 'cache'
  return 'unknown'
}

/** Shorten an absolute home path for display, so reports do not bake in a real $HOME. */
function redactHome(path: string, deps: DoctorDeps): string {
  const home = homeFromStateDir(deps.stateDir)
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** Best-effort $HOME recovered from the state dir (`<home>/.claude/channels/feishu`). */
function homeFromStateDir(stateDir: string): string | undefined {
  const marker = '/.claude/'
  const i = stateDir.indexOf(marker)
  return i > 0 ? stateDir.slice(0, i) : undefined
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

function safeSync<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
