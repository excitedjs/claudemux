/**
 * Per-dispatcher `tm spawn` prompt preamble (issue #25).
 *
 * An operator can keep a standing first-turn reminder in one profile file
 * (`<dispatcherDir>/.tm-preamble.json`) instead of hand-pasting it into
 * every `--prompt`. A fresh `tm spawn --prompt` prepends the matching entry
 * to the prompt; `--no-preamble` opts a single spawn out, and a missing
 * profile is a no-op so current behavior is unchanged when the feature is
 * unused.
 *
 * These tests pin the moving parts:
 *   - the CLI flag parses into `noPreamble`;
 *   - `resolvePreamble` applies per-repo > default > none, normalises repo
 *     keys via `realpath` (so a symlinked key still matches), opts a repo
 *     out via an explicit empty entry, and fails loud on a malformed file;
 *   - the dispatch wiring actually prepends to the prompt the engine sees,
 *     and respects `--no-preamble`, `--resume`, and the no-profile no-op.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { parseSpawnArgs } from '../src/shared/verb-args'
import {
  applyPreamble,
  preambleProfilePath,
  resolvePreamble,
} from '../src/cli/preamble'
import { runCli } from '../src/cli'
import { EngineRegistry } from '../src/engines/registry'
import type { Engine } from '../src/engines/engine'
import type { NativeEnv } from '../src/env'
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
  HistoryRequest,
  HistoryResult,
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
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from '../src/engines/types'

// ─── parseSpawnArgs: --no-preamble ────────────────────────────────────────

describe('parseSpawnArgs — --no-preamble', () => {
  test('--no-preamble sets noPreamble true', () => {
    const result = parseSpawnArgs(['--no-preamble'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.noPreamble).toBe(true)
  })

  test('absent leaves noPreamble false', () => {
    const result = parseSpawnArgs(['--name', 'alpha'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.noPreamble).toBe(false)
  })

  test('coexists with other spawn flags', () => {
    const result = parseSpawnArgs(['--name', 'alpha', '--prompt', 'do X', '--no-preamble'])
    if ('error' in result) throw new Error('unexpected parse error')
    expect(result.noPreamble).toBe(true)
    expect(result.hasPrompt).toBe(true)
    expect(result.prompt).toBe('do X')
  })
})

// ─── resolvePreamble: profile lookup semantics ────────────────────────────

describe('resolvePreamble — profile lookup', () => {
  let dispatcherDir: string
  let repo: string

  beforeEach(() => {
    dispatcherDir = mkdtempSync('/tmp/cmx-preamble-')
    repo = realpathSync(dispatcherDir) + '/repo-a'
    mkdirSync(repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(dispatcherDir, { recursive: true, force: true })
  })

  function writeProfile(profile: unknown): void {
    writeFileSync(preambleProfilePath(dispatcherDir), JSON.stringify(profile))
  }

  test('no profile file → no-op (preamble null)', () => {
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBeNull()
  })

  test('per-repo entry wins', () => {
    writeProfile({ default: 'fallback', repos: { [repo]: 'repo reminder' } })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBe('repo reminder')
  })

  test('falls back to default when no per-repo entry matches', () => {
    writeProfile({ default: 'fallback', repos: { '/some/other/repo': 'nope' } })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBe('fallback')
  })

  test('a symlinked repo key still matches via realpath normalization', () => {
    const linkPath = join(dispatcherDir, 'repo-a-link')
    symlinkSync(repo, linkPath)
    // Profile is keyed by the symlink; the spawn resolves the canonical repo.
    writeProfile({ repos: { [linkPath]: 'via symlink' } })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBe('via symlink')
  })

  test('an explicit empty per-repo entry opts that repo out (no default fallback)', () => {
    writeProfile({ default: 'fallback', repos: { [repo]: '   ' } })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBeNull()
  })

  test('empty default + no match → null', () => {
    writeProfile({ default: '' })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBeNull()
  })

  test('a matched per-repo entry that is not a string fails loud (not a silent opt-out)', () => {
    writeProfile({ default: 'fallback', repos: { [repo]: 123 } })
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.stderr).toContain('"repos" entry')
    expect(r.error.stderr).toContain('must be a string')
    expect(r.error.stderr).toContain('--no-preamble')
  })

  test('a non-string default fails loud', () => {
    writeProfile({ default: 123 })
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.stderr).toContain('"default" must be a string')
  })

  test('a non-object repos fails loud', () => {
    writeProfile({ repos: 'nope' })
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.stderr).toContain('"repos" must be an object')
  })

  test('an array repos fails loud', () => {
    writeProfile({ repos: [] })
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.stderr).toContain('"repos" must be an object')
  })

  test('trailing whitespace in the preamble is trimmed', () => {
    writeProfile({ default: 'reminder\n\n' })
    const r = resolvePreamble(dispatcherDir, repo)
    if ('error' in r) throw new Error('unexpected error')
    expect(r.preamble).toBe('reminder')
  })

  test('malformed JSON → error naming the path', () => {
    writeFileSync(preambleProfilePath(dispatcherDir), '{ not json')
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.code).toBe(1)
    expect(r.error.stderr).toContain(preambleProfilePath(dispatcherDir))
    expect(r.error.stderr).toContain('--no-preamble')
  })

  test('a non-object top-level (array) → error', () => {
    writeProfile(['not', 'an', 'object'])
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.stderr).toContain('must be a JSON object')
  })

  test('an unreadable profile (a directory at the path) fails loud, not a no-op', () => {
    // A directory where the file is expected is a non-ENOENT read error: the
    // operator put *something* there, so it must not be silently skipped.
    mkdirSync(preambleProfilePath(dispatcherDir))
    const r = resolvePreamble(dispatcherDir, repo)
    expect('error' in r).toBe(true)
    if (!('error' in r)) throw new Error('expected an error')
    expect(r.error.code).toBe(1)
    expect(r.error.stderr).toContain(preambleProfilePath(dispatcherDir))
    expect(r.error.stderr).toContain('--no-preamble')
  })
})

// ─── applyPreamble: prepend shape ─────────────────────────────────────────

describe('applyPreamble', () => {
  test('prepends with a blank-line separator', () => {
    expect(applyPreamble('reminder', 'do X')).toBe('reminder\n\ndo X')
  })
})

// ─── dispatch wiring: the engine sees the prepended prompt ─────────────────

const capabilities: EngineCapabilities = {
  atomicSend: true,
  atomicSpawnPrompt: true,
  compaction: 'manual',
  contextUsage: 'transcript-jsonl',
  history: 'transcript-files',
  memory: 'claude-project-memory',
  reload: 'prompt-command',
  resume: 'transcript-id',
  detachedTurn: 'replayable',
  events: 'synthesized',
}

/** A claude-kind engine that records the prompt each `spawn` receives. */
class CapturingEngine implements Engine {
  readonly kind: EngineKind = 'claude'
  readonly capabilities = capabilities
  lastPrompt: string | null = null

  async spawn(req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    this.lastPrompt = req.prompt
    return { kind: 'spawned', name: req.name, firstTurn: null }
  }
  async send(_req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    return { kind: 'completed', text: '', items: [], context: null }
  }
  async wait(_req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    return { kind: 'completed', text: '', items: [], context: null }
  }
  async kill(_req: KillRequest, _ctx: EngineContext): Promise<KillResult> {
    return { kind: 'killed' }
  }
  async list(_ctx: EngineContext): Promise<readonly TeammateListing[]> {
    return []
  }
  async status(_req: StatusRequest, _ctx: EngineContext): Promise<TeammateStatus> {
    return { kind: 'not-found' }
  }
  async compact(_req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async resume(_req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async last(_req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'text', text: '' }
  }
  async ctx(_req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async history(_req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async mem(_req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async reload(_req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return { engine: this.kind, name: req.name, fields: {} }
  }
  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    return { engine: this.kind, findings: [] }
  }
}

describe('tm spawn — prompt preamble wiring', () => {
  let savedIdentityRoot: string | undefined
  let identityRoot: string
  let dispatcherDir: string
  let repoLeaf: string
  let repoPath: string

  beforeEach(() => {
    savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
    identityRoot = mkdtempSync('/tmp/cmx-preamble-id-')
    process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityRoot
    dispatcherDir = mkdtempSync('/tmp/cmx-preamble-disp-')
    repoLeaf = 'repo-a'
    repoPath = join(dispatcherDir, repoLeaf)
    mkdirSync(repoPath, { recursive: true })
  })

  afterEach(() => {
    if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
    else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
    rmSync(identityRoot, { recursive: true, force: true })
    rmSync(dispatcherDir, { recursive: true, force: true })
  })

  function envWith(engine: CapturingEngine): NativeEnv {
    const registry = new EngineRegistry()
    registry.register(engine)
    return {
      runTmux: async () => ({ code: 0, stdout: '', stderr: '' }),
      runColumn: async (input) => ({ code: 0, stdout: input, stderr: '' }),
      runGrep: async () => 1,
      dispatcherDir,
      projectsDir: identityRoot,
      engines: registry,
    }
  }

  function writeProfile(profile: unknown): void {
    writeFileSync(preambleProfilePath(dispatcherDir), JSON.stringify(profile))
  }

  test('a configured default is prepended to --prompt', async () => {
    writeProfile({ default: 'standing reminder' })
    const engine = new CapturingEngine()
    const result = await runCli(
      ['spawn', repoLeaf, '--name', 'tm-a', '--prompt', 'do X'],
      envWith(engine),
    )
    expect(result.code).toBe(0)
    expect(engine.lastPrompt).toBe('standing reminder\n\ndo X')
  })

  test('a per-repo entry beats the default', async () => {
    const repoReal = realpathSync(repoPath)
    writeProfile({ default: 'fallback', repos: { [repoReal]: 'repo-specific' } })
    const engine = new CapturingEngine()
    await runCli(['spawn', repoLeaf, '--name', 'tm-b', '--prompt', 'do X'], envWith(engine))
    expect(engine.lastPrompt).toBe('repo-specific\n\ndo X')
  })

  test('--no-preamble opts out: the prompt reaches the engine verbatim', async () => {
    writeProfile({ default: 'standing reminder' })
    const engine = new CapturingEngine()
    await runCli(
      ['spawn', repoLeaf, '--name', 'tm-c', '--prompt', 'do X', '--no-preamble'],
      envWith(engine),
    )
    expect(engine.lastPrompt).toBe('do X')
  })

  test('no profile file → prompt reaches the engine verbatim (no-op)', async () => {
    const engine = new CapturingEngine()
    await runCli(['spawn', repoLeaf, '--name', 'tm-d', '--prompt', 'do X'], envWith(engine))
    expect(engine.lastPrompt).toBe('do X')
  })

  test('--resume (not a fresh spawn) skips the preamble', async () => {
    writeProfile({ default: 'standing reminder' })
    const engine = new CapturingEngine()
    await runCli(
      ['spawn', repoLeaf, '--name', 'tm-e', '--prompt', 'do X', '--resume', 'sid-123'],
      envWith(engine),
    )
    expect(engine.lastPrompt).toBe('do X')
  })

  test('a malformed profile fails the spawn loud (and names --no-preamble)', async () => {
    writeFileSync(preambleProfilePath(dispatcherDir), '{ not json')
    const engine = new CapturingEngine()
    const result = await runCli(
      ['spawn', repoLeaf, '--name', 'tm-f', '--prompt', 'do X'],
      envWith(engine),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--no-preamble')
    expect(engine.lastPrompt).toBeNull()
  })
})
