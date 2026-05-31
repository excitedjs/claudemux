/**
 * Host access-control state for the Feishu channel.
 *
 * These types describe what gets persisted to access.json and what the host
 * `gate` reasons over — they are policy state, NOT transport I/O, so they live
 * in the host (claudemux), not the shared core. The core owns only transport-
 * general types like `Mention`.
 *
 * The access-control state defined here is what gets persisted to access.json
 * and what the pure `gate` function reasons over.
 */

/** Access-control policy for direct (1:1) messages. */
export type DmPolicy = 'pairing' | 'allowlist' | 'disabled'

/**
 * Access-control policy for group messages — the switch that selects one of
 * three group-access modes:
 *
 *  - `block`       — every group message is dropped; the bot ignores groups.
 *  - `allowlist`   — a group is authorized as a unit, by pairing: an @-mention
 *                    in an unconfigured group posts a code the operator
 *                    approves, adding the group to `Access.groups`.
 *  - `follow-user` — no group is authorized; a group message is delivered when
 *                    the bot is @-mentioned and the sender's open_id is on the
 *                    top-level `allowFrom` allowlist.
 */
export type GroupPolicy = 'block' | 'allowlist' | 'follow-user'

/**
 * Per-group access settings, keyed in Access.groups by the group's chat_id.
 * Consulted only under the `allowlist` group policy.
 */
export interface GroupEntry {
  /** Require the bot to be @-mentioned before a group message is delivered. */
  requireMention: boolean
  /** When non-empty, only these sender open_ids may trigger the bot here. */
  allowFrom: string[]
}

/**
 * A pending pairing request, keyed in Access.pending by its pairing code.
 *
 * `kind` says what approving the code authorizes: a `dm` request adds
 * `senderId` to the top-level `allowFrom`; a `group` request adds `chatId` to
 * `groups`. The two kinds share this one map and the one approval gesture.
 */
export interface PendingEntry {
  /** What approving this code authorizes — a direct sender, or a group. */
  kind: 'dm' | 'group'
  /**
   * open_id of the awaiting party: the sender for a `dm` request, or the
   * group member whose @-mention triggered a `group` request.
   */
  senderId: string
  /**
   * chat_id the request arrived in — the direct chat for a `dm` request, or
   * the group itself for a `group` request (the id approval adds to `groups`).
   */
  chatId: string
  /** Epoch millis the request was created. */
  createdAt: number
  /** Epoch millis the request expires. */
  expiresAt: number
  /** How many pairing-code replies were sent. A `group` request sends once. */
  replies: number
}

/** The full access-control state — persisted verbatim as access.json. */
export interface Access {
  dmPolicy: DmPolicy
  /** How group messages are gated — see `GroupPolicy`. */
  groupPolicy: GroupPolicy
  /** Sender open_ids allowed to reach the bot — in direct messages and groups. */
  allowFrom: string[]
  /** Per-group policy, keyed by chat_id. Consulted only under the `allowlist` group policy. */
  groups: Record<string, GroupEntry>
  /** Pending pairing requests, keyed by pairing code. */
  pending: Record<string, PendingEntry>
}
