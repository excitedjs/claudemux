/**
 * ClaudeTeammateRecord.
 *
 * The base `/tmp/teammate-<name>.json` is owned by
 * `persistence/identity-store.ts`; the Claude extension path builders live in
 * `persistence/paths.ts`. The teammate's live runtime is the stream-json
 * broker dir, so kill-time cleanup enumerates the sid/cwd pointers plus that
 * broker directory.
 */

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'
import { claudeExtensionFor, claudeStreamDir, type ClaudeTeammateExtension } from '../../persistence/paths'

export class ClaudeTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'claude'

  constructor(args: {
    name: TeammateName
    repo: string
    cwd: string
    worktreeSlug: string | null
    createdAt: number
    displayName: string | null
  }) {
    super(args)
  }

  /** The Claude-engine extension paths for this teammate. */
  extension(): ClaudeTeammateExtension {
    return claudeExtensionFor(this.name)
  }

  override engineExtensionFiles(): readonly string[] {
    const ext = this.extension()
    return [ext.cwd, ext.sid, claudeStreamDir(this.name)]
  }
}
