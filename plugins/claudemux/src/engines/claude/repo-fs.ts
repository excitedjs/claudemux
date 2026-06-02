/**
 * Repo-resolution helpers — the dispatcher-tree → physical-path →
 * `~/.claude/projects/<dir>` mapping `tm mem` and `tm resume` reach for.
 */

import { dirname, join } from 'node:path'

import { isDirectory } from './idle'
import { die } from './tmux'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'

/**
 * `tm`'s `die_repo_not_found`. Two branches: dispatcher dir itself is
 * a git working tree (steer the user to `cd ..`), or the generic miss
 * (instruction to set `TM_DISPATCHER_DIR`).
 */
export function dieRepoNotFound(
  verb: string,
  name: TeammateName,
  expected: string,
  dispatcherDir: string,
): TmResult {
  if (isDirectory(join(dispatcherDir, '.git'))) {
    return die(
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.\n` +
        '    The dispatcher dir should be the PARENT of your sibling repos.\n' +
        `    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${name}\n` +
        "    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json\n" +
        '    — run /claudemux:setup to wire it up automatically.)',
    )
  }
  return die(
    `repo not found at ${expected} — <repo> must be a direct subdirectory of the ` +
      `dispatcher dir (${dispatcherDir}). Dispatcher dir is read from ` +
      "TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or " +
      'run tm from the right place.',
  )
}
