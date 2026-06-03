import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  collapseWrappers,
  probeChannelStatus,
  readConnectionLockHolder,
  readManifestVersionAt,
  readPinnedInstall,
  readStateDirHealth,
  isPidAlive,
} from '../src/doctor-probes'
import type { ServerProcess } from '../src/doctor'
import { FrameDecoder, encodeFrame, type ProxyToDaemon } from '../src/ipc'

function proc(pid: number, ppid: number, over: Partial<ServerProcess> = {}): ServerProcess {
  return {
    pid,
    ppid,
    command: 'node tsx src/server.ts --daemon',
    kind: 'daemon',
    source: 'cache',
    confidence: 'high',
    ...over,
  }
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-probes-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('probeChannelStatus — transient, no-register status read', () => {
  let server: Server
  let socketPath: string
  let received: ProxyToDaemon[]

  function startFakeDaemon(statusPayload: unknown): Promise<void> {
    received = []
    socketPath = join(tmp, 'daemon.sock')
    server = createServer((socket: Socket) => {
      const decoder = new FrameDecoder<ProxyToDaemon>()
      // Greet on connect, like the real daemon.
      socket.write(encodeFrame({ t: 'hello', daemonVersion: '0.7.0', generation: 1, pid: 4242 }))
      socket.on('data', (chunk: Buffer) => {
        for (const m of decoder.push(chunk)) {
          received.push(m)
          if (m.t === 'tool' && m.name === 'feishu_channel_status') {
            socket.write(
              encodeFrame({
                t: 'tool_result',
                id: m.id,
                ok: true,
                result: { content: [{ type: 'text', text: JSON.stringify(statusPayload) }] },
              }),
            )
          }
        }
      })
    })
    return new Promise((resolve) => server.listen(socketPath, resolve))
  }

  afterEach(() => {
    server?.close()
  })

  it('reads and parses the status without ever sending a register frame', async () => {
    const payload = {
      owner_session_id: 'dispatcher:aaa',
      dispatcher_session_id: 'dispatcher:aaa',
      granted_session_id: null,
      effective_target_session_id: 'dispatcher:aaa',
      lease_epoch: 2,
      sessions: [],
    }
    await startFakeDaemon(payload)
    const snapshot = await probeChannelStatus(socketPath, 1000)
    expect(snapshot?.owner_session_id).toBe('dispatcher:aaa')
    expect(snapshot?.lease_epoch).toBe(2)
    // The probe must NOT register — only a status tool call may be sent.
    expect(received.some((m) => m.t === 'register')).toBe(false)
    expect(received.filter((m) => m.t === 'tool')).toHaveLength(1)
  })

  it('resolves null when nothing is listening', async () => {
    const snapshot = await probeChannelStatus(join(tmp, 'absent.sock'), 300)
    expect(snapshot).toBeNull()
  })
})

describe('readPinnedInstall', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  })

  it('reads version + installPath from the nested plugins map', () => {
    const plugins = join(tmp, 'plugins')
    mkdirSync(plugins, { recursive: true })
    writeFileSync(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({
        version: 1,
        plugins: { 'feishu-channel@claudemux': [{ scope: 'user', version: '0.7.0', installPath: '/some/install/path' }] },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = tmp
    expect(readPinnedInstall()).toEqual({ version: '0.7.0', installPath: '/some/install/path' })
  })

  it('tolerates a flat (un-nested) shape', () => {
    const plugins = join(tmp, 'plugins')
    mkdirSync(plugins, { recursive: true })
    writeFileSync(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({ 'feishu-channel@claudemux': { version: '0.6.0', installPath: '/p' } }),
    )
    process.env.CLAUDE_CONFIG_DIR = tmp
    expect(readPinnedInstall()).toEqual({ version: '0.6.0', installPath: '/p' })
  })

  it('returns null on a missing or unparseable file', () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmp, 'nonexistent')
    expect(readPinnedInstall()).toBeNull()
  })
})

describe('readManifestVersionAt', () => {
  it('reads the version from a plugin manifest', () => {
    mkdirSync(join(tmp, '.claude-plugin'), { recursive: true })
    writeFileSync(join(tmp, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.2.3' }))
    expect(readManifestVersionAt(tmp)).toBe('1.2.3')
  })
  it('returns undefined when absent', () => {
    expect(readManifestVersionAt(join(tmp, 'nope'))).toBeUndefined()
  })
})

describe('readConnectionLockHolder', () => {
  it('returns null when there is no lockfile', () => {
    expect(readConnectionLockHolder(join(tmp, 'connection.lock'))).toBeNull()
  })
  it('reads a live holder (this process) and reports it alive', () => {
    const path = join(tmp, 'connection.lock')
    writeFileSync(path, `${process.pid}\n`)
    const holder = readConnectionLockHolder(path)
    expect(holder?.pid).toBe(process.pid)
    expect(holder?.alive).toBe(true)
  })
  it('reports a dead holder as not alive', () => {
    const path = join(tmp, 'connection.lock')
    // A pid that is essentially never live.
    writeFileSync(path, '999999999\n')
    const holder = readConnectionLockHolder(path)
    expect(holder?.pid).toBe(999999999)
    expect(holder?.alive).toBe(false)
  })
})

describe('readStateDirHealth — never surfaces secret values', () => {
  it('reports credential KEY presence without exposing values', () => {
    writeFileSync(join(tmp, '.env'), 'FEISHU_APP_ID=cli_supersecretid\nFEISHU_APP_SECRET=topsecretvalue\n')
    const health = readStateDirHealth(tmp)
    expect(health.envPresent).toBe(true)
    expect(health.hasAppId).toBe(true)
    expect(health.hasAppSecret).toBe(true)
    // The serialized health must not contain either secret value.
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain('cli_supersecretid')
    expect(serialized).not.toContain('topsecretvalue')
  })

  it('flags missing credentials', () => {
    const health = readStateDirHealth(tmp)
    expect(health.envPresent).toBe(false)
    expect(health.hasAppId).toBe(false)
    expect(health.hasAppSecret).toBe(false)
  })

  it('treats an empty credential value as missing, not present', () => {
    writeFileSync(join(tmp, '.env'), 'FEISHU_APP_ID=\nFEISHU_APP_SECRET=""\n')
    const health = readStateDirHealth(tmp)
    expect(health.envPresent).toBe(true)
    expect(health.hasAppId).toBe(false)
    expect(health.hasAppSecret).toBe(false)
  })

  it('classifies a corrupt access.json', () => {
    writeFileSync(join(tmp, '.env'), 'FEISHU_APP_ID=a\nFEISHU_APP_SECRET=b\n')
    writeFileSync(join(tmp, 'access.json'), '{ not valid json')
    expect(readStateDirHealth(tmp).accessParse).toBe('corrupt')
  })
})

describe('collapseWrappers — fold tsx launcher into its worker', () => {
  it('drops a matched parent that launched another matched process', () => {
    // 6478 (.bin/tsx launcher) is the parent of 6479 (the real worker/listener).
    const procs = [proc(6478, 6446), proc(6479, 6478)]
    const collapsed = collapseWrappers(procs)
    expect(collapsed.map((p) => p.pid)).toEqual([6479])
  })
  it('keeps independent daemons with unrelated parents', () => {
    const procs = [proc(100, 1), proc(200, 1)]
    expect(collapseWrappers(procs).map((p) => p.pid).sort()).toEqual([100, 200])
  })
})

describe('isPidAlive', () => {
  it('is true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })
  it('is false for an absurd pid and for invalid input', () => {
    expect(isPidAlive(999999999)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(0)).toBe(false)
  })
})
