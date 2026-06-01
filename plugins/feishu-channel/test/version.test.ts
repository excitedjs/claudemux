import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { comparePluginVersions, isOlderPluginVersion, readPluginVersion } from '../src/version'

describe('plugin version helpers', () => {
  test('reads the shipped plugin manifest version', () => {
    const root = mkdtempSync(join(tmpdir(), 'feishu-version-'))
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.2.3' }))

    expect(readPluginVersion(root)).toBe('1.2.3')
  })

  test('compares semantic version cores numerically', () => {
    expect(comparePluginVersions('1.10.0', '1.2.9')).toBeGreaterThan(0)
    expect(comparePluginVersions('2.0.0', '2.0.0')).toBe(0)
    expect(isOlderPluginVersion('0.4.0', '0.5.0')).toBe(true)
    expect(isOlderPluginVersion('0.5.0', '0.4.0')).toBe(false)
  })

  test('orders prereleases before their final release', () => {
    expect(isOlderPluginVersion('0.4.0-beta', '0.4.0')).toBe(true)
    expect(isOlderPluginVersion('0.4.0-beta.1', '0.4.0-beta.2')).toBe(true)
    expect(isOlderPluginVersion('0.4.0+build.1', '0.4.0')).toBe(false)
  })

  test('rejects invalid manifest versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'feishu-version-'))
    mkdirSync(join(root, '.claude-plugin'))
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: 'dev' }))

    expect(() => readPluginVersion(root)).toThrow(/valid x\.y\.z version/)
  })
})
