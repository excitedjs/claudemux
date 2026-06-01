/**
 * The Feishu channel MCP server.
 *
 * This module assembles the channel: it declares the `claude/channel`
 * capability, exposes the outbound tools, and runs the inbound pipeline —
 * which is now a thin dispatcher over an `EventRegistry`. Each Feishu event
 * type is a registered handler (see `./events` and `./handlers/`); the core
 * only resolves a handler by event_type, runs it, and delivers its result.
 *
 * The channel logic lives in `createChannelCore`, which depends only on a
 * `FeishuTransport` and a notifier callback — so the inbound and outbound
 * paths are unit-testable against fakes, with no MCP stdio and no live
 * Feishu connection. `main` is the thin process entry point that wires the
 * core to a real MCP `Server`, a real transport, and graceful shutdown.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import { EventRegistry } from './events'
import type { ChannelDelivery, HandlerContext } from './events'
import type { FeishuCredentials, FeishuTransport, InboundRoutes } from './feishu'
import { createFeishuTransport } from './feishu'
import { createBotMemberHandler } from './handlers/bot-member'
import { createDocCommentHandler } from './handlers/doc-comment'
import { createImMessageHandler } from './handlers/im-message'
import { getBotIdentity } from './identity-store'
import { readChatBots } from './chat-bots-store'
import { asString, isRecord } from '@excitedjs/feishu-transport'
import { generatePairingCode } from '@excitedjs/feishu-transport'
import { startDaemon } from './daemon'
import type { DaemonLockRecord } from './daemon-lock'
import { startProxy, type ProxyHandle } from './proxy'
import {
  accessFile,
  daemonInboundQueueFile,
  daemonLockFile,
  daemonSocketFile,
  envFile,
  lockFile,
  stateDir,
} from './paths'
import { ShutdownCoordinator } from './shutdown'
import { comparePluginVersions, readPluginVersion } from './version'

let cachedServerVersion: string | undefined

/** Plugin version advertised to Claude Code, daemon proxies, and upgrade handoff. */
function serverVersion(): string {
  cachedServerVersion ??= readPluginVersion(pluginRoot())
  return cachedServerVersion
}

/** How long a session proxy waits for a just-spawned daemon to answer. */
const DAEMON_STARTUP_TIMEOUT_MS = 10_000

/** Retry cadence while waiting for the daemon socket to come up. */
const DAEMON_CONNECT_RETRY_MS = 100

/** The JSON-RPC method that carries an inbound event to the Claude session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/**
 * The emojis the channel reacts with to mark an inbound chat message as
 * received into the Claude session. One is chosen at random per message so the
 * acknowledgement feels alive rather than canned; every option reads as "seen,
 * on it", which is the signal the sender wants — their message landed and
 * Claude is working it:
 *
 * - `GLANCE`  — 👀 看
 * - `LGTM`    — 了解
 * - `Typing`  — 敲键盘
 * - `GoGoGo`  — 冲
 * - `OnIt`    — 在做了
 *
 * The channel adds one once a message reaches the session and removes it once
 * Claude replies into that chat. Removal is keyed by the reaction_id Feishu
 * returns, so it works regardless of which emoji was picked.
 */
export const RECEIVED_REACTION_EMOJIS = ['GLANCE', 'LGTM', 'Typing', 'GoGoGo', 'OnIt'] as const

/**
 * Pick a received-indicator emoji at random from {@link RECEIVED_REACTION_EMOJIS}.
 */
export function pickReceivedReactionEmoji(): string {
  const index = Math.floor(Math.random() * RECEIVED_REACTION_EMOJIS.length)
  return RECEIVED_REACTION_EMOJIS[index] ?? RECEIVED_REACTION_EMOJIS[0]
}

/** Pushes one inbound event to the Claude session. */
export type ChannelNotifier = (
  content: string,
  meta: Record<string, string>,
) => void | Promise<void>

/** Everything `createChannelCore` needs; the platform and clock are injectable. */
export interface ChannelCoreDeps {
  /** The Feishu platform boundary — a real transport or a test fake. */
  transport: FeishuTransport
  /** Path to access.json, the persisted access-control policy. */
  accessFile: string
  /**
   * Root directory for all channel state files. Defaults to `stateDir()`.
   * Tests point this at a temp directory to avoid touching real state.
   */
  baseDir?: string
  /** Delivers a gated inbound event to the Claude session. */
  notify: ChannelNotifier
  /** Injected clock (epoch millis); defaults to `Date.now`. */
  now?: () => number
  /** Injected pairing-code generator; defaults to `generatePairingCode`. */
  generateCode?: () => string
  /** Reports a recoverable error; defaults to logging to stderr. */
  logError?: (message: string, err?: unknown) => void
  /**
   * Reports a low-severity diagnostic; defaults to logging to stderr only
   * when `FEISHU_CHANNEL_DEBUG` is set, so routine drops do not spam logs.
   */
  logDebug?: (message: string) => void
  /**
   * Reports an inbound-pipeline milestone — event received, delivered, or not
   * delivered. Defaults to a timestamped stderr line and is always on: these
   * lines trace where an inbound message went, and they are proportional to
   * real traffic rather than to a noisy drop loop.
   */
  logInfo?: (message: string) => void
}

/** The channel's testable core: the inbound dispatcher and the outbound tools. */
export interface ChannelCore {
  /** The MCP tool definitions this channel exposes. */
  readonly tools: Tool[]
  /** Inbound route table — event_type → callback, handed to `transport.start`. */
  readonly routes: InboundRoutes
  /** Dispatch one raw Feishu event of `eventType` through its handler. */
  handleEvent(eventType: string, raw: unknown): Promise<void>
  /** Execute one outbound MCP tool call. */
  handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

/** The outbound tools the channel exposes to Claude. */
export const CHANNEL_TOOLS: Tool[] = [
  {
    name: 'reply',
    description:
      'Send a message into a Feishu chat. The text is rendered as Markdown by Feishu — use **bold**, *italic*, `inline code`, fenced ``` code blocks, bulleted and numbered lists, and [links](https://example.com) where they help readability. To @-mention a user inline, write <@open_id> (e.g. "<@ou_abc123> 请帮忙看一下"). Pass the chat_id from the <channel> tag of the message you are answering.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Target chat_id, copied verbatim from the inbound <channel> tag.',
        },
        text: {
          type: 'string',
          description:
            'Message body in Markdown. Supports bold, italic, links, ordered and unordered lists, inline code, and fenced code blocks. To @-mention a Feishu user inline, write <@open_id> anywhere in the text (e.g. "<@ou_abc123> 任务完成" or "请 <@ou_abc123> 帮忙 review").',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Feishu message.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'message_id from the inbound <channel> tag.',
        },
        emoji: {
          type: 'string',
          description: 'Feishu emoji_type, e.g. THUMBSUP, OK, DONE.',
        },
      },
      required: ['message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description:
      'Replace the content of a message this channel previously sent. The new text is rendered as Markdown, same as `reply` — including <@open_id> @-mention support.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'message_id of the bot message to edit.',
        },
        text: {
          type: 'string',
          description:
            'New message body in Markdown; same formatting rules and <@open_id> @-mention syntax as `reply`.',
        },
      },
      required: ['message_id', 'text'],
    },
  },
  {
    name: 'feishu_list_chat_bots',
    description:
      'List the other Feishu bots known to be in a group chat, with their open_ids, so you can @-mention them with <@open_id>. Use this to recover peer-bot open_ids after your context was compacted, or whenever you are unsure which bots share a group. Returns only bots discovered so far (via their messages or /introduce); Feishu has no API to enumerate a group\'s bots, so a freshly joined group may list none until peers speak.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Target chat_id, copied from the inbound <channel> tag.',
        },
        include_self: {
          type: 'boolean',
          description: 'Include this bot itself in the list. Defaults to false.',
        },
      },
      required: ['chat_id'],
    },
  },
]

/**
 * How long since a bot was last seen before `feishu_list_chat_bots` flags it
 * `stale`. A stale entry is still returned — it just signals the open_id may be
 * out of date because that bot has been quiet for a while.
 */
const BOT_STALE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Build the channel core. The returned object dispatches inbound events
 * through the event registry and runs outbound tool calls; it never touches
 * MCP stdio directly, so a test can drive both paths with a fake transport
 * and a capturing notifier.
 */
export function createChannelCore(deps: ChannelCoreDeps): ChannelCore {
  const now = deps.now ?? Date.now
  const generateCode = deps.generateCode ?? generatePairingCode
  const logError = deps.logError ?? defaultLogError
  const logDebug = deps.logDebug ?? defaultLogDebug
  const logInfo = deps.logInfo ?? defaultLogInfo
  const baseDir = deps.baseDir ?? stateDir()

  const ctx: HandlerContext = {
    transport: deps.transport,
    accessFile: deps.accessFile,
    baseDir,
    now,
    generateCode,
    logError,
    logDebug,
  }

  // Every Feishu event type the channel reacts to is a registered handler.
  // A new event type is added by registering one more handler here.
  const registry = new EventRegistry()
    .register(createImMessageHandler())
    .register(createDocCommentHandler())
    .register(createBotMemberHandler())

  const routes: InboundRoutes = {}
  for (const eventType of registry.eventTypes()) {
    routes[eventType] = (raw: unknown) => {
      logInfo(`inbound ${eventType} received (message ${inboundMessageId(raw)})`)
      return handleEvent(eventType, raw)
    }
  }

  /**
   * message_id → the chat it belongs to and the reaction_id of its "received"
   * indicator, for every inbound chat message delivered to the session and
   * still awaiting a reply. Held in memory, not on disk, on purpose: the
   * process that owns the inbound connection is the same one whose `reply`
   * tool answers the session it feeds, so a process-local map is consistent,
   * and a restart discards the Claude conversation and this map together —
   * persisting it would only preserve indicators for context that is gone.
   */
  const pendingReactions = new Map<string, { chatId: string; reactionId: string }>()

  async function handleEvent(eventType: string, raw: unknown): Promise<void> {
    const messageId = inboundMessageId(raw)
    const handler = registry.get(eventType)
    if (!handler) {
      logInfo(`${eventType} ignored — no registered handler`)
      return
    }

    let delivery: ChannelDelivery | null
    try {
      delivery = await handler.handle(raw, ctx)
    } catch (err) {
      logError(`failed to handle a ${eventType} event`, err)
      return
    }
    if (!delivery) {
      // A null delivery is an access-gate drop, a pairing prompt, or an event
      // with no forwardable content. The specific reason, when there is one,
      // is logged by the handler through `logDebug`.
      logInfo(`${eventType} not delivered — gated out, paired, or empty (message ${messageId})`)
      return
    }

    logInfo(`${eventType} gated through — delivering (message ${messageId})`)
    try {
      await deps.notify(delivery.content, delivery.meta)
      // The notification reached the session, so any one-shot state the handler
      // staged (e.g. a bot-discovery baseline marked as injected) can now be
      // committed. Reached only after a successful notify, so a delivery
      // failure leaves that state intact to retry on the next message.
      if (delivery.commit) await delivery.commit()
      // The event is now in the session's context — mark the source message
      // as received so the Feishu sender sees it landed. `markReceived`
      // swallows its own failures, so it never reaches the catch below.
      await markReceived(delivery.meta)
    } catch (err) {
      logError(`failed to deliver a ${eventType} notification`, err)
    }
  }

  /**
   * Mark a just-delivered message as received: add the "received" reaction on
   * Feishu and remember its reaction_id so a later reply can take it back off.
   * Only chat messages carry the indicator — a doc comment is not an IM
   * message, and the message-reaction API has nothing to act on for it.
   * Best-effort: it catches its own failures so a reaction problem is logged
   * and never looks like a delivery failure to the caller.
   */
  async function markReceived(meta: Record<string, string>): Promise<void> {
    if (meta.kind !== 'message') return
    const messageId = meta.message_id
    const chatId = meta.chat_id
    if (!messageId || !chatId) return
    try {
      const reactionId = await deps.transport.addReaction(messageId, pickReceivedReactionEmoji())
      if (!reactionId) {
        logError(
          `Feishu returned no reaction_id for the received reaction on message ` +
            `${messageId}; it cannot be cleared when Claude replies`,
        )
        return
      }
      pendingReactions.set(messageId, { chatId, reactionId })
    } catch (err) {
      logError(`failed to add the received reaction to message ${messageId}`, err)
    }
  }

  /**
   * Clear the "received" reaction from every message in a chat that is still
   * awaiting a reply — called once a reply has been sent into that chat, since
   * those messages are now answered. A `reply` carries only a chat_id, while a
   * reaction lives on a specific message_id, so the whole chat's pending set
   * is cleared: anything outstanding when Claude answers the chat is treated
   * as addressed by that answer. Each removal is best-effort and a message is
   * dropped from the map even when its removal fails, so a reaction_id Feishu
   * will not accept is not retried on every later reply.
   */
  async function clearReceived(chatId: string): Promise<void> {
    const pending = [...pendingReactions].filter(([, record]) => record.chatId === chatId)
    for (const [messageId, record] of pending) {
      pendingReactions.delete(messageId)
      try {
        await deps.transport.removeReaction(messageId, record.reactionId)
      } catch (err) {
        logError(`failed to remove the received reaction from message ${messageId}`, err)
      }
    }
  }

  async function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      switch (name) {
        case 'reply': {
          const chatId = requireString(args, 'chat_id')
          const text = requireString(args, 'text')
          // The transport renders the markdown source into v2 interactive
          // cards (`./render`): headings become the card title, GFM tables
          // become `tag: table` components, every other block becomes a
          // `tag: markdown` element. A body too large for one card produces
          // several messages; their ids come back in `messageIds`, in send
          // order, so the summary names how many landed.
          const result = await deps.transport.sendText(chatId, text)
          // The chat has been answered — take the "received" indicator back
          // off every message in it that was waiting for this reply. Reached
          // only after the send succeeds, so a failed reply leaves the
          // indicator in place.
          await clearReceived(chatId)
          const ids = result.messageIds
          const summary =
            ids.length <= 1
              ? `Sent to ${chatId}${ids[0] ? ` as ${ids[0]}` : ''}.`
              : `Sent to ${chatId} in ${ids.length} messages.`
          return toolText(summary)
        }
        case 'react': {
          const messageId = requireString(args, 'message_id')
          const emoji = requireString(args, 'emoji')
          await deps.transport.addReaction(messageId, emoji)
          return toolText(`Reacted ${emoji} to ${messageId}.`)
        }
        case 'edit_message': {
          const messageId = requireString(args, 'message_id')
          const text = requireString(args, 'text')
          await deps.transport.editText(messageId, text)
          return toolText(`Edited ${messageId}.`)
        }
        case 'feishu_list_chat_bots': {
          const chatId = requireString(args, 'chat_id')
          const includeSelf = args.include_self === true
          const appId = deps.transport.appId
          const selfOpenId = deps.transport.botOpenId
          const nowAt = now()
          const bots = readChatBots(baseDir, appId, chatId)
            .openIds.filter((openId) => includeSelf || openId !== selfOpenId)
            .map((openId) => {
              const identity = getBotIdentity(baseDir, appId, openId)
              return {
                name: identity?.name ?? openId,
                open_id: openId,
                source: identity?.source ?? 'observed',
                last_seen: identity?.lastSeenAt ?? 0,
                stale: identity ? nowAt - identity.lastSeenAt > BOT_STALE_MS : true,
              }
            })
          return toolText(JSON.stringify(bots, null, 2))
        }
        default:
          return toolText(`Unknown tool: ${name}`, true)
      }
    } catch (err) {
      return toolText(err instanceof Error ? err.message : String(err), true)
    }
  }

  return { tools: CHANNEL_TOOLS, routes, handleEvent, handleTool }
}

/**
 * Build the JSON-RPC notification that carries one inbound event to the Claude
 * session. Exported so the assembly — the method name and the `content` /
 * `meta` param shape — is covered without a live MCP connection.
 */
export function channelNotification(
  content: string,
  meta: Record<string, string>,
): { method: string; params: { content: string; meta: Record<string, string> } } {
  return { method: CHANNEL_NOTIFICATION_METHOD, params: { content, meta } }
}

/** Read a required non-empty string argument, throwing a clear error otherwise. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing or empty required argument: ${key}`)
  }
  return value
}

/** Wrap text in an MCP tool result, optionally flagged as an error. */
function toolText(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

/** Prefix for every channel log line: the fixed tag and an ISO-8601 timestamp. */
function logPrefix(): string {
  return `[feishu-channel] ${new Date().toISOString()}`
}

function defaultLogError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`${logPrefix()} ${message}`)
  } else {
    console.error(`${logPrefix()} ${message}`, err)
  }
}

/** Default inbound-pipeline logger — a timestamped stderr line, always on. */
function defaultLogInfo(message: string): void {
  console.error(`${logPrefix()} ${message}`)
}

/**
 * Default diagnostic logger. Access-control drops are the answer to "why did
 * my message not arrive", so they are worth logging — but a busy mention-gated
 * group drops constantly, so the line is emitted only when `FEISHU_CHANNEL_DEBUG`
 * is set rather than on by default.
 */
function defaultLogDebug(message: string): void {
  if (process.env.FEISHU_CHANNEL_DEBUG) {
    console.error(`${logPrefix()} ${message}`)
  }
}

/**
 * Best-effort message_id of a raw inbound event, used to correlate log lines.
 * Tolerates either an `{ event: ... }` envelope or the event body alone, and
 * returns a placeholder for an event type that carries no message_id.
 */
function inboundMessageId(raw: unknown): string {
  if (!isRecord(raw)) return '(unknown)'
  const event = isRecord(raw.event) ? raw.event : raw
  const message = isRecord(event.message) ? event.message : {}
  return asString(message.message_id) || '(no message_id)'
}

/** Guidance injected into Claude's system prompt for this channel. */
const CHANNEL_INSTRUCTIONS = [
  'This MCP server is a Feishu (Lark) channel. Inbound Feishu events arrive as',
  '<channel source="feishu"> blocks; the `kind` attribute says which kind of event it is.',
  '',
  'kind="message" — a chat message. Attributes:',
  '- chat_id: the conversation the message came from; pass it to the `reply` tool to answer.',
  '- message_id: the specific message; pass it to `react` or `edit_message`.',
  '- chat_type: "p2p" for a direct message, "group" for a group chat.',
  '- sender_id: the Feishu open_id of the sender.',
  'Answer a Feishu user by calling `reply` with the chat_id from the message you are answering.',
  'The `text` you pass to `reply` and `edit_message` is rendered as Markdown by Feishu —',
  'feel free to use **bold**, *italic*, `inline code`, fenced code blocks, lists, and links',
  'when they make a message clearer. To @-mention a user inline, write <@open_id> anywhere',
  'in the text (e.g. "<@ou_abc123> 任务完成" or "请 <@ou_abc123> 帮忙 review"); the channel',
  'converts it to a Feishu @-mention that notifies the user.',
  'Use `react` to acknowledge a message with an emoji, and `edit_message` to revise a message',
  'you previously sent.',
  '',
  'Group chats may contain other bots you can collaborate with by @-mentioning their open_id',
  '(<@open_id>). When you first join a group, and when a new bot is discovered, a one-time',
  '【本群 bot 基线】/【本群新增 bot】/【发送方 bot】 note is prefixed to a delivered message listing',
  'their names and open_ids. If your context was compacted and you no longer have a peer bot\'s',
  'open_id, call `feishu_list_chat_bots` with the chat_id to look it up again.',
  '',
  'kind="doc_comment" — a comment on a Feishu document. Attributes:',
  '- file_token, file_type: the document the comment is on.',
  '- comment_id, and reply_id when the event is a reply within a thread.',
  '- notice_type: "add_comment" or "add_reply".',
  '- commenter_id: the Feishu open_id of the commenter.',
  '- mentioned_bot: "true" when the comment @-mentions the bot.',
  '- doc_url: a link to the document, when it could be resolved.',
  'The block body carries the comment text and the document title. A doc comment',
  'has no chat to answer into — treat it as a signal to act on, not a message to',
  'reply to with `reply`.',
  '',
  'Only act on events that arrived through this channel.',
].join('\n')

/** Construct the MCP server with the channel capability declared. */
function createMcpServer(): Server {
  return new Server(
    { name: 'feishu', version: serverVersion() },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  )
}

/**
 * Load Feishu credentials from the channel's `.env` file, falling back to the
 * process environment. Throws a clear error when either value is missing,
 * since the channel cannot connect without them.
 */
export function loadCredentials(file: string): FeishuCredentials {
  const fromFile = readEnvFile(file)
  const appId = fromFile.FEISHU_APP_ID ?? process.env.FEISHU_APP_ID
  const appSecret = fromFile.FEISHU_APP_SECRET ?? process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu credentials missing — set FEISHU_APP_ID and FEISHU_APP_SECRET in ${file}`,
    )
  }
  return { appId, appSecret }
}

/** Parse a minimal `KEY=value` env file; a missing file yields an empty map. */
export function readEnvFile(file: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (key === undefined || rawValue === undefined) continue
    out[key] = rawValue.replace(/^["']|["']$/g, '')
  }
  return out
}

/** Process entry point for the standing daemon: own Feishu + serve proxies. */
async function runDaemonMain(): Promise<void> {
  const shutdown = new ShutdownCoordinator()
  shutdown.installSignalHandlers()

  const base = stateDir()
  mkdirSync(base, { recursive: true })
  const credentials = loadCredentials(envFile(base))
  const socketPath = daemonSocketFile(base)
  const transport = createFeishuTransport(credentials, lockFile(base), { singleInstance: false })
  const self: DaemonLockRecord = {
    pid: process.pid,
    startedAt: Date.now(),
    socketPath,
    daemonVersion: serverVersion(),
  }

  const daemon = await startDaemon({
    lockPath: daemonLockFile(base),
    socketPath,
    daemonVersion: serverVersion(),
    generation: 1,
    self,
    transport,
    accessFile: accessFile(base),
    queueFile: daemonInboundQueueFile(base),
    legacyInboundLockPath: lockFile(base),
    baseDir: base,
    logInfo: defaultLogInfo,
    logError: defaultLogError,
  })

  if (!daemon.started) {
    defaultLogInfo(`daemon already running (${daemon.reason}); exiting duplicate daemon process`)
    return
  }

  shutdown.register('feishu-daemon', () => daemon.close())
}

/** Process entry point for each Claude session: stdio MCP proxy only. */
async function runProxyMain(): Promise<void> {
  const shutdown = new ShutdownCoordinator()
  shutdown.installSignalHandlers()

  const base = stateDir()
  mkdirSync(base, { recursive: true })
  const socketPath = daemonSocketFile(base)
  const server = createMcpServer()
  const proxy = await connectProxyOrSpawnDaemon({
    socketPath,
    mcpServer: server as unknown as ConnectProxyDeps['mcpServer'],
    baseDir: base,
  })

  shutdown.register('feishu-proxy', () => {
    proxy.close()
  })
  shutdown.register('mcp-server', () => server.close())
  shutdown.watch(server)
  // Backstop for a parent that goes away without closing the MCP stdio.
  // The proxy holds no Feishu connection, but an orphan proxy would keep a
  // dead session registered with the daemon until the socket eventually closes.
  shutdown.watchParent()

  await server.connect(new StdioServerTransport())
}

interface ConnectProxyDeps {
  socketPath: string
  mcpServer: Parameters<typeof startProxy>[0]['mcpServer']
  baseDir: string
  startProxyFn?: typeof startProxy
  spawnDaemonProcessFn?: typeof spawnDaemonProcess
  sleepFn?: typeof sleep
  now?: () => number
}

export async function connectProxyOrSpawnDaemon(deps: ConnectProxyDeps): Promise<ProxyHandle> {
  const startProxyFn = deps.startProxyFn ?? startProxy
  const spawnDaemonProcessFn = deps.spawnDaemonProcessFn ?? spawnDaemonProcess
  const sleepFn = deps.sleepFn ?? sleep
  const now = deps.now ?? Date.now
  const deadline = now() + DAEMON_STARTUP_TIMEOUT_MS
  const version = serverVersion()
  let spawned = false
  let sawOlderDaemon = false
  let lastError: unknown

  while (now() <= deadline) {
    let proxy: ProxyHandle | undefined
    try {
      proxy = await startProxyFn({
        socketPath: deps.socketPath,
        sessionId: stableProxySessionId(proxyRole()),
        pid: process.pid,
        proxyVersion: version,
        role: proxyRole(),
        metadata: deriveProxyMetadata(),
        onDaemonMissing: () => spawnDaemonProcessFn(deps.baseDir),
        mcpServer: deps.mcpServer,
        logError: defaultLogError,
      })
      const daemon = proxy.connection.client.daemon
      if (!daemon || comparePluginVersions(daemon.daemonVersion, version) >= 0) {
        return proxy
      }
      sawOlderDaemon = true
      lastError = new Error(
        `connected Feishu daemon ${daemon.daemonVersion} is older than proxy ${version}`,
      )
      proxy.close()
      if (!spawned) {
        spawnDaemonProcessFn(deps.baseDir)
        spawned = true
      }
      await sleepFn(DAEMON_CONNECT_RETRY_MS)
    } catch (err) {
      proxy?.close()
      lastError = err
      if (!spawned) {
        spawnDaemonProcessFn(deps.baseDir)
        spawned = true
      }
      await sleepFn(DAEMON_CONNECT_RETRY_MS)
    }
  }

  if (sawOlderDaemon) {
    return await startProxyFn({
      socketPath: deps.socketPath,
      sessionId: stableProxySessionId(proxyRole()),
      pid: process.pid,
      proxyVersion: version,
      role: proxyRole(),
      metadata: deriveProxyMetadata(),
      onDaemonMissing: () => spawnDaemonProcessFn(deps.baseDir),
      mcpServer: deps.mcpServer,
      logError: defaultLogError,
    })
  }

  throw new Error(`failed to connect to Feishu daemon at ${deps.socketPath}: ${String(lastError)}`)
}

function spawnDaemonProcess(baseDir: string): void {
  const child = spawn(npmCommand(), ['run', '--silent', 'daemon'], {
    cwd: pluginRoot(),
    env: {
      ...process.env,
      FEISHU_CHANNEL_STATE_DIR: baseDir,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

function proxyRole(): 'dispatcher' | 'session' {
  return process.env.FEISHU_CHANNEL_PROXY_ROLE === 'dispatcher' ||
    process.env.FEISHU_CHANNEL_DISPATCHER === '1'
    ? 'dispatcher'
    : 'session'
}

export function stableProxySessionId(
  role: 'dispatcher' | 'session',
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = sessionToken(env.FEISHU_CHANNEL_SESSION_ID)
  if (explicit !== null) return `${role}:${explicit}`
  const claudeSessionId = sessionToken(env.CLAUDE_CODE_SESSION_ID)
  if (claudeSessionId !== null) return hashedProxySessionId(role, `claude-code-session\0${claudeSessionId}`)
  const projectDir = env.CLAUDE_PROJECT_DIR
  const initCwd = env.INIT_CWD
  const fallbackCwd =
    projectDir && projectDir.length > 0 ? projectDir : initCwd && initCwd.length > 0 ? initCwd : cwd
  const resolved = safeRealpath(fallbackCwd)
  return hashedProxySessionId(role, `cwd\0${resolved}`)
}

function hashedProxySessionId(role: 'dispatcher' | 'session', source: string): string {
  const digest = createHash('sha256').update(`${role}\0${source}`).digest('hex').slice(0, 16)
  return `${role}:${digest}`
}

function sessionToken(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Self-reported identity attached to `register` so a coordinator can locate this
 * session by a readable key instead of reverse-engineering it from `pid`. The
 * channel core treats every entry as an opaque string pair; only the keys are a
 * convention. Composed of two independent contributors so the core stays free
 * of any orchestrator-specific knowledge:
 *
 *  - `cwd` — the session project dir, derived from `CLAUDE_PROJECT_DIR` (a
 *    Claude Code standard, present for any session, not claudemux-specific).
 *  - claudemux identity — see `claudemuxIdentityFromEnv`, the single named seam
 *    where a claudemux-specific env name is read. A future spawner or a generic
 *    `FEISHU_CHANNEL_META_*` env-prefix harvest would slot in here without
 *    touching the wire type or the daemon.
 */
export function deriveProxyMetadata(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const metadata: Record<string, string> = {}
  // Non-empty fallback (mirrors `stableProxySessionId`): an empty
  // `CLAUDE_PROJECT_DIR` must not suppress a valid `INIT_CWD`. Do not fall back
  // to `process.cwd()`: the proxy's own cwd is the plugin dir (it launches via
  // `npm --prefix`), not the session workspace.
  const cwdSource =
    env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.length > 0
      ? env.CLAUDE_PROJECT_DIR
      : env.INIT_CWD && env.INIT_CWD.length > 0
        ? env.INIT_CWD
        : undefined
  if (cwdSource) metadata.cwd = safeRealpath(cwdSource)
  Object.assign(metadata, claudemuxIdentityFromEnv(env))
  return metadata
}

/**
 * The one place feishu-channel reads a claudemux-specific env var. claudemux's
 * `tm spawn` injects `CLAUDEMUX_TEAMMATE_NAME` into the teammate's tmux session,
 * which the proxy inherits; the dispatcher session has none. Best-effort: when
 * absent (a non-claudemux session, or the dispatcher) it contributes nothing,
 * so it adds no runtime or version dependency on claudemux.
 */
export function claudemuxIdentityFromEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const name = sessionToken(env.CLAUDEMUX_TEAMMATE_NAME)
  return name === null ? {} : { teammate_name: name }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Process entry point: daemon mode or per-session proxy mode. */
async function main(): Promise<void> {
  if (process.argv.includes('--daemon') || process.env.FEISHU_CHANNEL_DAEMON === '1') {
    await runDaemonMain()
    return
  }
  await runProxyMain()
}

// Run `main` when invoked as the program entry, not when a test imports this
// module. `realpathSync` canonicalizes the invocation path so it matches the
// symlink-resolved module URL.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[feishu-channel] failed to start:', err)
    process.exit(1)
  })
}
