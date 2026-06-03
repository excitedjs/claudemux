/**
 * Channel ownership inside the standing daemon.
 *
 * The Feishu long connection is global, but the Claude-facing owner of inbound
 * messages is explicit state controlled through MCP tools. Dispatcher is the
 * default owner; it can hand the channel to a teammate, and that teammate can
 * return it to the dispatcher. Ordinary proxy registration order must not
 * decide ownership.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import type { DaemonConnection } from './daemon-connection'

export const CHANNEL_OWNER_TOOLS: Tool[] = [
  {
    name: 'feishu_channel_status',
    description:
      'Show which Claude Code session currently owns inbound Feishu channel delivery, and list live channel proxies.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feishu_channel_grant',
    description:
      'Allow one live teammate session to acquire inbound Feishu channel delivery. Dispatcher-only. Target the teammate by session_id or by match.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Live teammate proxy session_id that may call feishu_channel_acquire.',
        },
        match: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Select the target proxy by matching its registered metadata; every key must equal (e.g. { "teammate_name": "api-worker" }). Use instead of session_id, not together.',
        },
      },
    },
  },
  {
    name: 'feishu_channel_acquire',
    description:
      'Acquire inbound Feishu channel delivery. Dispatcher may assign a live target directly; ordinary sessions need a dispatcher grant.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Optional live proxy session_id to assign as owner. Dispatcher-only; ordinary sessions acquire only themselves when granted.',
        },
        match: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional metadata selector for the target proxy; every key must equal (e.g. { "teammate_name": "api-worker" }). Dispatcher-only assignment; use instead of session_id, not together.',
        },
      },
    },
  },
  {
    name: 'feishu_channel_return_to_dispatcher',
    description:
      'Return inbound Feishu channel delivery to the current dispatcher session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'feishu_channel_reclaim',
    description:
      'Force reclaim inbound Feishu channel delivery back to the dispatcher. Dispatcher-only recovery path for a dead owner session.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export type OwnershipToolResult =
  | { handled: true; result: CallToolResult }
  | { handled: false }

/**
 * Authoritative daemon identity surfaced in `feishu_channel_status`. The daemon
 * knows these exactly (its loaded version, pid, and the launch dir resolved from
 * `import.meta.url`), which `feishu_channel_doctor` would otherwise reconstruct
 * fragilely from `ps`/`lsof`. Additive: an older daemon omits the block, and the
 * doctor falls back to the socket greeting plus process enumeration.
 */
export interface DaemonIdentity {
  version: string
  pid: number
  generation: number
  started_at: number
  launch_path: string
}

export class ChannelOwnerState {
  #ownerSessionId: string | undefined
  #dispatcherSessionId: string | undefined
  #grantedSessionId: string | undefined
  #leaseEpoch = 0

  constructor(
    private readonly onChanged: () => void = () => {},
    private readonly daemonIdentity?: () => DaemonIdentity,
  ) {}

  register(conn: DaemonConnection): void {
    const session = conn.session
    if (!session) return
    if (session.role !== 'dispatcher') return

    const previousDispatcher = this.#dispatcherSessionId
    this.#dispatcherSessionId = session.sessionId

    if (this.#ownerSessionId === undefined || this.#ownerSessionId === previousDispatcher) {
      this.setOwner(session.sessionId)
      this.onChanged()
    }
  }

  select(connections: ReadonlySet<DaemonConnection>): DaemonConnection | null {
    const live = [...connections].filter((conn) => conn.session !== null)
    if (this.#ownerSessionId) {
      const owner = live.find((conn) => conn.session?.sessionId === this.#ownerSessionId)
      if (owner) return owner
      return null
    }
    if (this.#dispatcherSessionId) {
      const dispatcher = live.find((conn) => conn.session?.sessionId === this.#dispatcherSessionId)
      if (dispatcher) return dispatcher
    }
    return null
  }

  async handleTool(
    caller: DaemonConnection,
    name: string,
    args: Record<string, unknown>,
    connections: ReadonlySet<DaemonConnection>,
  ): Promise<OwnershipToolResult> {
    switch (name) {
      case 'feishu_channel_status':
        return { handled: true, result: toolJson(this.status(connections)) }
      case 'feishu_channel_grant': {
        const callerSession = caller.session
        if (!callerSession) return { handled: true, result: toolText('channel proxy is not registered', true) }
        if (callerSession.role !== 'dispatcher') {
          return { handled: true, result: toolText('only the dispatcher may grant channel ownership', true) }
        }
        const selected = resolveSelector(args, connections)
        if (selected.kind === 'error') return { handled: true, result: toolText(selected.message, true) }
        if (selected.kind === 'none') {
          return { handled: true, result: toolText('session_id or match is required', true) }
        }
        if (selected.session.role === 'dispatcher') {
          return { handled: true, result: toolText('dispatcher already owns the default channel target', true) }
        }
        this.#grantedSessionId = selected.session.sessionId
        return {
          handled: true,
          result: toolText(`Feishu channel acquire grant issued to ${selected.session.sessionId}.`),
        }
      }
      case 'feishu_channel_acquire': {
        const callerSession = caller.session
        if (!callerSession) return { handled: true, result: toolText('channel proxy is not registered', true) }
        const selected = resolveSelector(args, connections)
        if (selected.kind === 'error') return { handled: true, result: toolText(selected.message, true) }
        // No selector means the caller acquires itself.
        const targetSession = selected.kind === 'target' ? selected.session : callerSession
        if (callerSession.role !== 'dispatcher' && targetSession.sessionId !== callerSession.sessionId) {
          return {
            handled: true,
            result: toolText('only the dispatcher may assign channel ownership to another session', true),
          }
        }
        if (callerSession.role !== 'dispatcher' && this.#grantedSessionId !== callerSession.sessionId) {
          return {
            handled: true,
            result: toolText('channel ownership was not granted by the dispatcher', true),
          }
        }
        this.setOwner(targetSession.sessionId)
        if (this.#grantedSessionId === targetSession.sessionId) this.#grantedSessionId = undefined
        this.onChanged()
        return {
          handled: true,
          result: toolText(
            `Feishu channel owner is now ${targetSession.sessionId} (${targetSession.role}, epoch ${this.#leaseEpoch}).`,
          ),
        }
      }
      case 'feishu_channel_return_to_dispatcher': {
        const callerSession = caller.session
        if (!callerSession) return { handled: true, result: toolText('channel proxy is not registered', true) }
        if (callerSession.role !== 'dispatcher' && callerSession.sessionId !== this.#ownerSessionId) {
          return {
            handled: true,
            result: toolText('only the current owner may return the channel to dispatcher', true),
          }
        }
        const dispatcher = this.currentDispatcher(connections)
        if (!dispatcher?.session) {
          return { handled: true, result: toolText('no live dispatcher channel proxy is registered', true) }
        }
        this.setOwner(dispatcher.session.sessionId)
        this.#grantedSessionId = undefined
        this.onChanged()
        return {
          handled: true,
          result: toolText(
            `Feishu channel owner returned to dispatcher ${dispatcher.session.sessionId} (epoch ${this.#leaseEpoch}).`,
          ),
        }
      }
      case 'feishu_channel_reclaim': {
        const callerSession = caller.session
        if (!callerSession) return { handled: true, result: toolText('channel proxy is not registered', true) }
        if (callerSession.role !== 'dispatcher') {
          return { handled: true, result: toolText('only the dispatcher may reclaim channel ownership', true) }
        }
        const dispatcher = this.currentDispatcher(connections)
        if (!dispatcher?.session) {
          return { handled: true, result: toolText('no live dispatcher channel proxy is registered', true) }
        }
        this.setOwner(dispatcher.session.sessionId)
        this.#grantedSessionId = undefined
        this.onChanged()
        return {
          handled: true,
          result: toolText(
            `Feishu channel owner reclaimed by dispatcher ${dispatcher.session.sessionId} (epoch ${this.#leaseEpoch}).`,
          ),
        }
      }
      default:
        return { handled: false }
    }
  }

  status(connections: ReadonlySet<DaemonConnection>): unknown {
    const sessions = [...connections]
      .map((conn) => conn.session)
      .filter((s): s is NonNullable<typeof s> => s !== null)
    const daemon = this.daemonIdentity?.()
    return {
      owner_session_id: this.#ownerSessionId ?? null,
      dispatcher_session_id: this.#dispatcherSessionId ?? null,
      granted_session_id: this.#grantedSessionId ?? null,
      effective_target_session_id: this.select(connections)?.session?.sessionId ?? null,
      lease_epoch: this.#leaseEpoch,
      sessions,
      ...(daemon ? { daemon } : {}),
    }
  }

  private currentDispatcher(connections: ReadonlySet<DaemonConnection>): DaemonConnection | null {
    if (!this.#dispatcherSessionId) return null
    return [...connections].find((conn) => conn.session?.sessionId === this.#dispatcherSessionId) ?? null
  }

  private setOwner(sessionId: string): void {
    if (this.#ownerSessionId === sessionId) return
    this.#ownerSessionId = sessionId
    this.#leaseEpoch += 1
  }
}

type SelectorResult =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'target'; target: DaemonConnection; session: NonNullable<DaemonConnection['session']> }

/**
 * Resolve the target proxy a grant/acquire call addresses, from a neutral
 * selector: an explicit `session_id`, or a `match` object compared against each
 * session's self-reported `metadata` (every key must equal). The channel core
 * never interprets a metadata key — `{ teammate_name: "api-worker" }` is just a
 * pair to match. `kind: 'none'` means no selector was given (the caller decides
 * the default — acquire-self, or grant-requires-a-target).
 */
function resolveSelector(
  args: Record<string, unknown>,
  connections: ReadonlySet<DaemonConnection>,
): SelectorResult {
  const sessionId =
    typeof args.session_id === 'string' && args.session_id.length > 0 ? args.session_id : undefined
  // Distinguish an omitted `match` from one that is present but malformed: a
  // present `match` is a contract the caller asked the daemon to honor, so an
  // empty / non-object / non-string-valued `match` is a hard error, never a
  // silent fall-through to acquire-self (which would route the channel somewhere
  // the caller did not intend). Schema validation is best-effort over MCP, so
  // the daemon validates the shape itself.
  const matchPresent = args.match !== undefined && args.match !== null
  if (sessionId !== undefined && matchPresent) {
    return { kind: 'error', message: 'pass only one of session_id / match' }
  }
  if (sessionId !== undefined) {
    const target = [...connections].find((conn) => conn.session?.sessionId === sessionId)
    if (!target?.session) return { kind: 'error', message: `no live channel proxy session: ${sessionId}` }
    return { kind: 'target', target, session: target.session }
  }
  if (matchPresent) {
    const match = parseMatch(args.match)
    if (match === null) {
      return {
        kind: 'error',
        message: 'match must be a non-empty object whose values are all strings',
      }
    }
    const entries = Object.entries(match)
    const matched = [...connections].filter(
      (conn) => conn.session !== null && entries.every(([k, v]) => conn.session?.metadata[k] === v),
    )
    if (matched.length === 0) {
      return { kind: 'error', message: `no live channel proxy matching: ${JSON.stringify(match)}` }
    }
    if (matched.length > 1) {
      const candidates = matched.map((conn) => conn.session?.sessionId).join(', ')
      return {
        kind: 'error',
        message: `ambiguous match: ${JSON.stringify(match)}; candidates: ${candidates}; pass session_id to disambiguate`,
      }
    }
    const target = matched[0]!
    return { kind: 'target', target, session: target.session as NonNullable<DaemonConnection['session']> }
  }
  return { kind: 'none' }
}

/**
 * Parse a `match` selector. Valid is a non-empty object whose every value is a
 * string; `null` signals invalid (non-object, array, empty, or any non-string
 * value) so the caller can reject it rather than silently narrowing or ignoring
 * it. Dropping a non-string key would widen the match beyond what the caller
 * asked for, so any non-string value invalidates the whole selector.
 */
function parseMatch(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return null
  const out: Record<string, string> = {}
  for (const [k, v] of entries) {
    if (typeof v !== 'string') return null
    out[k] = v
  }
  return out
}

function toolJson(value: unknown): CallToolResult {
  return toolText(JSON.stringify(value, null, 2))
}

function toolText(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}
