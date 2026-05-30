/**
 * `tm spawn`'s base-ref note. A fresh worktree teammate branches from
 * the source repo's current HEAD (`claude --worktree` pins
 * `worktree.baseRef = "head"`). When the repo happens to be parked on a
 * branch other than the trunk, the teammate silently starts from the
 * wrong baseline — so spawn prints a one-line summary of that ref:
 * the current branch + short sha, plus a best-effort ahead/behind
 * against the remote default branch.
 *
 * Everything here is best-effort and read-only: a repo that is not a
 * git checkout, a missing `git`, or any failing probe yields `null`,
 * and the caller simply omits the line. The base-ref note must never
 * throw and must never fail a spawn — surfacing the baseline is a
 * convenience, not a gate.
 */

import { spawnCapture } from '../../proc'

/** The `git` shell-out the note runs through; injectable so unit tests stay hermetic. */
export type GitRunner = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>

const defaultRunner: GitRunner = (args) => spawnCapture(args)

/**
 * Ahead/behind of HEAD relative to the repo's remote default branch
 * (`origin/HEAD`, e.g. `origin/main`). Returns `null` when no trunk
 * resolves — `origin/HEAD` is frequently unset on a local clone — so
 * the caller drops the comparison rather than guessing a trunk.
 */
async function aheadBehind(repo: string, run: GitRunner): Promise<string | null> {
  try {
    const trunkRes = await run(['git', '-C', repo, 'rev-parse', '--abbrev-ref', 'origin/HEAD'])
    if (trunkRes.code !== 0) return null
    const trunk = trunkRes.stdout.trim()
    if (trunk.length === 0) return null
    const countRes = await run([
      'git', '-C', repo, 'rev-list', '--left-right', '--count', `HEAD...${trunk}`,
    ])
    if (countRes.code !== 0) return null
    const parts = countRes.stdout.trim().split(/\s+/)
    const ahead = Number(parts[0])
    const behind = Number(parts[1])
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
    if (ahead === 0 && behind === 0) return `in sync with ${trunk}`
    const bits: string[] = []
    if (ahead > 0) bits.push(`${ahead} ahead`)
    if (behind > 0) bits.push(`${behind} behind`)
    return `${bits.join(' / ')} ${trunk}`
  } catch {
    return null
  }
}

/**
 * A one-line summary of the ref a fresh spawn branches from, e.g.
 * `main (a1b2c3d), in sync with origin/main` or
 * `feat/x (a1b2c3d), 2 ahead / 5 behind origin/main`, or
 * `detached @ a1b2c3d` for a detached HEAD. Returns `null` when the
 * repo is not a git checkout or any required probe fails.
 */
export async function gitBaseRefNote(
  repo: string,
  run: GitRunner = defaultRunner,
): Promise<string | null> {
  let branch: string
  let sha: string
  try {
    const branchRes = await run(['git', '-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRes.code !== 0) return null
    branch = branchRes.stdout.trim()
    const shaRes = await run(['git', '-C', repo, 'rev-parse', '--short', 'HEAD'])
    if (shaRes.code !== 0) return null
    sha = shaRes.stdout.trim()
  } catch {
    return null
  }
  if (branch.length === 0 || sha.length === 0) return null
  const head = branch === 'HEAD' ? `detached @ ${sha}` : `${branch} (${sha})`
  const divergence = await aheadBehind(repo, run)
  return divergence === null ? head : `${head}, ${divergence}`
}
