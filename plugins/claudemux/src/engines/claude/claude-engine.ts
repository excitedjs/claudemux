/**
 * `ClaudeEngine implements Engine` — the Claude Code engine, driven over the
 * **stream-json stdio broker** (issue #49). Every teammate is a persistent
 * `claude -p --input-format stream-json` child held by a detached per-teammate
 * broker; `tm` reaches it over the broker's unix socket. There is no tmux
 * session, no `send-keys`, and no `capture-pane` — turn lifecycle, reply text,
 * token usage, cost, and stop reason all come from the structured `result`
 * envelope instead of being scraped from a rendered pane.
 *
 * The fleet verbs (`list`, `status`, `kill`) enumerate from the broker process
 * registry rather than `tmux ls`; the turn signal the waiting verbs read
 * (`<sid>` / `<sid>.busy` / `<sid>.last`) is written by the broker, not the
 * retired hooks. Decision multi-engine-tui-architecture's engine interface is
 * unchanged: every method is present, every result is a discriminated union.
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import type {
  CompactRequest,
  CompactResult,
  ContextRequest,
  ContextResult,
  DoctorSection,
  EngineCapabilities,
  EngineContext,
  EngineKind,
  EngineSnapshot,
  InspectRequest,
  KillRequest,
  KillResult,
  LastRequest,
  MemoryRequest,
  ReloadRequest,
  ReloadResult,
  ResumeRequest,
  ResumeResult,
  SendRequest,
  SpawnRequest,
  SpawnResult,
  StatusRequest,
  TeammateName,
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from '../types'
import type { Engine } from '../engine'
import type { NativeEnv } from '../../env'
import { claudeCtxLine, claudeCtxUsage } from './ctx'
import { claudeDoctor } from './doctor'
import { claudeLast } from './last'
import { claudeMem } from './mem'
import { claudeReload } from './reload'
import { dieRepoNotFound } from './repo-fs'
import { readSid } from './fs-util'
import { ClaudeTeammateRecord } from './persistence'
import { provisionWorktree, reapWorktree } from '../git-worktree'
import { spawnBroker, brokerRequest } from './stream-json/client'
import { brokerAlive, listLiveBrokers, readBrokerPid, readMeta, removeBrokerDir } from './stream-json/registry'
import type { BrokerSpawnParams } from './stream-json/launch'
import type { BrokerResponse, WireTurn } from './stream-json/wire'
import {
  busyMarkerFor,
  claudeStreamSocket,
  cwdFile,
  idleMarkerFor,
  lastFileFor,
  sidFile,
} from '../../persistence/paths'
import { pluginJsonPath, tmWrapperPath } from '../../plugin-root'
import type { TmResult } from '../../tm'
import {
  read as readIdentity,
  remove as removeIdentity,
  reserve as reserveIdentity,
} from '../../persistence/identity-store'

/** The Claude engine's capability report (stream-json transport). */
export const CLAUDE_CAPABILITIES: EngineCapabilities = {
  atomicSend: true,
  atomicSpawnPrompt: true,
  compaction: 'manual',
  contextUsage: 'transcript-jsonl',
  memory: 'claude-project-memory',
  reload: 'prompt-command',
  resume: 'transcript-id',
  detachedTurn: 'best-effort-push',
  events: 'push',
} as const

const NO_TEXT_SENTINEL = '(no text reply this turn — tool-only, /compact, /clear, or fresh spawn)\n'

function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Lookup a teammate's recorded cwd from the broker-written `.cwd` pointer. */
function readCwd(name: string): string | null {
  try {
    const trimmed = rstrip(readFileSync(cwdFile(name), 'utf8'))
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Decide a teammate's `idle`/`busy`/`unknown` state from the broker signal. */
function deriveState(name: string): 'idle' | 'busy' | 'unknown' {
  const sid = readSid(name)
  if (sid !== null && existsSync(busyMarkerFor(sid))) return 'busy'
  if (sid !== null && existsSync(idleMarkerFor(sid))) return 'idle'
  return brokerAlive(name) ? 'idle' : 'unknown'
}

/** Compact relative age — `tm`'s `60s` / `5m` / `2h` / `3d`. */
function fmtAge(ageSec: number): string {
  if (ageSec < 90) return `${Math.max(0, ageSec)}s`
  if (ageSec < 5400) return `${Math.round(ageSec / 60)}m`
  if (ageSec < 129600) return `${Math.round(ageSec / 3600)}h`
  return `${Math.round(ageSec / 86400)}d`
}

/** `tm states` LAST / PREVIEW cells, read from the broker-written `.last` file. */
function lastExtras(sid: string | null, now: number): { last: string; preview: string } {
  if (sid === null) return { last: '-', preview: '-' }
  try {
    const st = statSync(lastFileFor(sid))
    if (st.size === 0) return { last: '-', preview: '-' }
    const last = `${st.size}B/${fmtAge(now - Math.floor(st.mtimeMs / 1000))}`
    const firstLine = (readFileSync(lastFileFor(sid), "utf8").split("\n")[0] ?? "").replace(/[\x00-\x1f]/g, "")
    return { last, preview: firstLine.length > 0 ? Array.from(firstLine).slice(0, 50).join('') : '-' }
  } catch {
    return { last: '-', preview: '-' }
  }
}

/** Render the per-turn usage line surfaced on stderr (the old `ctx:` echo). */
function usageLine(turn: WireTurn): string {
  const parts: string[] = []
  if (turn.inputTokens !== null) parts.push(`in=${turn.inputTokens}`)
  if (turn.outputTokens !== null) parts.push(`out=${turn.outputTokens}`)
  if (turn.cacheReadInputTokens !== null) parts.push(`cache=${turn.cacheReadInputTokens}`)
  if (turn.totalCostUsd !== null) parts.push(`cost=$${turn.totalCostUsd.toFixed(4)}`)
  return parts.length > 0 ? `ctx: ${parts.join(' ')}\n` : ''
}

/** Map a broker turn response into the engine's `TurnResult`. */
function mapTurn(res: BrokerResponse): TurnResult {
  if (res.ok && res.kind === 'turn') {
    const turn = res.turn
    const text = turn.text.length > 0 ? `${rstrip(turn.text)}\n` : NO_TEXT_SENTINEL
    const tmResult: TmResult = { code: turn.isError ? 1 : 0, stdout: text, stderr: usageLine(turn) }
    if (turn.isError) {
      return { kind: 'failed', message: rstrip(turn.text) || 'turn ended in error', recoverable: false, tmResult }
    }
    return { kind: 'completed', text: turn.text, items: [], context: null, tmResult }
  }
  if (!res.ok && res.kind === 'timed-out') {
    return { kind: 'timed-out', elapsedMs: res.elapsedMs ?? 0, tmResult: { code: 124, stdout: '', stderr: `tm: ${res.message}\n` } }
  }
  if (!res.ok && res.kind === 'busy') {
    return { kind: 'failed', message: res.message, recoverable: false, tmResult: { code: 1, stdout: '', stderr: `tm: ${res.message}\n` } }
  }
  const message = !res.ok ? res.message : 'unexpected broker response'
  const recoverable = !res.ok && res.kind === 'child-gone'
  return { kind: 'failed', message, recoverable, tmResult: { code: 1, stdout: '', stderr: `tm: ${message}\n` } }
}

type ClaudeIdentityReservation =
  | { kind: 'reserved' }
  | { kind: 'preexisting' }
  | { kind: 'already-exists'; existingEngine: EngineKind }
  | { kind: 'failed'; result: TmResult }

function reserveClaudeIdentityForLaunch(args: {
  readonly name: TeammateName
  readonly repo: string
  readonly cwd: string
  readonly worktreeSlug: string | null
  readonly displayName: string | null
  readonly env: NativeEnv
  readonly nowMs: number
  readonly verb: 'spawn' | 'resume'
}): ClaudeIdentityReservation {
  const existing = readIdentity(args.name)
  if (existing !== null) {
    return existing.engine === 'claude'
      ? { kind: 'preexisting' }
      : { kind: 'already-exists', existingEngine: existing.engine }
  }
  try {
    if (!statSync(args.repo).isDirectory()) {
      return { kind: 'failed', result: dieRepoNotFound(args.verb, args.name, args.repo, args.env.dispatcherDir) }
    }
  } catch {
    return { kind: 'failed', result: dieRepoNotFound(args.verb, args.name, args.repo, args.env.dispatcherDir) }
  }
  const record = new ClaudeTeammateRecord({
    name: args.name,
    repo: realpathSync(args.repo),
    cwd: args.cwd,
    worktreeSlug: args.worktreeSlug,
    createdAt: Math.floor(args.nowMs / 1000),
    displayName: args.displayName,
  })
  const reserved = reserveIdentity(record.toJson())
  if (reserved.kind === 'reserved') return { kind: 'reserved' }
  if (reserved.kind === 'taken') return { kind: 'already-exists', existingEngine: reserved.existing.engine }
  return { kind: 'failed', result: { code: 1, stdout: '', stderr: `tm: ${reserved.message}\n` } }
}

/** `ClaudeEngine` — the Claude Code engine over the stream-json broker. */
export class ClaudeEngine implements Engine {
  readonly kind: EngineKind = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  constructor(private readonly env: NativeEnv) {}

  // ─── Fleet visibility ──────────────────────────────────────────────

  async list(ctx: EngineContext): Promise<readonly TeammateListing[]> {
    const now = Math.floor(ctx.now() / 1000)
    const out: TeammateListing[] = []
    for (const name of listLiveBrokers()) {
      const identity = readIdentity(name)
      const meta = readMeta(name)
      const sid = readSid(name)
      const { last, preview } = lastExtras(sid, now)
      out.push({
        name,
        engine: 'claude',
        state: deriveState(name),
        repo: identity?.repo ?? meta?.repo ?? '',
        cwd: identity?.cwd ?? meta?.cwd ?? readCwd(name) ?? '',
        worktreeSlug: identity?.worktreeSlug ?? meta?.worktreeSlug ?? null,
        displayName: identity?.displayName ?? null,
        extras: {
          sidShort: (sid ?? '').slice(0, 8),
          model: meta?.model ?? '',
          rc: meta?.remoteControlUrl ?? '',
          last,
          preview,
        },
      })
    }
    return out
  }

  async status(req: StatusRequest, _ctx: EngineContext): Promise<TeammateStatus> {
    if (!brokerAlive(req.name)) return { kind: 'not-found' }
    const res = await brokerRequest(req.name, { op: 'status' })
    if (!res.ok || res.kind !== 'status') {
      return { kind: 'failed', message: !res.ok ? res.message : 'unexpected status response' }
    }
    const s = res.status
    const diagnostics: Record<string, string> = {
      sessionId: s.sessionId ?? '',
      model: s.model ?? '',
      socket: claudeStreamSocket(req.name),
    }
    if (s.remoteControlUrl !== null) diagnostics['remoteControl'] = s.remoteControlUrl
    return {
      kind: 'present',
      name: req.name,
      engine: 'claude',
      state: s.state === 'busy' ? 'busy' : 'idle',
      cwd: readCwd(req.name) ?? readMeta(req.name)?.cwd ?? '',
      // No attachable pane in headless stream-json; surface the latest reply
      // text as the closest observability analogue.
      pane: s.lastText,
      diagnostics,
    }
  }

  async kill(req: KillRequest, _ctx: EngineContext): Promise<KillResult> {
    const identity = readIdentity(req.name)
    const meta = readMeta(req.name)
    const sid = readSid(req.name)
    const wasAlive = brokerAlive(req.name)

    if (wasAlive) {
      await brokerRequest(req.name, { op: 'kill' })
    } else if (readBrokerPid(req.name) === null && identity === null) {
      return { kind: 'not-found' }
    }

    if (sid !== null) {
      rmSync(idleMarkerFor(sid), { force: true })
      rmSync(lastFileFor(sid), { force: true })
      rmSync(busyMarkerFor(sid), { force: true })
    }
    rmSync(sidFile(req.name), { force: true })
    rmSync(cwdFile(req.name), { force: true })
    removeBrokerDir(req.name)

    let note: string | undefined
    const repo = identity?.repo ?? meta?.repo ?? null
    const slug = identity?.worktreeSlug ?? meta?.worktreeSlug ?? null
    if (repo !== null && slug !== null) {
      const reap = await reapWorktree(repo, slug)
      if (reap.kind === 'preserved-dirty') note = `${req.name}: worktree has uncommitted changes — preserved at ${reap.path}.\n`
      else if (reap.kind === 'preserved-unmerged') note = `${req.name}: branch ${reap.branch} has unmerged commits — worktree restored at ${reap.path}.\n`
      else if (reap.kind === 'failed') note = `${req.name}: worktree cleanup failed: ${reap.message}\n`
    }
    return note !== undefined ? { kind: 'killed', note } : { kind: 'killed' }
  }

  // ─── Hot path ──────────────────────────────────────────────────────

  async spawn(req: SpawnRequest, ctx: EngineContext): Promise<SpawnResult> {
    const identity = reserveClaudeIdentityForLaunch({
      name: req.name,
      repo: req.repo,
      cwd: req.cwd,
      worktreeSlug: req.worktreeSlug,
      displayName: req.displayName,
      env: this.env,
      nowMs: ctx.now(),
      verb: 'spawn',
    })
    if (identity.kind === 'already-exists') return { kind: 'already-exists', existingEngine: identity.existingEngine }
    if (identity.kind === 'failed') {
      return { kind: 'failed', message: rstrip(identity.result.stderr) || rstrip(identity.result.stdout), tmResult: identity.result }
    }

    if (req.worktreeSlug !== null) {
      const wtErr = await provisionWorktree(req.repo, req.worktreeSlug)
      if (wtErr !== null) {
        if (identity.kind === 'reserved') removeIdentity(req.name)
        return { kind: 'failed', message: wtErr, tmResult: { code: 1, stdout: '', stderr: `tm: ${wtErr}\n` } }
      }
    }

    const params: BrokerSpawnParams = {
      name: req.name,
      repo: req.repo,
      cwd: req.cwd,
      worktreeSlug: req.worktreeSlug,
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
      sessionId: req.resumeCheckpoint !== null ? null : randomUUID(),
      resumeSid: req.resumeCheckpoint,
      remoteControl: req.remoteControl,
    }
    const brokerErr = await spawnBroker(params)
    if (brokerErr !== null) {
      if (identity.kind === 'reserved' && !brokerAlive(req.name)) removeIdentity(req.name)
      removeBrokerDir(req.name)
      return { kind: 'failed', message: brokerErr, tmResult: { code: 1, stdout: '', stderr: `tm: ${brokerErr}\n` } }
    }

    let firstTurn: TurnResult | null = null
    if (req.prompt !== null) {
      firstTurn = mapTurn(await brokerRequest(req.name, { op: 'send', prompt: req.prompt, timeoutMs: req.timeoutMs }))
    }
    const spawnStdout = `spawned ${req.name}\n`
    return {
      kind: 'spawned',
      name: req.name,
      tmResult: firstTurn?.tmResult ?? { code: 0, stdout: spawnStdout, stderr: '' },
      firstTurn,
    }
  }

  async send(req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    if (!brokerAlive(req.name)) {
      const msg = `no running teammate '${req.name}'`
      return { kind: 'failed', message: msg, recoverable: false, tmResult: { code: 1, stdout: '', stderr: `tm: ${msg}\n` } }
    }
    return mapTurn(await brokerRequest(req.name, { op: 'send', prompt: req.prompt, timeoutMs: req.timeoutMs }))
  }

  async wait(req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    if (!brokerAlive(req.name)) {
      const msg = `no running teammate '${req.name}'`
      return { kind: 'failed', message: msg, recoverable: true, tmResult: { code: 1, stdout: '', stderr: `tm: ${msg}\n` } }
    }
    return mapTurn(await brokerRequest(req.name, { op: 'wait', timeoutMs: req.timeoutMs, fresh: req.fresh }))
  }

  async compact(req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    if (!brokerAlive(req.name)) {
      return { kind: 'failed', message: `no running teammate '${req.name}'`, tmResult: { code: 1, stdout: '', stderr: `tm: no running teammate '${req.name}'\n` } }
    }
    const res = await brokerRequest(req.name, { op: 'send', prompt: '/compact', timeoutMs: req.timeoutMs })
    if (res.ok && res.kind === 'turn' && !res.turn.isError) return { kind: 'compacted', tmResult: { code: 0, stdout: 'compacted\n', stderr: '' } }
    const message = res.ok ? 'compact did not complete' : res.message
    return { kind: 'failed', message, tmResult: { code: 1, stdout: '', stderr: `tm: ${message}\n` } }
  }

  async resume(req: ResumeRequest, ctx: EngineContext): Promise<ResumeResult> {
    const resumeRepo = req.repo ?? req.cwd ?? this.env.dispatcherDir
    const resumeCwd = req.cwd ?? resumeRepo
    const identity = reserveClaudeIdentityForLaunch({
      name: req.name,
      repo: resumeRepo,
      cwd: resumeCwd,
      worktreeSlug: req.worktreeSlug,
      displayName: req.displayName,
      env: this.env,
      nowMs: ctx.now(),
      verb: 'resume',
    })
    if (identity.kind === 'already-exists') {
      return { kind: 'failed', message: `'${req.name}' already exists as a ${identity.existingEngine} teammate` }
    }
    if (identity.kind === 'failed') {
      return { kind: 'failed', message: rstrip(identity.result.stderr) || rstrip(identity.result.stdout), tmResult: identity.result }
    }
    if (req.worktreeSlug !== null) {
      const wtErr = await provisionWorktree(resumeRepo, req.worktreeSlug)
      if (wtErr !== null) {
        if (identity.kind === 'reserved') removeIdentity(req.name)
        return { kind: 'failed', message: wtErr, tmResult: { code: 1, stdout: '', stderr: `tm: ${wtErr}\n` } }
      }
    }
    const params: BrokerSpawnParams = {
      name: req.name,
      repo: resumeRepo,
      cwd: resumeCwd,
      worktreeSlug: req.worktreeSlug,
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
      sessionId: null,
      resumeSid: req.checkpoint,
      remoteControl: false,
    }
    const brokerErr = await spawnBroker(params)
    if (brokerErr !== null) {
      if (identity.kind === 'reserved' && !brokerAlive(req.name)) removeIdentity(req.name)
      removeBrokerDir(req.name)
      return { kind: 'failed', message: brokerErr, tmResult: { code: 1, stdout: '', stderr: `tm: ${brokerErr}\n` } }
    }
    let tmResult: TmResult = { code: 0, stdout: `resumed ${req.name}\n`, stderr: '' }
    if (req.prompt !== null) {
      const turn = mapTurn(await brokerRequest(req.name, { op: 'send', prompt: req.prompt, timeoutMs: null }))
      if (turn.tmResult !== undefined) tmResult = turn.tmResult
    }
    return { kind: 'resumed', checkpoint: req.checkpoint, tmResult }
  }

  async last(req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    if (req.verbose) return { kind: 'not-supported', reason: 'raw turn JSON is only available for codex teammates' }
    return claudeLast(req.name)
  }

  async ctx(req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    const structured = claudeCtxUsage(req.name, { dispatcherDir: this.env.dispatcherDir, projectsDir: this.env.projectsDir })
    return {
      ...structured,
      tmResult: { code: 0, stdout: `${claudeCtxLine(req.name, req.windowOverride, this.env)}\n`, stderr: '' },
    }
  }

  async mem(req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return claudeMem(req.name, { dispatcherDir: this.env.dispatcherDir, projectsDir: this.env.projectsDir })
  }

  async reload(req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    const result = await claudeReload([req.name])
    if (result.code === 0) return { kind: 'reloaded', tmResult: result }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
  }

  // ─── Diagnostic ─────────────────────────────────────────────────────

  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return {
      engine: 'claude',
      name: req.name,
      fields: {
        sid: readSid(req.name) ?? '',
        cwd: readCwd(req.name) ?? '',
        brokerPid: String(readBrokerPid(req.name) ?? ''),
        socket: claudeStreamSocket(req.name),
        alive: String(brokerAlive(req.name)),
      },
    }
  }

  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    const result = await claudeDoctor([], { tmWrapper: tmWrapperPath(), pluginJson: pluginJsonPath(), dispatcherDir: this.env.dispatcherDir })
    return {
      engine: 'claude',
      findings: [
        {
          severity: result.code === 0 ? 'ok' : 'warn',
          summary: rstrip(result.stdout) || rstrip(result.stderr) || 'no doctor output',
          fix: null,
        },
      ],
    }
  }
}
