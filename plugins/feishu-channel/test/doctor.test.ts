import { describe, expect, it } from 'vitest'

import {
  collectDiagnosis,
  classifyInstallSource,
  type DoctorCheck,
  type DoctorDeps,
  type ServerProcess,
  type Severity,
  type StatusSnapshot,
} from '../src/doctor'

const STATE_DIR = '/home/u/.claude/channels/feishu'
const PLUGIN_CACHE = '/home/u/.claude/plugins/cache/claudemux/feishu-channel/0.7.0'
const MARKETPLACE = '/home/u/.claude/plugins/marketplaces/claudemux/plugins/feishu-channel'

function daemonProc(pid: number, over: Partial<ServerProcess> = {}): ServerProcess {
  return {
    pid,
    ppid: 200,
    command: 'node tsx src/server.ts --daemon',
    cwd: PLUGIN_CACHE,
    kind: 'daemon',
    installDir: PLUGIN_CACHE,
    manifestVersion: '0.7.0',
    source: 'cache',
    confidence: 'high',
    ...over,
  }
}

function healthyStatus(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    owner_session_id: 'dispatcher:aaa',
    dispatcher_session_id: 'dispatcher:aaa',
    granted_session_id: null,
    effective_target_session_id: 'dispatcher:aaa',
    lease_epoch: 1,
    sessions: [
      { sessionId: 'dispatcher:aaa', pid: 300, proxyVersion: '0.7.0', role: 'dispatcher', metadata: { cwd: '/work/dispatcher' } },
    ],
    daemon: { version: '0.7.0', pid: 100, generation: 1, started_at: 500, launch_path: PLUGIN_CACHE },
    ...over,
  }
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    now: () => 1000,
    platform: 'darwin',
    stateDir: STATE_DIR,
    runBy: { entry: 'cli', version: '0.7.0' },
    verbose: true,
    probeHello: async () => ({ daemonVersion: '0.7.0', generation: 1, pid: 100 }),
    probeStatus: async () => healthyStatus(),
    readPinnedInstall: () => ({ version: '0.7.0', installPath: PLUGIN_CACHE }),
    readManifestVersionAt: () => '0.7.0',
    readConnectionLockHolder: () => ({ pid: 100, alive: true, command: 'node tsx src/server.ts --daemon' }),
    enumerateServers: () => [daemonProc(100)],
    isPidAlive: () => true,
    readStateDirHealth: () => ({ envPresent: true, hasAppId: true, hasAppSecret: true, accessParse: 'ok', queueParse: 'ok' }),
    socketExists: () => true,
    ...over,
  }
}

async function run(over: Partial<DoctorDeps> = {}): Promise<DoctorCheck[]> {
  return (await collectDiagnosis(deps(over))).checks
}

function find(checks: DoctorCheck[], id: string): DoctorCheck {
  const c = checks.find((x) => x.id === id)
  if (!c) throw new Error(`no check ${id}`)
  return c
}

function sev(checks: DoctorCheck[], id: string): Severity {
  return find(checks, id).severity
}

describe('collectDiagnosis — report shape', () => {
  it('returns all checks, ranked worst-severity first', async () => {
    const report = await collectDiagnosis(
      deps({ readStateDirHealth: () => ({ envPresent: false, hasAppId: false, hasAppSecret: false, accessParse: 'missing', queueParse: 'missing' }) }),
    )
    expect(report.checks.length).toBeGreaterThanOrEqual(13)
    // The error (state-dir) ranks ahead of the ok checks.
    const firstError = report.checks.findIndex((c) => c.severity === 'error')
    const firstOk = report.checks.findIndex((c) => c.severity === 'ok')
    expect(firstError).toBeLessThan(firstOk)
    expect(report.summary.worst_severity).toBe('error')
    expect(report.summary.counts.error).toBeGreaterThanOrEqual(1)
  })

  it('omits evidence when not verbose, keeps it when verbose', async () => {
    const quiet = await collectDiagnosis(deps({ verbose: false }))
    expect(quiet.checks.every((c) => c.evidence === undefined)).toBe(true)
    const loud = await collectDiagnosis(deps({ verbose: true }))
    expect(loud.checks.some((c) => c.evidence !== undefined)).toBe(true)
  })

  it('a healthy system reports no error/warn', async () => {
    const checks = await run()
    expect(checks.every((c) => c.severity === 'ok' || c.severity === 'unknown')).toBe(true)
  })

  it('never throws when every probe fails — including the per-input probes', async () => {
    const boom = () => {
      throw new Error('boom')
    }
    const report = await collectDiagnosis(
      deps({
        probeHello: async () => {
          throw new Error('boom')
        },
        probeStatus: async () => {
          throw new Error('boom')
        },
        readPinnedInstall: boom,
        readConnectionLockHolder: boom,
        enumerateServers: boom,
        readStateDirHealth: boom,
        socketExists: boom,
        // The per-input probes the checks call directly must also be guarded.
        isPidAlive: boom,
        readManifestVersionAt: boom,
      }),
    )
    expect(report.checks.length).toBeGreaterThanOrEqual(14)
    expect(sev(report.checks, 'daemon-reachable')).toBe('error')
    expect(['unknown', 'ok']).toContain(sev(report.checks, 'version-skew'))
    expect(['unknown', 'ok']).toContain(sev(report.checks, 'pinned-vs-disk'))
  })
})

describe('socket-staleness', () => {
  it('warn when a socket file exists but no daemon answers', async () => {
    const checks = await run({ socketExists: () => true, probeHello: async () => null })
    expect(sev(checks, 'socket-staleness')).toBe('warn')
  })
  it('ok when no socket file and no daemon', async () => {
    const checks = await run({ socketExists: () => false, probeHello: async () => null })
    expect(sev(checks, 'socket-staleness')).toBe('ok')
  })
  it('ok when the socket is live', async () => {
    expect(sev(await run(), 'socket-staleness')).toBe('ok')
  })
})

describe('daemon-reachable', () => {
  it('ok when the daemon answers', async () => {
    expect(sev(await run(), 'daemon-reachable')).toBe('ok')
  })
  it('error when no daemon answers', async () => {
    expect(sev(await run({ probeHello: async () => null }), 'daemon-reachable')).toBe('error')
  })
})

describe('version-skew', () => {
  it('error when the daemon loaded an older version than pinned', async () => {
    const checks = await run({
      probeHello: async () => ({ daemonVersion: '0.5.0', generation: 1, pid: 100 }),
      probeStatus: async () => healthyStatus({ daemon: { version: '0.5.0', pid: 100, generation: 1, started_at: 1, launch_path: PLUGIN_CACHE } }),
      readPinnedInstall: () => ({ version: '0.7.0', installPath: PLUGIN_CACHE }),
    })
    expect(sev(checks, 'version-skew')).toBe('error')
  })
  it('warn when the invoking code predates the pinned version', async () => {
    const checks = await run({ runBy: { entry: 'cli', version: '0.5.0' } })
    expect(sev(checks, 'version-skew')).toBe('warn')
  })
  it('unknown (fail-soft) on an unparseable version, not error', async () => {
    const checks = await run({ readPinnedInstall: () => ({ version: 'dev', installPath: PLUGIN_CACHE }) })
    expect(sev(checks, 'version-skew')).toBe('unknown')
  })
  it('warn when the daemon is NEWER than pinned (rollback / reverted pin)', async () => {
    const checks = await run({
      probeHello: async () => ({ daemonVersion: '0.8.0', generation: 1, pid: 100 }),
      probeStatus: async () => healthyStatus({ daemon: { version: '0.8.0', pid: 100, generation: 1, started_at: 1, launch_path: PLUGIN_CACHE } }),
      readPinnedInstall: () => ({ version: '0.7.0', installPath: PLUGIN_CACHE }),
    })
    expect(sev(checks, 'version-skew')).toBe('warn')
  })
  it('ok when all three agree', async () => {
    expect(sev(await run(), 'version-skew')).toBe('ok')
  })
})

describe('proxy-version-consistency', () => {
  it('warn when proxies span versions', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          sessions: [
            { sessionId: 'dispatcher:aaa', pid: 300, proxyVersion: '0.7.0', role: 'dispatcher', metadata: {} },
            { sessionId: 'session:bbb', pid: 301, proxyVersion: '0.5.0', role: 'session', metadata: {} },
          ],
        }),
    })
    expect(sev(checks, 'proxy-version-consistency')).toBe('warn')
  })
  it('unknown when status is unreadable', async () => {
    expect(sev(await run({ probeStatus: async () => null }), 'proxy-version-consistency')).toBe('unknown')
  })
})

describe('daemon-launch-source', () => {
  it('warn when launched from the marketplace source dir', async () => {
    const checks = await run({
      probeStatus: async () => healthyStatus({ daemon: { version: '0.7.0', pid: 100, generation: 1, started_at: 1, launch_path: MARKETPLACE } }),
    })
    expect(sev(checks, 'daemon-launch-source')).toBe('warn')
  })
  it('ok from the versioned cache dir', async () => {
    expect(sev(await run(), 'daemon-launch-source')).toBe('ok')
  })
  it('falls back to the daemon process cwd when status has no daemon block', async () => {
    const checks = await run({
      probeStatus: async () => healthyStatus({ daemon: undefined }),
      enumerateServers: () => [daemonProc(100, { cwd: MARKETPLACE, installDir: MARKETPLACE, source: 'marketplace' })],
    })
    expect(sev(checks, 'daemon-launch-source')).toBe('warn')
  })
})

describe('pinned-vs-disk', () => {
  it('error when pinned and on-disk manifest disagree', async () => {
    const checks = await run({ readManifestVersionAt: () => '0.6.0' })
    expect(sev(checks, 'pinned-vs-disk')).toBe('error')
  })
  it('unknown when there is no pinned record', async () => {
    expect(sev(await run({ readPinnedInstall: () => null }), 'pinned-vs-disk')).toBe('unknown')
  })
})

describe('connection-lock-consistency', () => {
  it('ok when the live daemon holds the lock', async () => {
    expect(sev(await run(), 'connection-lock-consistency')).toBe('ok')
  })
  it('ok when there is no lockfile and no daemon alive', async () => {
    const checks = await run({ readConnectionLockHolder: () => null, probeHello: async () => null, probeStatus: async () => null })
    expect(sev(checks, 'connection-lock-consistency')).toBe('ok')
  })
  it('warn when a daemon is alive but NO lock holder exists (protocol drift)', async () => {
    const checks = await run({ readConnectionLockHolder: () => null })
    expect(sev(checks, 'connection-lock-consistency')).toBe('warn')
  })
  it('warn on a stale (dead-holder) pidfile', async () => {
    const checks = await run({ readConnectionLockHolder: () => ({ pid: 999, alive: false }) })
    expect(sev(checks, 'connection-lock-consistency')).toBe('warn')
  })
  it('error when a live server holds the lock but NO daemon answers (the core foot-gun)', async () => {
    const checks = await run({
      probeHello: async () => null,
      readConnectionLockHolder: () => ({ pid: 777, alive: true, command: 'node tsx src/server.ts', cwd: '/home/u/.claude/plugins/cache/claudemux/feishu-channel/0.5.0' }),
    })
    expect(sev(checks, 'connection-lock-consistency')).toBe('error')
  })
  it('error when the lock holder is a different server than the listener', async () => {
    const checks = await run({
      probeHello: async () => ({ daemonVersion: '0.7.0', generation: 1, pid: 100 }),
      readConnectionLockHolder: () => ({ pid: 555, alive: true, command: 'node tsx src/server.ts' }),
    })
    expect(sev(checks, 'connection-lock-consistency')).toBe('error')
  })
  it('warn when a non-server process holds the lock', async () => {
    const checks = await run({
      probeHello: async () => null,
      readConnectionLockHolder: () => ({ pid: 555, alive: true, command: '/usr/bin/something-else' }),
    })
    expect(sev(checks, 'connection-lock-consistency')).toBe('warn')
  })
})

describe('daemon-singleton', () => {
  it('ok with exactly one daemon equal to the listener', async () => {
    expect(sev(await run(), 'daemon-singleton')).toBe('ok')
  })
  it('error with more than one daemon process', async () => {
    const checks = await run({ enumerateServers: () => [daemonProc(100), daemonProc(101)] })
    expect(sev(checks, 'daemon-singleton')).toBe('error')
  })
  it('warn when the lone daemon pid is not the listener', async () => {
    const checks = await run({ enumerateServers: () => [daemonProc(102)] })
    expect(sev(checks, 'daemon-singleton')).toBe('warn')
  })
  it('unknown when the listener pid is unavailable (old daemon)', async () => {
    const checks = await run({ probeHello: async () => ({ daemonVersion: '0.7.0', generation: 1 }) })
    expect(sev(checks, 'daemon-singleton')).toBe('unknown')
  })
})

describe('coexisting-server-versions', () => {
  it('ok with one install', async () => {
    expect(sev(await run(), 'coexisting-server-versions')).toBe('ok')
  })
  it('warn when two distinct installs coexist', async () => {
    const checks = await run({
      enumerateServers: () => [
        daemonProc(100),
        daemonProc(101, { kind: 'proxy', installDir: '/home/u/.claude/plugins/cache/claudemux/feishu-channel/0.5.0', manifestVersion: '0.5.0' }),
      ],
    })
    expect(sev(checks, 'coexisting-server-versions')).toBe('warn')
  })
  it('warn when a marketplace (floating) server is present', async () => {
    const checks = await run({
      enumerateServers: () => [daemonProc(100, { cwd: MARKETPLACE, installDir: MARKETPLACE, source: 'marketplace', manifestVersion: '0.7.0' })],
    })
    expect(sev(checks, 'coexisting-server-versions')).toBe('warn')
  })
})

describe('orphan-servers', () => {
  it('warn when a server is reparented to pid 1', async () => {
    const checks = await run({ enumerateServers: () => [daemonProc(100, { ppid: 1 })] })
    expect(sev(checks, 'orphan-servers')).toBe('warn')
  })
  it('ok with normal parentage', async () => {
    expect(sev(await run(), 'orphan-servers')).toBe('ok')
  })
})

describe('orphan-proxies', () => {
  it('warn when a registered proxy pid is dead', async () => {
    const checks = await run({ isPidAlive: (pid) => pid !== 300 })
    expect(sev(checks, 'orphan-proxies')).toBe('warn')
  })
})

describe('ownership-on-teammate', () => {
  it('error when a teammate-tagged dispatcher-role session owns the channel', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'dispatcher:bbb',
          dispatcher_session_id: 'dispatcher:aaa',
          effective_target_session_id: 'dispatcher:bbb',
          sessions: [
            { sessionId: 'dispatcher:aaa', pid: 300, proxyVersion: '0.7.0', role: 'dispatcher', metadata: { cwd: '/work/dispatcher' } },
            { sessionId: 'dispatcher:bbb', pid: 301, proxyVersion: '0.7.0', role: 'dispatcher', metadata: { cwd: '/work/api-worker', teammate_name: 'api-worker' } },
          ],
        }),
    })
    expect(sev(checks, 'ownership-on-teammate')).toBe('error')
  })
  it('error when more than one dispatcher-role session is registered (no teammate_name needed)', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          sessions: [
            { sessionId: 'dispatcher:aaa', pid: 300, proxyVersion: '0.7.0', role: 'dispatcher', metadata: {} },
            { sessionId: 'dispatcher:bbb', pid: 301, proxyVersion: '0.7.0', role: 'dispatcher', metadata: {} },
          ],
        }),
    })
    expect(sev(checks, 'ownership-on-teammate')).toBe('error')
  })
  it('warn when the owner points at a session that is no longer registered (dangling)', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'session:gone',
          effective_target_session_id: 'session:gone',
          sessions: [
            { sessionId: 'dispatcher:aaa', pid: 300, proxyVersion: '0.7.0', role: 'dispatcher', metadata: {} },
          ],
        }),
    })
    expect(sev(checks, 'ownership-on-teammate')).toBe('warn')
  })
  it('ok when the dispatcher legitimately owns the channel', async () => {
    expect(sev(await run(), 'ownership-on-teammate')).toBe('ok')
  })
})

describe('broker-owner-handoff-gap', () => {
  it('unknown (annotation) when the owner is a teammate with no transport field', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'session:t',
          effective_target_session_id: 'session:t',
          sessions: [{ sessionId: 'session:t', pid: 300, proxyVersion: '0.7.0', role: 'session', metadata: { teammate_name: 'worker' } }],
        }),
    })
    expect(sev(checks, 'broker-owner-handoff-gap')).toBe('unknown')
  })
  it('warn when the owner is a broker teammate', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'session:t',
          effective_target_session_id: 'session:t',
          sessions: [{ sessionId: 'session:t', pid: 300, proxyVersion: '0.7.0', role: 'session', metadata: { teammate_name: 'worker', transport: 'broker' } }],
        }),
    })
    expect(sev(checks, 'broker-owner-handoff-gap')).toBe('warn')
  })
  it('warn on a broker transport even without a teammate_name (transport is authoritative)', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'session:t',
          effective_target_session_id: 'session:t',
          sessions: [{ sessionId: 'session:t', pid: 300, proxyVersion: '0.7.0', role: 'session', metadata: { transport: 'broker' } }],
        }),
    })
    expect(sev(checks, 'broker-owner-handoff-gap')).toBe('warn')
  })
  it('ok when the owner is a stdio teammate', async () => {
    const checks = await run({
      probeStatus: async () =>
        healthyStatus({
          owner_session_id: 'session:t',
          effective_target_session_id: 'session:t',
          sessions: [{ sessionId: 'session:t', pid: 300, proxyVersion: '0.7.0', role: 'session', metadata: { teammate_name: 'worker', transport: 'stdio' } }],
        }),
    })
    expect(sev(checks, 'broker-owner-handoff-gap')).toBe('ok')
  })
})

describe('state-dir', () => {
  it('error when credentials are missing', async () => {
    const checks = await run({
      readStateDirHealth: () => ({ envPresent: false, hasAppId: false, hasAppSecret: false, accessParse: 'missing', queueParse: 'missing' }),
    })
    expect(sev(checks, 'state-dir')).toBe('error')
  })
  it('warn when a state file is corrupt', async () => {
    const checks = await run({
      readStateDirHealth: () => ({ envPresent: true, hasAppId: true, hasAppSecret: true, accessParse: 'corrupt', queueParse: 'ok' }),
    })
    expect(sev(checks, 'state-dir')).toBe('warn')
  })
})

describe('classifyInstallSource', () => {
  it('recognizes a versioned cache dir', () => {
    expect(classifyInstallSource(PLUGIN_CACHE)).toBe('cache')
  })
  it('recognizes a marketplace source dir', () => {
    expect(classifyInstallSource(MARKETPLACE)).toBe('marketplace')
  })
  it('returns unknown for an unrelated path', () => {
    expect(classifyInstallSource('/opt/elsewhere')).toBe('unknown')
  })
})
