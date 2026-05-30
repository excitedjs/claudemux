/**
 * Coverage for `archivedListingRows` — the verb-layer helper behind
 * `tm ls --all` / `tm states --all`. It turns the kill-time identity
 * archive into `killed` listing rows, dropping any name that is live
 * again so a re-spawned teammate shows its live row, not a stale
 * killed one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { archivedListingRows } from '../../src/verbs/format'
import { archivedIdentityFile } from '../../src/persistence/identity-store'
import { TEAMMATE_RECORD_SCHEMA, type TeammateRecordJson } from '../../src/engines/teammate-record'

let root: string
let savedRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync('/tmp/cmux-fleet-all-')
  savedRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = root
})

afterEach(() => {
  if (savedRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedRoot
  rmSync(root, { recursive: true, force: true })
})

function plantArchive(overrides: Partial<TeammateRecordJson> & { name: string }): void {
  const record: TeammateRecordJson = {
    schema: TEAMMATE_RECORD_SCHEMA,
    engine: 'claude',
    repo: '/home/u/repo',
    cwd: '/home/u/repo/.claude/worktrees/' + overrides.name,
    worktreeSlug: overrides.name,
    createdAt: 1700000000,
    displayName: null,
    ...overrides,
  }
  const path = archivedIdentityFile(record.name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
}

describe('archivedListingRows', () => {
  test('maps each archived record to a killed listing row', () => {
    plantArchive({ name: 'dead-1', repo: '/srv/code/flow', worktreeSlug: 'dead-1' })

    const rows = archivedListingRows(new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'dead-1',
      engine: 'claude',
      state: 'killed',
      repo: '/srv/code/flow',
      worktreeSlug: 'dead-1',
      extras: {},
    })
  })

  test('drops an archived name that is live again (dedupe against the live fleet)', () => {
    plantArchive({ name: 'alive-again' })
    plantArchive({ name: 'still-dead' })

    const rows = archivedListingRows(new Set(['alive-again']))
    expect(rows.map((r) => r.name)).toEqual(['still-dead'])
  })

  test('returns nothing when the archive is empty', () => {
    expect(archivedListingRows(new Set())).toEqual([])
  })

  test('carries a codex engine through unchanged', () => {
    plantArchive({ name: 'codex-dead', engine: 'codex', worktreeSlug: null })
    const rows = archivedListingRows(new Set())
    expect(rows[0]).toMatchObject({ name: 'codex-dead', engine: 'codex', state: 'killed', worktreeSlug: null })
  })
})
