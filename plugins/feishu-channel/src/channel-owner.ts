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
      'Allow one live teammate session to acquire inbound Feishu channel delivery. Dispatcher-only.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Live teammate proxy session_id that may call feishu_channel_acquire.',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'feishu_channel_acquire',
    description:
      'Acquire inbound Feishu channel delivery. Dispatcher may assign a live session_id directly; ordinary sessions need a dispatcher grant.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Optional live proxy session_id to assign as owner. Dispatcher-only; ordinary sessions acquire only themselves when granted.',
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

export class ChannelOwnerState {
  #ownerSessionId: string | undefined
  #dispatcherSessionId: string | undefined
  #grantedSessionId: string | undefined
  #leaseEpoch = 0

  constructor(private readonly onChanged: () => void = () => {}) {}

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
        const requested = typeof args.session_id === 'string' && args.session_id.length > 0
          ? args.session_id
          : undefined
        if (!requested) return { handled: true, result: toolText('session_id is required', true) }
        const target = [...connections].find((conn) => conn.session?.sessionId === requested)
        if (!target?.session) {
          return { handled: true, result: toolText(`no live channel proxy session: ${requested}`, true) }
        }
        if (target.session.role === 'dispatcher') {
          return { handled: true, result: toolText('dispatcher already owns the default channel target', true) }
        }
        this.#grantedSessionId = target.session.sessionId
        return {
          handled: true,
          result: toolText(`Feishu channel acquire grant issued to ${target.session.sessionId}.`),
        }
      }
      case 'feishu_channel_acquire': {
        const callerSession = caller.session
        if (!callerSession) return { handled: true, result: toolText('channel proxy is not registered', true) }
        const requested = typeof args.session_id === 'string' && args.session_id.length > 0
          ? args.session_id
          : callerSession.sessionId
        const target = [...connections].find((conn) => conn.session?.sessionId === requested)
        if (!target?.session) {
          return { handled: true, result: toolText(`no live channel proxy session: ${requested}`, true) }
        }
        if (callerSession.role !== 'dispatcher' && requested !== callerSession.sessionId) {
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
        this.setOwner(target.session.sessionId)
        if (this.#grantedSessionId === target.session.sessionId) this.#grantedSessionId = undefined
        this.onChanged()
        return {
          handled: true,
          result: toolText(
            `Feishu channel owner is now ${target.session.sessionId} (${target.session.role}, epoch ${this.#leaseEpoch}).`,
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
    return {
      owner_session_id: this.#ownerSessionId ?? null,
      dispatcher_session_id: this.#dispatcherSessionId ?? null,
      granted_session_id: this.#grantedSessionId ?? null,
      effective_target_session_id: this.select(connections)?.session?.sessionId ?? null,
      lease_epoch: this.#leaseEpoch,
      sessions,
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

function toolJson(value: unknown): CallToolResult {
  return toolText(JSON.stringify(value, null, 2))
}

function toolText(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}
