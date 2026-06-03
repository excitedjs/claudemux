/**
 * The Claude stream-json broker — the long-lived, detached process that holds
 * one teammate's `claude` stream-json child and serves `tm` over a unix socket.
 *
 * `tm` is stateless and ephemeral; the persistent stream-json session it drives
 * must outlive any one `tm` call. So `tm` spawns this broker **detached** (the
 * same shape as the Codex daemon), and the broker:
 *
 *   - spawns `claude -p … --input-format stream-json` and holds its stdio;
 *   - demultiplexes the child's stdout envelopes (data plane + control plane)
 *     through the pure `protocol` parser, driving one turn at a time;
 *   - writes the `/tmp` turn signal (`<sid>` idle / `<sid>.busy` / `<sid>.last`)
 *     the fleet verbs read — so `tm states` / `tm last` keep working with the
 *     broker, not the retired hooks, as the signal's owner;
 *   - answers `tm`'s socket requests (send / wait / status / last / kill);
 *   - enables Remote Control on request by sending one `remote_control` control
 *     request and surfacing the returned claude.ai URL, then tolerating the
 *     unsolicited turns RC injects.
 *
 * This module runs only inside the detached broker process (entered via the
 * `__claude-broker` subcommand); `tm` itself never imports its loop, only the
 * `client` that talks to it.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import {
  buildCanUseToolAllow,
  buildControlAck,
  buildRemoteControlEnable,
  buildUserMessage,
  LineBuffer,
  parseLine,
  TurnAggregator,
  type JsonObject,
  type ParsedLine,
  type TurnOutcome,
} from './protocol'
import { buildClaudeArgs, buildClaudeEnv, claudeBinary, type BrokerSpawnParams } from './launch'
import { ensureBrokerDir, writeBrokerPid, writeMeta, type BrokerMeta } from './registry'
import {
  busyMarkerFor,
  claudeStreamSocket,
  cwdFile,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  sidFile,
} from '../../../persistence/paths'
import { readOneJsonLine, writeJsonLine, type BrokerRequest, type BrokerResponse, type WireTurn } from './wire'

function toWireTurn(out: TurnOutcome): WireTurn {
  return {
    isError: out.isError,
    text: out.text,
    stopReason: out.stopReason,
    inputTokens: out.usage?.inputTokens ?? null,
    outputTokens: out.usage?.outputTokens ?? null,
    cacheReadInputTokens: out.usage?.cacheReadInputTokens ?? null,
    totalCostUsd: out.totalCostUsd,
    numTurns: out.numTurns,
    durationMs: out.durationMs,
    sessionId: out.sessionId,
    subtype: out.subtype,
  }
}

/** One waiter on the next turn `result`, with an optional timeout. */
interface TurnWaiter {
  resolve: (turn: WireTurn | null) => void
  timer: NodeJS.Timeout | null
}

class Broker {
  private child: ChildProcess | null = null
  private server: Server | null = null
  private readonly lineBuf = new LineBuffer()
  private readonly meta: BrokerMeta
  private state: 'starting' | 'idle' | 'busy' = 'starting'
  private ready = false
  private lastText = ''
  private lastTurn: WireTurn | null = null
  private agg: TurnAggregator | null = null
  private waiters: TurnWaiter[] = []
  private rcRequestId: string | null = null
  private shuttingDown = false

  constructor(private readonly params: BrokerSpawnParams) {
    this.meta = {
      name: params.name,
      repo: params.repo,
      cwd: params.cwd,
      worktreeSlug: params.worktreeSlug,
      sessionId: params.sessionId ?? params.resumeSid,
      model: null,
      remoteControl: params.remoteControl,
      remoteControlUrl: null,
      startedAt: Math.floor(Date.now() / 1000),
    }
  }

  /** Boot the child + socket. Resolves with the process exit code. */
  async run(): Promise<number> {
    ensureBrokerDir(this.params.name)
    // The broker owns the `/tmp/claude-idle` turn signal now that the hooks are
    // gone, so it creates the marker dir itself rather than relying on setup.
    try {
      mkdirSync(idleDir(), { recursive: true })
    } catch {
      /* best-effort */
    }
    writeBrokerPid(this.params.name, process.pid)
    writeMeta(this.meta)
    // The pinned sid (fresh `--session-id` or `--resume`) is known up front, so
    // `tm` and the fleet verbs can locate the transcript before `init` lands.
    if (this.meta.sessionId !== null) this.writeSidFiles(this.meta.sessionId)

    const spawned = this.spawnChild()
    if (spawned !== null) {
      process.stderr.write(`[broker:${this.params.name}] ${spawned}\n`)
      return 1
    }
    try {
      await this.listen()
    } catch (err) {
      process.stderr.write(`[broker:${this.params.name}] socket bind failed: ${err instanceof Error ? err.message : String(err)}\n`)
      this.terminateChild()
      return 1
    }
    // Ready once the child is spawned and the socket is bound. The child does
    // NOT emit `init` until the first user message arrives, so readiness must
    // not wait on it — the sid is already pinned via `--session-id`/`--resume`.
    // `init` (which carries the model) lands when the first turn runs.
    this.ready = true
    this.state = 'idle'
    // Remote Control is a control-plane request, independent of the data-plane
    // turn loop, so enable it at startup rather than waiting for a turn.
    if (this.params.remoteControl) this.enableRemoteControl()
    return await new Promise<number>((resolve) => {
      this.onExit = resolve
    })
  }

  private onExit: ((code: number) => void) | null = null

  private spawnChild(): string | null {
    const bin = claudeBinary(process.env)
    const args = buildClaudeArgs({
      dispatcherDir: this.params.dispatcherDir,
      sessionId: this.params.resumeSid !== null ? null : this.params.sessionId,
      resumeSid: this.params.resumeSid,
    })
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        cwd: this.params.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildClaudeEnv(process.env, this.params.name),
      })
    } catch (err) {
      return `failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`
    }
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      for (const line of this.lineBuf.push(chunk)) this.onLine(parseLine(line))
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      process.stderr.write(`[claude:${this.params.name}] ${chunk}`)
    })
    child.on('error', (err) => {
      process.stderr.write(`[broker:${this.params.name}] child error: ${err.message}\n`)
    })
    child.on('exit', () => this.onChildExit())
    return null
  }

  // ─── Child stdout envelope handling ──────────────────────────────────────

  private onLine(line: ParsedLine): void {
    switch (line.kind) {
      case 'init':
        this.onInit(line.sessionId, line.model)
        break
      case 'status':
        if (line.status === 'requesting' || line.status === 'working') {
          this.ensureTurn()
          this.markBusy()
        }
        break
      case 'assistant':
        // The aggregator owns this turn's text (it prefers the result text and
        // falls back to the last assistant snapshot). The broker must NOT set
        // `lastText` from a mid-turn snapshot, or an empty/tool-only result
        // would leave the previous turn's reply standing.
        this.ensureTurn()
        this.agg!.accept(line)
        break
      case 'result':
        this.ensureTurn()
        this.agg!.accept(line)
        this.onResult()
        break
      case 'control_request':
        this.onControlRequest(line.requestId, line.subtype, line.request)
        break
      case 'control_response':
        this.onControlResponse(line.requestId, line.ok, line.response)
        break
      default:
        break
    }
  }

  /**
   * Ensure an aggregator exists for the turn now in flight. A turn the broker
   * did NOT start — driven by Remote Control or a channel inbound message, with
   * no `tm send` — produces the same `status` → `assistant` → `result` stream,
   * so it is aggregated identically. Without this, a spontaneous `result` would
   * find `agg === null`, drop the turn, leave `lastTurn` / `.last` stale, and
   * hand a waiting `tm wait --fresh` the previous turn instead of this one.
   */
  private ensureTurn(): void {
    if (this.agg === null) this.agg = new TurnAggregator()
  }

  private onInit(sessionId: string | null, model: string | null): void {
    // `init` arrives with the first turn (not at startup). Confirm/refresh the
    // session id and capture the model; readiness and RC are already handled in
    // `run()`.
    if (sessionId !== null) {
      if (sessionId !== this.meta.sessionId) this.meta.sessionId = sessionId
      this.writeSidFiles(sessionId)
    }
    if (model !== null) this.meta.model = model
    writeMeta(this.meta)
  }

  private onResult(): void {
    const outcome = this.agg?.outcome() ?? null
    const turn = outcome !== null ? toWireTurn(outcome) : null
    if (turn !== null) this.lastTurn = turn
    // `lastText` reflects THIS turn faithfully — empty for a tool-only or
    // empty-result turn — so `tm last` / `tm states` / `tm status` never show a
    // stale previous reply.
    this.lastText = turn !== null ? turn.text : ''
    this.agg = null
    this.markIdle()
    // Resolve every waiter (the originating `send`, any `wait`, and freshly
    // attached waiters) with this turn — including unsolicited RC/channel turns
    // that no `tm send` started.
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) {
      if (w.timer !== null) clearTimeout(w.timer)
      w.resolve(this.lastTurn)
    }
  }

  private onControlRequest(requestId: string | null, subtype: string | null, request: JsonObject): void {
    if (requestId === null || this.child?.stdin == null) return
    // Under --dangerously-skip-permissions the CLI does not ask, but answer
    // defensively so an unexpected callback never stalls a turn. A `can_use_tool`
    // allow must echo the tool's input back as `updatedInput`.
    let reply: string
    if (subtype === 'can_use_tool') {
      const rawInput = request['input']
      const input: JsonObject = typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput) ? (rawInput as JsonObject) : {}
      reply = buildCanUseToolAllow(requestId, input)
    } else {
      reply = buildControlAck(requestId)
    }
    this.child.stdin.write(`${reply}\n`)
  }

  private onControlResponse(requestId: string | null, ok: boolean, response: Record<string, unknown> | null): void {
    if (requestId !== null && requestId === this.rcRequestId) {
      if (ok && response !== null) {
        const url = response['session_url'] ?? response['connect_url']
        if (typeof url === 'string') {
          this.meta.remoteControlUrl = url
          writeMeta(this.meta)
        }
      } else {
        process.stderr.write(`[broker:${this.params.name}] remote control enable failed\n`)
      }
    }
  }

  private enableRemoteControl(): void {
    if (this.child?.stdin == null) return
    this.rcRequestId = randomUUID()
    this.child.stdin.write(`${buildRemoteControlEnable(this.rcRequestId)}\n`)
  }

  // ─── Turn signal (the /tmp protocol the fleet verbs read) ────────────────

  private writeSidFiles(sid: string): void {
    try {
      writeFileSync(sidFile(this.params.name), `${sid}\n`, 'utf8')
      writeFileSync(cwdFile(this.params.name), `${this.params.cwd}\n`, 'utf8')
    } catch {
      // best-effort; the socket remains the authoritative state surface.
    }
  }

  private markBusy(): void {
    this.state = 'busy'
    const sid = this.meta.sessionId
    if (sid === null) return
    try {
      writeFileSync(busyMarkerFor(sid), '', 'utf8')
      rmSync(idleMarkerFor(sid), { force: true })
    } catch {
      /* best-effort */
    }
  }

  private markIdle(): void {
    this.state = 'idle'
    const sid = this.meta.sessionId
    if (sid === null) return
    try {
      rmSync(busyMarkerFor(sid), { force: true })
      // A turn with no text removes `.last` (the old on-stop hook did the same
      // on an empty extract), so a tool-only turn does not leave stale text.
      if (this.lastText.length > 0) writeFileSync(lastFileFor(sid), this.lastText.endsWith('\n') ? this.lastText : `${this.lastText}\n`, 'utf8')
      else rmSync(lastFileFor(sid), { force: true })
      writeFileSync(idleMarkerFor(sid), '', 'utf8')
    } catch {
      /* best-effort */
    }
  }

  // ─── Socket server (tm ↔ broker) ─────────────────────────────────────────

  private listen(): Promise<void> {
    const socketPath = claudeStreamSocket(this.params.name)
    if (existsSync(socketPath)) rmSync(socketPath, { force: true })
    return new Promise((resolve, reject) => {
      const server = createServer((sock) => void this.onConnection(sock))
      server.on('error', reject)
      server.listen(socketPath, () => resolve())
      this.server = server
    })
  }

  private async onConnection(sock: Socket): Promise<void> {
    sock.setEncoding('utf8')
    let req: BrokerRequest | null
    try {
      req = await readOneJsonLine<BrokerRequest>(sock)
    } catch {
      sock.destroy()
      return
    }
    if (req === null) {
      sock.destroy()
      return
    }
    await this.handle(req, sock)
  }

  private reply(sock: Socket, res: BrokerResponse): void {
    writeJsonLine(sock, res)
    sock.end()
  }

  private async handle(req: BrokerRequest, sock: Socket): Promise<void> {
    switch (req.op) {
      case 'ping':
        this.reply(sock, { ok: true, kind: 'ping', ready: this.ready })
        return
      case 'status':
        this.reply(sock, {
          ok: true,
          kind: 'status',
          status: {
            sessionId: this.meta.sessionId,
            model: this.meta.model,
            state: this.state === 'busy' ? 'busy' : this.state === 'starting' ? 'starting' : 'idle',
            remoteControlUrl: this.meta.remoteControlUrl,
            lastText: this.lastText.length > 0 ? this.lastText : null,
          },
        })
        return
      case 'last':
        this.reply(sock, { ok: true, kind: 'last', text: this.lastText })
        return
      case 'send':
        this.handleSend(req.prompt, req.timeoutMs, sock)
        return
      case 'wait':
        this.handleWait(req.timeoutMs, req.fresh, sock)
        return
      case 'kill':
        this.reply(sock, { ok: true, kind: 'killed' })
        this.shutdown(0)
        return
      default:
        this.reply(sock, { ok: false, kind: 'error', message: 'unknown op' })
    }
  }

  private handleSend(prompt: string, timeoutMs: number | null, sock: Socket): void {
    if (this.child?.stdin == null || this.child.exitCode !== null) {
      this.reply(sock, { ok: false, kind: 'child-gone', message: 'claude child is not running' })
      return
    }
    if (this.state === 'busy' || this.agg !== null) {
      this.reply(sock, { ok: false, kind: 'busy', message: 'teammate is mid-turn' })
      return
    }
    this.agg = new TurnAggregator()
    this.markBusy()
    this.child.stdin.write(`${buildUserMessage(prompt)}\n`)
    this.attachWaiter(timeoutMs, sock)
  }

  private handleWait(timeoutMs: number | null, fresh: boolean, sock: Socket): void {
    // Not fresh and nothing in flight → return the last turn immediately.
    if (!fresh && this.agg === null && this.state !== 'busy') {
      this.reply(sock, { ok: true, kind: 'turn', turn: this.lastTurn ?? this.emptyTurn() })
      return
    }
    this.attachWaiter(timeoutMs, sock)
  }

  private attachWaiter(timeoutMs: number | null, sock: Socket): void {
    const waiter: TurnWaiter = {
      timer: null,
      resolve: (turn) => {
        if (turn === null) this.reply(sock, { ok: false, kind: 'child-gone', message: 'claude child exited mid-turn' })
        else this.reply(sock, { ok: true, kind: 'turn', turn })
      },
    }
    if (timeoutMs !== null && timeoutMs > 0) {
      const startedAt = Date.now()
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        this.reply(sock, { ok: false, kind: 'timed-out', message: 'turn did not finish in time', elapsedMs: Date.now() - startedAt })
      }, timeoutMs)
    }
    this.waiters.push(waiter)
  }

  private emptyTurn(): WireTurn {
    return {
      isError: false,
      text: this.lastText,
      stopReason: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      totalCostUsd: null,
      numTurns: null,
      durationMs: null,
      sessionId: this.meta.sessionId,
      subtype: null,
    }
  }

  // ─── Teardown ────────────────────────────────────────────────────────────

  private onChildExit(): void {
    if (this.shuttingDown) return
    // The child died on its own (crash, /exit, or end of input). Resolve any
    // waiters as child-gone and shut the broker down.
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) {
      if (w.timer !== null) clearTimeout(w.timer)
      w.resolve(null)
    }
    this.shutdown(0)
  }

  private terminateChild(): void {
    if (this.child !== null && this.child.exitCode === null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  private shutdown(code: number): void {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.terminateChild()
    const sid = this.meta.sessionId
    if (sid !== null) {
      rmSync(busyMarkerFor(sid), { force: true })
    }
    try {
      this.server?.close()
    } catch {
      /* ignore */
    }
    rmSync(claudeStreamSocket(this.params.name), { force: true })
    if (this.onExit !== null) this.onExit(code)
  }
}

/** Entry point for the `__claude-broker` subcommand. Runs until the child or a `kill` ends it. */
export async function brokerMain(params: BrokerSpawnParams): Promise<number> {
  const broker = new Broker(params)
  return await broker.run()
}
