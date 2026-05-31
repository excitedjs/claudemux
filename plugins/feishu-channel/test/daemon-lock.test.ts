import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireDaemonLock,
  probeDaemonSocket,
  releaseDaemonLock,
  type DaemonLockRecord,
} from '../src/daemon-lock'
import { startDaemonServer, type DaemonServer } from '../src/daemon-server'

let n = 0
const tmp = (ext: string) => join(tmpdir(), `feishu-daemon-${process.pid}-${n++}.${ext}`)

function record(over: Partial<DaemonLockRecord> = {}): DaemonLockRecord {
  return { pid: 4242, startedAt: 1000, socketPath: tmp('sock'), daemonVersion: '0.2.1', ...over }
}

describe('daemon-lock acquisition', () => {
  test('acquires a free lock', async () => {
    const lockPath = tmp('lock')
    const r = await acquireDaemonLock({ lockPath, self: record(), isHolderAlive: async () => false })
    expect(r).toEqual({ acquired: true })
    expect(existsSync(lockPath)).toBe(true)
  })

  test('does not acquire when the holder is alive', async () => {
    const lockPath = tmp('lock')
    const holder = record({ pid: 111 })
    writeFileSync(lockPath, JSON.stringify(holder))
    const r = await acquireDaemonLock({
      lockPath,
      self: record({ pid: 222 }),
      isHolderAlive: async () => true,
    })
    expect(r).toEqual({ acquired: false, holder })
  })

  test('reclaims a stale lock (dead/unresponsive holder) and acquires', async () => {
    const lockPath = tmp('lock')
    writeFileSync(lockPath, JSON.stringify(record({ pid: 111, startedAt: 1 })))
    const self = record({ pid: 222, startedAt: 2 })
    const r = await acquireDaemonLock({ lockPath, self, isHolderAlive: async () => false })
    expect(r).toEqual({ acquired: true })
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(222)
  })

  test('release removes only our own lock, never a newer holder', async () => {
    const lockPath = tmp('lock')
    const self = record({ pid: 222, startedAt: 2 })
    writeFileSync(lockPath, JSON.stringify(self))
    releaseDaemonLock(lockPath, self)
    expect(existsSync(lockPath)).toBe(false)

    // a newer holder took the lock; our release must be a no-op
    const newer = record({ pid: 333, startedAt: 9 })
    writeFileSync(lockPath, JSON.stringify(newer))
    releaseDaemonLock(lockPath, self)
    expect(existsSync(lockPath)).toBe(true)
  })
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
