import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease?: string
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function readPluginVersion(pluginRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || !isPluginVersion(manifest.version)) {
    throw new Error('feishu-channel plugin manifest has no valid x.y.z version')
  }
  return manifest.version
}

export function isPluginVersion(version: string): boolean {
  return VERSION_RE.test(version)
}

export function comparePluginVersions(a: string, b: string): number {
  const left = parsePluginVersion(a)
  const right = parsePluginVersion(b)
  return left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch ||
    comparePrerelease(left.prerelease, right.prerelease)
}

export function isOlderPluginVersion(candidate: string, baseline: string): boolean {
  return comparePluginVersions(candidate, baseline) < 0
}

function parsePluginVersion(version: string): ParsedVersion {
  const match = VERSION_RE.exec(version)
  if (!match) throw new Error(`invalid plugin version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  }
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1

  const left = a.split('.')
  const right = b.split('.')
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const diff = comparePrereleaseIdentifier(l, r)
    if (diff !== 0) return diff
  }
  return 0
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const leftNumber = /^\d+$/.test(a) ? Number(a) : undefined
  const rightNumber = /^\d+$/.test(b) ? Number(b) : undefined
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
  if (leftNumber !== undefined) return -1
  if (rightNumber !== undefined) return 1
  return a.localeCompare(b)
}
