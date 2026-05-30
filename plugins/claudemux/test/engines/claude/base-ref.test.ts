/**
 * Coverage for `gitBaseRefNote` — the `base:` line `tm spawn` prints so
 * the baseline a fresh worktree branches from (the repo's current HEAD)
 * is visible instead of a silent surprise. The git shell-out is
 * injected as a fake runner, so these cases pin the formatting and the
 * graceful-degradation contract without touching a real repo:
 *
 *  - the note is best-effort: any failing probe → `null`, the caller
 *    omits the line and the spawn proceeds;
 *  - ahead/behind is dropped (not faked) when no trunk resolves.
 */

import { describe, expect, test } from 'vitest'

import { gitBaseRefNote, type GitRunner } from '../../../src/engines/claude/base-ref'

/** Build a fake git runner from a `(subcommand) → {code, stdout}` table. */
function fakeRunner(
  table: Record<string, { code: number; stdout: string }>,
): GitRunner {
  return async (args) => {
    // args = ['git', '-C', repo, ...subcommand]; key on the subcommand.
    const key = args.slice(3).join(' ')
    const hit = table[key]
    if (hit === undefined) return { code: 1, stdout: '', stderr: `no fake for: ${key}` }
    return { code: hit.code, stdout: hit.stdout, stderr: '' }
  }
}

const REPO = '/home/u/repo'

describe('gitBaseRefNote', () => {
  test('branch + short sha + ahead/behind vs the remote default', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feat/x\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'a1b2c3d\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/main\n' },
      'rev-list --left-right --count HEAD...origin/main': { code: 0, stdout: '2\t5\n' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBe('feat/x (a1b2c3d), 2 ahead / 5 behind origin/main')
  })

  test('in sync with the trunk renders "in sync with"', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'main\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'deadbee\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/main\n' },
      'rev-list --left-right --count HEAD...origin/main': { code: 0, stdout: '0\t0\n' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBe('main (deadbee), in sync with origin/main')
  })

  test('ahead-only and behind-only render just the non-zero side', async () => {
    const aheadOnly = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'topic\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'aaaaaaa\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/next\n' },
      'rev-list --left-right --count HEAD...origin/next': { code: 0, stdout: '3\t0\n' },
    })
    expect(await gitBaseRefNote(REPO, aheadOnly)).toBe('topic (aaaaaaa), 3 ahead origin/next')

    const behindOnly = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'topic\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'bbbbbbb\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/next\n' },
      'rev-list --left-right --count HEAD...origin/next': { code: 0, stdout: '0\t7\n' },
    })
    expect(await gitBaseRefNote(REPO, behindOnly)).toBe('topic (bbbbbbb), 7 behind origin/next')
  })

  test('a detached HEAD renders "detached @ <sha>"', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'HEAD\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'c0ffee0\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 1, stdout: '' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBe('detached @ c0ffee0')
  })

  test('no resolvable trunk drops the divergence but keeps branch + sha', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feat/x\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'a1b2c3d\n' },
      // origin/HEAD unset on a local clone — the common case.
      'rev-parse --abbrev-ref origin/HEAD': { code: 128, stdout: '' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBe('feat/x (a1b2c3d)')
  })

  test('a non-git directory (HEAD probe fails) yields null — no base line', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 128, stdout: '' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBeNull()
  })

  test('a runner that throws degrades to null rather than failing the spawn', async () => {
    const run: GitRunner = async () => {
      throw new Error('git not on PATH')
    }
    expect(await gitBaseRefNote(REPO, run)).toBeNull()
  })

  test('a malformed rev-list count drops divergence, keeps branch + sha', async () => {
    const run = fakeRunner({
      'rev-parse --abbrev-ref HEAD': { code: 0, stdout: 'feat/x\n' },
      'rev-parse --short HEAD': { code: 0, stdout: 'a1b2c3d\n' },
      'rev-parse --abbrev-ref origin/HEAD': { code: 0, stdout: 'origin/main\n' },
      'rev-list --left-right --count HEAD...origin/main': { code: 0, stdout: 'garbage\n' },
    })
    expect(await gitBaseRefNote(REPO, run)).toBe('feat/x (a1b2c3d)')
  })
})
