import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acquireDaemonLock, probeDaemonSocket, type DaemonLockRecord } from '../src/daemon-lock'
import { startDaemonServer, type DaemonServer } from '../src/daemon-server'

let n = 0
const tmp = (ext: string) => join(tmpdir(), `feishu-daemon-${process.pid}-${n++}.${ext}`)

function record(over: Partial<DaemonLockRecord> = {}): DaemonLockRecord {
  return { pid: 4242, startedAt: 1000, socketPath: tmp('sock'), daemonVersion: '0.2.1', ...over }
}

/** Never-serving probe — the common slice-1 case (no live daemon answers). */
const noDaemon = async () => false

describe('daemon-lock acquisition (proper-lockfile)', () => {
  test('acquires a free lock and the handle releases it', async () => {
    const lockPath = tmp('lock')
    const r = await acquireDaemonLock({ lockPath, self: record(), probe: noDaemon })
    expect(r.acquired).toBe(true)
    expect(existsSync(`${lockPath}.lock`)).toBe(true)
    if (r.acquired) await r.handle.release()
    expect(existsSync(`${lockPath}.lock`)).toBe(false)
  })

  test('does not acquire when a live daemon holds a fresh lock', async () => {
    const lockPath = tmp('lock')
    const held = await acquireDaemonLock({ lockPath, self: record({ pid: 111 }), probe: noDaemon })
    expect(held.acquired).toBe(true)

    const r = await acquireDaemonLock({ lockPath, self: record({ pid: 222 }), probe: noDaemon })
    expect(r).toEqual({ acquired: false, reason: 'held' })

    if (held.acquired) await held.handle.release()
  })

  // Invariant ①: lock() can STEAL a lock whose mtime merely lapsed under load
  // while the holder still serves. The post-acquire re-probe catches that — we
  // must stand down, NOT double-bind.
  test('re-probe after acquiring: a serving daemon makes us stand down', async () => {
    const lockPath = tmp('lock')
    const r = await acquireDaemonLock({ lockPath, self: record(), probe: async () => true })
    expect(r).toEqual({ acquired: false, reason: 'serving' })
    // standing down must release the (just-stolen) lock so the real holder keeps it
    expect(existsSync(`${lockPath}.lock`)).toBe(false)
  })

  // Invariant ②: a pre-existing STALE lock dir (crashed daemon, no live process,
  // mtime in the past) is reclaimed atomically by proper-lockfile — no hand-rolled
  // unlink window.
  test('reclaims a pre-existing stale lock and acquires', async () => {
    const lockPath = tmp('lock')
    mkdirSync(`${lockPath}.lock`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${lockPath}.lock`, old, old)

    const r = await acquireDaemonLock({ lockPath, self: record(), probe: noDaemon, staleMs: 10_000 })
    expect(r.acquired).toBe(true)
    if (r.acquired) await r.handle.release()
  })

  test('logs a compromised background refresh instead of throwing', async () => {
    const lockPath = tmp('lock')
    let loggedMessage = ''
    const r = await acquireDaemonLock({
      lockPath,
      self: record(),
      probe: noDaemon,
      staleMs: 2_000,
      logError: (message) => {
        loggedMessage = message
      },
    })
    expect(r.acquired).toBe(true)
    rmSync(`${lockPath}.lock`, { recursive: true, force: true })

    await waitForCondition(() => loggedMessage !== '', 'timed out waiting for compromised-lock log')

    expect(loggedMessage).toContain('daemon lock compromised')
    if (r.acquired) await r.handle.release()
  }, 5_000)

  // Seed pre-existing stale + N concurrent starters: exactly one wins. proper-lockfile's
  // atomic steal + in-process registry guarantee a single acquirer even from a stale seed.
  test('seed-stale + N concurrent acquirers → exactly one acquired', async () => {
    const lockPath = tmp('lock')
    mkdirSync(`${lockPath}.lock`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${lockPath}.lock`, old, old)

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acquireDaemonLock({ lockPath, self: record({ pid: 500 + i }), probe: noDaemon, staleMs: 10_000 }),
      ),
    )
    expect(results.filter((r) => r.acquired)).toHaveLength(1)
    expect(results.filter((r) => !r.acquired && r.reason === 'held')).toHaveLength(7)

    for (const r of results) if (r.acquired) await r.handle.release()
  })

  test('N independent processes racing the same lock → exactly one acquired', async () => {
    const lockPath = tmp('lock')
    const socketPath = tmp('sock')
    const barrierPath = tmp('barrier')
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'daemon-lock-racer.ts')

    const racers = Array.from({ length: 6 }, (_, i) =>
      startRacer(worker, lockPath, socketPath, barrierPath, 9000 + i, 'keep'),
    )
    await waitForReadyRacers(barrierPath, 6)
    writeFileSync(barrierPath, 'go')
    const results = await collectRacers(racers)

    expect(results.filter(isLockAcquired)).toHaveLength(1)
    expect(results.filter(isLockHeld)).toHaveLength(5)
  }, 15_000)

  test('N independent daemons racing a stale lock → exactly one binds the socket', async () => {
    const lockPath = tmp('lock')
    const socketPath = tmp('sock')
    const barrierPath = tmp('barrier')
    const accessFile = tmp('access.json')
    const queueFile = tmp('queue.jsonl')
    const worker = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'daemon-start-racer.ts')
    mkdirSync(`${lockPath}.lock`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${lockPath}.lock`, old, old)

    const racers = Array.from({ length: 6 }, (_, i) =>
      startRacer(worker, lockPath, socketPath, barrierPath, 9100 + i, 'keep', accessFile, queueFile),
    )
    await waitForReadyRacers(barrierPath, 6)
    writeFileSync(barrierPath, 'go')
    const results = await collectRacers(racers)

    expect(results.filter(isDaemonStarted)).toHaveLength(1)
    expect(results.filter(isDaemonStoodDown)).toHaveLength(5)
  }, 15_000)
})

describe('probeDaemonSocket (ppid-independent liveness)', () => {
  let server: DaemonServer | null = null
  afterEach(async () => {
    await server?.close()
    server = null
  })

  test('true when a real daemon answers with hello', async () => {
    const socketPath = tmp('sock')
    server = await startDaemonServer({
      socketPath,
      daemonVersion: '0.2.1',
      generation: 1,
      core: { handleTool: async () => ({}) },
    })
    await expect(probeDaemonSocket(socketPath)).resolves.toBe(true)
  })

  test('false when nothing is listening', async () => {
    await expect(probeDaemonSocket(tmp('sock'), 200)).resolves.toBe(false)
  })
})

type RacerResult =
  | { acquired: true }
  | { acquired: false; reason: 'held' | 'serving' }
  | { started: true }
  | { started: false; reason: 'held' | 'serving' }

function isLockAcquired(result: RacerResult): boolean {
  return 'acquired' in result && result.acquired
}

function isLockHeld(result: RacerResult): boolean {
  return 'acquired' in result && !result.acquired && result.reason === 'held'
}

function isDaemonStarted(result: RacerResult): boolean {
  return 'started' in result && result.started
}

function isDaemonStoodDown(result: RacerResult): boolean {
  return 'started' in result && !result.started && ['held', 'serving'].includes(result.reason)
}

interface RunningRacer {
  child: ChildProcess
  result: Promise<RacerResult>
}

function startRacer(
  worker: string,
  lockPath: string,
  socketPath: string,
  barrierPath: string,
  pid: number,
  releaseMode: 'release' | 'keep' | 'settle' = 'release',
  ...extraArgs: string[]
): RunningRacer {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', worker, lockPath, socketPath, barrierPath, String(pid), releaseMode, ...extraArgs],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const result = new Promise<RacerResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (value: RacerResult) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.trim().split('\n').at(-1)
      if (line) settle(JSON.parse(line) as RacerResult)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        reject(new Error(`racer exited ${code}: ${stderr}`))
        return
      }
      const line = stdout.trim().split('\n').at(-1)
      if (!line) {
        reject(new Error(`racer produced no output: ${stderr}`))
        return
      }
      settle(JSON.parse(line) as RacerResult)
    })
  })
  return { child, result }
}

async function collectRacers(racers: RunningRacer[]): Promise<RacerResult[]> {
  try {
    return await Promise.all(racers.map((r) => r.result))
  } finally {
    for (const { child } of racers) {
      if (child.exitCode === null) child.kill()
    }
  }
}

async function waitForReadyRacers(barrierPath: string, count: number): Promise<void> {
  const start = Date.now()
  while (readyRacerCount(barrierPath) < count) {
    if (Date.now() - start > 5_000) {
      throw new Error(`timed out waiting for ${count} daemon-lock racers`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMessage: string): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > 4_000) {
      throw new Error(timeoutMessage)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function readyRacerCount(barrierPath: string): number {
  const dir = dirname(barrierPath)
  const prefix = `${barrierPath.split('/').at(-1)}.`
  return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.ready')).length
}
