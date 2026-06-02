/**
 * The `tm`-side client for the Claude stream-json broker.
 *
 * Every Claude-targeted `tm` verb runs here: `spawn` launches the detached
 * broker and waits for it to come up; `send` / `wait` / `status` / `last` /
 * `kill` open a one-shot unix-socket connection to an already-running broker.
 * This is the symmetric counterpart to the Codex `rpc` client — same "reconnect
 * per ephemeral `tm` invocation" model, over a plain socket instead of a
 * WebSocket because the payloads are line-delimited JSON.
 */

import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { openSync } from 'node:fs'

import {
  buildBrokerSpawnArgv,
  type BrokerSpawnParams,
} from './launch'
import {
  brokerAlive,
  ensureBrokerDir,
  writeBrokerPid,
} from './registry'
import { claudeStreamSocket, claudeStreamStderrLog, claudeStreamStdoutLog } from '../../../persistence/paths'
import { readOneJsonLine, writeJsonLine, type BrokerRequest, type BrokerResponse } from './wire'

/** How long `tm spawn` waits for a freshly launched broker to answer `ping`. */
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Open a one-shot connection to a teammate's broker socket. */
function connectBroker(name: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(claudeStreamSocket(name))
    const onError = (err: Error): void => {
      sock.off('connect', onConnect)
      reject(err)
    }
    const onConnect = (): void => {
      sock.off('error', onError)
      resolve(sock)
    }
    sock.once('error', onError)
    sock.once('connect', onConnect)
  })
}

/**
 * Send one request to a running broker and read its single response. Returns a
 * `child-gone`/`error` response when the socket cannot be reached, so callers
 * always get a typed `BrokerResponse` rather than a thrown connection error.
 */
export async function brokerRequest(name: string, req: BrokerRequest): Promise<BrokerResponse> {
  let sock: Socket
  try {
    sock = await connectBroker(name)
  } catch (err) {
    return { ok: false, kind: 'child-gone', message: `broker not reachable: ${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    sock.setEncoding('utf8')
    writeJsonLine(sock, req)
    const res = await readOneJsonLine<BrokerResponse>(sock)
    if (res === null) return { ok: false, kind: 'error', message: 'broker closed without a response' }
    return res
  } catch (err) {
    return { ok: false, kind: 'error', message: err instanceof Error ? err.message : String(err) }
  } finally {
    sock.destroy()
  }
}

/**
 * Spawn the detached broker for a teammate and wait until it answers `ping`
 * with `ready: true` (the child's `init` envelope has landed). Returns `null`
 * on success, or a human-readable error.
 */
export async function spawnBroker(params: BrokerSpawnParams): Promise<string | null> {
  ensureBrokerDir(params.name)
  const stdout = openSync(claudeStreamStdoutLog(params.name), 'a')
  const stderr = openSync(claudeStreamStderrLog(params.name), 'a')
  const { command, args } = buildBrokerSpawnArgv(params)
  const child = spawn(command, args, {
    cwd: params.cwd,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: process.env,
  })
  if (typeof child.pid === 'number') writeBrokerPid(params.name, child.pid)
  child.unref()

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      return `broker exited early (code ${child.exitCode}); see ${claudeStreamStderrLog(params.name)}`
    }
    if (brokerAlive(params.name)) {
      const ping = await brokerRequest(params.name, { op: 'ping' })
      if (ping.ok && ping.kind === 'ping' && ping.ready) return null
    }
    await sleep(READY_POLL_MS)
  }
  return `broker did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)}s; see ${claudeStreamStderrLog(params.name)}`
}
