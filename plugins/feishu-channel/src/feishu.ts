/**
 * The Feishu platform boundary.
 *
 * Everything that talks to Feishu — the inbound long-lived WebSocket and the
 * outbound message API — sits behind the `FeishuTransport` interface. The
 * channel server depends only on that interface, so its wiring can be
 * exercised against an injected fake with no live connection.
 *
 * The transport is event-type agnostic. `start` is handed a route table
 * mapping each Feishu event_type to a callback and registers every entry
 * with the SDK's event dispatcher; decoding a specific event's payload is the
 * job of that event's handler, not this module. Adding a new event type to
 * the channel therefore never touches this file.
 *
 * Only one server process per machine opens the inbound WebSocket. `start`
 * acquires a single-instance lock (see `./instance-lock`); a process that
 * loses the lock stands by and polls, so a crashed holder is taken over.
 */

import { chmodSync, mkdirSync } from 'node:fs'

import * as lark from '@larksuiteoapi/node-sdk'

import { inboundResourceDir, inboundResourcePath } from './paths'
import {
  connectionErrorLogLine,
  reconnectedLogLine,
  reconnectExhaustedLogLine,
  reconnectingLogLine,
  startupTimeoutLogLine,
} from './connection'
import {
  acquireInstanceLock,
  acquireInstanceLockWithEviction,
  releaseInstanceLock,
} from './instance-lock'
import { cardToContent, renderMarkdownToCards, type RenderedCard } from '@excitedjs/feishu-transport'
import { styleReplyCard, styleReplyCards } from './card-style'

/** Cap on a single WebSocket handshake before it is aborted into a retry. */
const WS_HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * How long one resource download is given before it is abandoned. Feishu's own
 * 100 MB limit bounds the size; this bounds the wait, so a slow or stuck
 * transfer falls back to a token-ref placeholder instead of holding up the
 * whole inbound delivery.
 */
const RESOURCE_DOWNLOAD_TIMEOUT_MS = 15_000

/**
 * How long the initial connection is given to come up before the channel
 * stops it. Long enough to absorb a brief blip and the SDK's own early
 * retries; past it, an unreachable Feishu would otherwise retry in a tight
 * loop, so the channel cuts the attempt off.
 */
const WS_STARTUP_GRACE_MS = 30_000

/** Maximum SDK reconnect attempts after an established connection drops. */
export const WS_RUNNING_RECONNECT_MAX_ATTEMPTS = 5

/** How often to inspect the SDK reconnect loop while it is running. */
const WS_RUNNING_RECONNECT_POLL_MS = 1_000

/**
 * How often a stood-by process retries the single-instance lock. Sets the
 * worst-case gap between a holder crashing and a sibling taking over the
 * inbound connection.
 */
const STANDBY_POLL_MS = 30_000

/**
 * A Lark-SDK logger that writes every line to stderr.
 *
 * The MCP stdio transport reserves stdout for the JSON-RPC stream. The SDK's
 * default logger writes to stdout, which corrupts that stream: the client
 * rejects the non-JSON lines, and a log line emitted while a notification is
 * being written can break the notification's frame and drop a real inbound
 * message. Routing the SDK's logger to stderr keeps stdout exclusively
 * JSON-RPC, while the SDK's diagnostics stay visible in the server's log.
 */
const sdkLogger = {
  error: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  warn: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  info: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  debug: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  trace: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
}

/** Outcome of an outbound send. */
export interface FeishuSendResult {
  /**
   * message_ids of every card the send produced, in order. A Markdown body
   * that fits one card produces one entry; a longer body that the renderer
   * split over several cards produces several. Empty when Feishu omitted the
   * message_ids.
   */
  messageIds: string[]
  /**
   * The chat the message actually landed in. When the send replied to a
   * message_id, this is the reply target's chat from the Feishu response — the
   * authoritative landing chat, independent of any chat_id the caller paired
   * with the message_id; otherwise it is the `chat_id` the send was routed to.
   */
  chatId: string
}

/**
 * A request to download one top-level inbound message resource. `type` is the
 * resource kind the `messageResource.get` API expects — `image` for an image
 * message's `image_key`, `file` for a file message's `file_key` — and `fileKey`
 * is that key's value. `fileName` (a file's original name) supplies the on-disk
 * extension for a `file`; an image's extension is read from the download
 * response's content-type instead.
 */
export interface InboundResourceRequest {
  messageId: string
  fileKey: string
  type: 'image' | 'file'
  fileName?: string
}

/**
 * Build the `content` string for a Feishu plain-text message — the legacy
 * `msg_type: 'text'` payload, used by `editText`'s fallback path so an edit
 * on a message that was sent before this channel switched to interactive
 * cards still works.
 */
export function textMessageContent(text: string): string {
  return JSON.stringify({ text })
}

/**
 * The Feishu business error code on an SDK result or a thrown error, or
 * `undefined`. The lark SDK returns the raw `{ code, msg, data }` body for an
 * HTTP-200 business error — so a non-zero `code` sits on the resolved value —
 * and throws for an HTTP-level error, where the code, when present, is on the
 * thrown axios error's `response.data`. This reads both shapes.
 */
function feishuErrorCode(x: unknown): number | undefined {
  if (!x || typeof x !== 'object') return undefined
  const top = (x as { code?: unknown }).code
  if (typeof top === 'number') return top
  const data = (x as { response?: { data?: { code?: unknown } } }).response?.data
  if (data && typeof data.code === 'number') return data.code
  return undefined
}

/** Build an Error from a non-zero Feishu response, carrying its `code`. */
function feishuError(res: unknown): Error {
  const code = feishuErrorCode(res)
  const msg = (res as { msg?: unknown })?.msg
  const detail = typeof msg === 'string' && msg ? `: ${msg}` : ''
  return Object.assign(new Error(`Feishu API error ${code ?? '?'}${detail}`), { code })
}

/**
 * Reply to `messageId`, returning the new message_id and the chat the reply
 * landed in. Feishu inherits the replied message's location: a reply to a topic
 * message lands back in that topic, a reply to a main-timeline message in the
 * main timeline — no thread flag needed. The reply routes by `message_id`
 * alone, so the returned `chatId` (from the reply response) is the authoritative
 * landing chat — never a caller-supplied chat_id. A non-zero Feishu code throws
 * (no silent drop), and a success that omits `chat_id` also throws rather than
 * letting the caller guess the chat: clearing a received indicator must follow
 * the real landing chat, not trusted input.
 */
async function replyToMessageOnce(
  client: lark.Client,
  messageId: string,
  content: string,
): Promise<{ messageId?: string; chatId: string }> {
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'interactive', content },
  })
  const code = feishuErrorCode(res)
  if (code) throw feishuError(res)
  const chatId = res.data?.chat_id
  if (!chatId) {
    throw new Error(
      `Feishu reply to ${messageId} omitted chat_id; cannot resolve the landing chat`,
    )
  }
  return { messageId: res.data?.message_id, chatId }
}

/**
 * Create a message addressed by `chatId`, returning the new message_id. A
 * non-zero Feishu code throws — same guard as the reply path — so a business
 * failure never reads as a phantom "Sent" with nothing delivered.
 */
async function createMessageOnce(
  client: lark.Client,
  chatId: string,
  content: string,
): Promise<string | undefined> {
  const res = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content },
  })
  const code = feishuErrorCode(res)
  if (code) throw feishuError(res)
  return res.data?.message_id
}

/**
 * Feishu's documented hard limit for a card / rich-text request body. Past
 * this the API rejects the call outright; the channel checks against a
 * slightly lower budget so headers and the JSON envelope do not push a
 * borderline payload over.
 */
export const FEISHU_CARD_REQUEST_LIMIT_BYTES = 30 * 1024

/**
 * Safe ceiling for the serialised card `content` string. Stays a few hundred
 * bytes below the documented 30 KB request-body limit so HTTP headers and the
 * `{ params, data: { receive_id, msg_type, content } }` envelope still fit.
 */
export const FEISHU_CARD_CONTENT_SAFE_BYTES = 28 * 1024

/**
 * Throw a clear, model-actionable error when a card payload would exceed
 * Feishu's request-body limit. The renderer already keeps the first card
 * safely under the cap by splitting at element boundaries, but an
 * `edit_message` call patches one card in place and cannot fan out — so the
 * size has to be enforced here, before the SDK round-trips and returns a
 * low-level Feishu code with no fix path.
 */
function assertCardContentFits(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > FEISHU_CARD_CONTENT_SAFE_BYTES) {
    throw new Error(
      `card content is ${bytes} bytes; Feishu rejects a card-message body over ${FEISHU_CARD_REQUEST_LIMIT_BYTES} bytes. ` +
        'Send a fresh, shorter message (which the channel splits automatically) instead of editing in place.',
    )
  }
}

/**
 * Render `text` as a single v2 card, throwing when the body exceeds what
 * one card can hold. Used by `editText` — an edit patches one message_id
 * in place and cannot fan out, so a multi-card body has no destination.
 */
function renderSingleCard(text: string): RenderedCard {
  const cards = renderMarkdownToCards(text)
  if (cards.length !== 1) {
    throw new Error(
      `edit body produced ${cards.length} cards, but an edit can only update one ` +
        'card in place. Reduce the body length, drop oversized tables, or send a ' +
        'fresh reply (which the channel splits automatically) instead of editing.',
    )
  }
  // The renderer always returns a non-empty array, but TypeScript can't
  // narrow that — pull the element out with the assertion that we just
  // verified there is exactly one.
  return cards[0] as RenderedCard
}

/** One reply within a fetched document-comment thread. */
export interface FeishuDocCommentReply {
  /** reply_id of this reply; `''` when Feishu omitted it. */
  replyId: string
  /** open_id of the reply's author. */
  authorId: string
  /** Raw Feishu rich-content elements of the reply body, rendered by the handler. */
  elements: unknown[]
}

/**
 * A document comment and its reply thread, fetched to enrich a comment event.
 *
 * The `drive.notice.comment_add_v1` payload carries only the comment's ids, so
 * the comment text is fetched separately — this is the fetched result.
 */
export interface FeishuDocComment {
  /** False for a comment anchored to a text selection; `quote` then holds it. */
  isWhole: boolean
  /** The selected text a local-selection comment is anchored to; `''` otherwise. */
  quote: string
  /** The comment's replies, oldest first. */
  replies: FeishuDocCommentReply[]
}

/** A document's human-readable identity, fetched to render a comment event. */
export interface FeishuDocMeta {
  /** Document title. */
  title: string
  /** Browser URL of the document. */
  url: string
}

/** Document types the drive file-comment API serves; others have no comment API. */
const COMMENT_FILE_TYPES = ['doc', 'docx', 'sheet', 'file'] as const
type CommentFileType = (typeof COMMENT_FILE_TYPES)[number]

/** Narrow an event's file_type to one the file-comment API accepts, or `undefined`. */
function asCommentFileType(fileType: string): CommentFileType | undefined {
  return (COMMENT_FILE_TYPES as readonly string[]).includes(fileType)
    ? (fileType as CommentFileType)
    : undefined
}

/**
 * One comment as `drive.v1.fileComment.batchQuery` returns it — only the
 * fields the channel reads. The SDK's response type carries more; this is the
 * structural subset `commentFromBatchQuery` decodes, and the shape a unit
 * test builds a fixture against.
 */
interface RawCommentItem {
  comment_id?: string
  is_whole?: boolean
  quote?: string
  reply_list?: {
    replies?: Array<{
      reply_id?: string
      user_id?: string
      content?: { elements?: unknown[] }
    }>
  }
}

/**
 * Pick the comment with `commentId` out of a `fileComment.batchQuery` response
 * and shape it into a `FeishuDocComment`. Returns `null` when the response
 * carried no such comment. Pure: no I/O, never throws — exported so the decode
 * is unit-tested without a live Feishu connection.
 */
export function commentFromBatchQuery(
  items: RawCommentItem[],
  commentId: string,
): FeishuDocComment | null {
  const item = items.find((c) => c.comment_id === commentId)
  if (!item) return null
  const replies: FeishuDocCommentReply[] = (item.reply_list?.replies ?? []).map((reply) => ({
    replyId: reply.reply_id ?? '',
    authorId: reply.user_id ?? '',
    elements: reply.content?.elements ?? [],
  }))
  return { isWhole: item.is_whole ?? true, quote: item.quote ?? '', replies }
}

/** Document types the drive metadata API serves. */
const META_DOC_TYPES = [
  'doc',
  'docx',
  'sheet',
  'bitable',
  'mindnote',
  'file',
  'wiki',
  'folder',
  'synced_block',
  'slides',
] as const
type MetaDocType = (typeof META_DOC_TYPES)[number]

/** Narrow an event's file_type to one the metadata API accepts, or `undefined`. */
function asMetaDocType(fileType: string): MetaDocType | undefined {
  return (META_DOC_TYPES as readonly string[]).includes(fileType)
    ? (fileType as MetaDocType)
    : undefined
}

/**
 * Inbound event routes: Feishu event_type → callback. The server builds this
 * from the event registry; the transport registers every entry with the
 * SDK's event dispatcher. The callback receives the raw event payload exactly
 * as the SDK delivered it.
 */
export type InboundRoutes = Record<string, (raw: unknown) => void | Promise<void>>

/**
 * The platform boundary the channel server depends on. The real implementation
 * (`createFeishuTransport`) wraps the Feishu SDK; tests inject a fake so the
 * server's inbound and outbound wiring runs without a live Feishu connection.
 */
export interface FeishuTransport {
  /** The app id this transport was created with. */
  readonly appId: string
  /**
   * open_id of the bot itself, for group mention-gating. `undefined` until
   * `start` has resolved it (and stays `undefined` if resolution failed).
   */
  readonly botOpenId: string | undefined
  /**
   * Take part in the single-instance election. The process that wins the lock
   * opens the long-lived connection and dispatches inbound events via
   * `routes`; a process that loses stands by and polls to take over.
   */
  start(routes: InboundRoutes): Promise<void>
  /**
   * Send a text message into a chat. With `opts.replyToMessageId` set, it is
   * sent as a reply to that message, which makes Feishu place it wherever that
   * message lives — back in its topic if it was a topic message, or the main
   * timeline otherwise — with no thread flag. The caller passes the message_id
   * of the inbound message being answered, so the reply follows the very
   * message that triggered it, and the result's `chatId` is the chat the reply
   * landed in (from the Feishu response, never the caller's chat_id). Without
   * `opts.replyToMessageId` the message is sent by `chat_id` as a standalone
   * message (e.g. a proactive send with no message to answer). A non-zero Feishu
   * code on either path throws rather than reporting a phantom success.
   */
  sendText(
    chatId: string,
    text: string,
    opts?: { replyToMessageId?: string },
  ): Promise<FeishuSendResult>
  /**
   * Add an emoji reaction to a message and return the reaction_id Feishu
   * assigned. That id is what `removeReaction` needs to take the same reaction
   * back off; Feishu can omit it, in which case an empty string is returned.
   */
  addReaction(messageId: string, emoji: string): Promise<string>
  /**
   * Remove a reaction from a message, identified by the reaction_id that
   * `addReaction` returned. Feishu only lets the app that added a reaction
   * remove it, so this is always paired with a prior `addReaction` from the
   * same channel.
   */
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** Replace the text of a message the bot previously sent. */
  editText(messageId: string, text: string): Promise<void>
  /**
   * Download a top-level message resource (a chat image or file) into the local
   * inbound cache and return its absolute path, or `null` when it could not be
   * downloaded — an unsupported resource, one over Feishu's 100 MB limit, a
   * missing scope, a timeout, or any other failure. Never throws: the caller
   * renders a token-ref placeholder instead, so a failed download degrades the
   * message rather than dropping it.
   */
  downloadInboundResource(req: InboundResourceRequest): Promise<string | null>
  /**
   * Fetch one document comment and its reply thread. The comment-add event
   * payload carries no comment text, so the doc-comment handler calls this to
   * fill it in. Best-effort: returns `null` for a file type with no comment
   * API or on any API failure, and never throws — a failure degrades the
   * notification rather than dropping the event.
   */
  fetchDocComment(
    fileToken: string,
    fileType: string,
    commentId: string,
  ): Promise<FeishuDocComment | null>
  /**
   * Fetch a document's title and URL, so a comment notification names the
   * document a human would recognize. Best-effort: returns `null` for a file
   * type with no metadata API or on any API failure, and never throws.
   */
  fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null>
  /** Close the connection and release every resource it holds. */
  close(): Promise<void>
}

/** Feishu self-built-app credentials. */
export interface FeishuCredentials {
  appId: string
  appSecret: string
}

/**
 * Optional knobs for `createFeishuTransport`. The `client` seam lets unit
 * tests inject a stub of just the SDK methods this module touches, so the
 * outbound paths (`sendText`, `editText`, the doc-comment fetchers) are
 * covered without a live Feishu app.
 */
export interface FeishuTransportOptions {
  /**
   * SDK client to use for outbound API calls. Default: a fresh `lark.Client`
   * built from `creds`. Tests pass a stub; production never sets this.
   */
  client?: lark.Client
  /**
   * When true, `start()` performs the legacy per-process single-instance
   * election before opening the Feishu WebSocket. The standing daemon owns
   * single-instance coordination itself, so it passes false to open the
   * transport directly.
   */
  singleInstance?: boolean
  /**
   * Test seam for the inbound WebSocket open. Production leaves this unset so
   * `openInbound` uses the Feishu SDK; unit tests use it to assert daemon-mode
   * lock-free startup without opening a real socket.
   */
  openInboundForTest?: (routes: InboundRoutes) => Promise<void>
  /** Test seam for the inbound WebSocket client. */
  wsClientForTest?: (params: ConstructorParameters<typeof lark.WSClient>[0]) => InboundWsClient
  /** Test seam for the initial connection grace window. */
  startupGraceMs?: number
  /**
   * Called when an established WebSocket cannot reconnect within the bounded
   * retry budget. The daemon uses this to exit so a fresh proxy can restart it.
   */
  onRunningReconnectExhausted?: (attempts: number) => void
  /**
   * Called when an established WebSocket reaches a terminal SDK error. Startup
   * failures throw instead, so daemon startup can release its socket and locks
   * before the process exits.
   */
  onTerminalConnectionError?: (err: Error) => void
  /** Test seam for the running reconnect watchdog. */
  runningReconnectMaxAttempts?: number
  /** Test seam for the reconnect watchdog poll cadence. */
  runningReconnectPollMs?: number
}

interface ReconnectStatus {
  state: string
  reconnectAttempts: number
}

interface ReconnectGuardWs {
  getConnectionStatus(): ReconnectStatus
  close(params?: { force?: boolean }): void
}

interface InboundWsClient extends ReconnectGuardWs {
  start(params: { eventDispatcher: lark.EventDispatcher }): Promise<void>
}

export interface RunningReconnectGuard {
  reconnecting(): void
  reconnected(): void
  errored(): void
  stop(): void
}

export interface RunningReconnectGuardDeps {
  ws: ReconnectGuardWs
  maxAttempts?: number
  pollMs?: number
  logConnection?(line: string): void
  onExhausted?(attempts: number): void
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

/**
 * The real Feishu transport, wrapping the official SDK.
 *
 * Inbound: a `WSClient` opens a long-lived WebSocket and an `EventDispatcher`
 * routes every subscribed event_type to its callback. Outbound: a `Client`
 * calls the `im` message API; it manages the `tenant_access_token` internally.
 * The outbound paths are now unit-tested through the `client` seam in
 * `FeishuTransportOptions`; inbound still needs a live Feishu connection.
 */
export function createFeishuTransport(
  creds: FeishuCredentials,
  lockPath: string,
  options: FeishuTransportOptions = {},
): FeishuTransport {
  const singleInstance = options.singleInstance ?? true
  const client =
    options.client ??
    new lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      logger: sdkLogger,
    })
  let wsClient: InboundWsClient | undefined
  let runningReconnectGuard: RunningReconnectGuard | undefined
  let resolvedBotOpenId: string | undefined
  /** Poll handle while standing by for the lock; `undefined` once primary. */
  let standbyTimer: ReturnType<typeof setInterval> | undefined
  /** True once this process holds the single-instance lock. */
  let holdsLock = false

  /**
   * Open the inbound WebSocket and dispatch events through `routes`. Called
   * only by the process holding the single-instance lock — at startup if it
   * won the lock outright, or later from the standby poll once a previous
   * holder released or crashed.
   */
  async function openInbound(routes: InboundRoutes): Promise<void> {
    if (options.openInboundForTest) {
      await options.openInboundForTest(routes)
      return
    }

    resolvedBotOpenId = await resolveBotOpenId(client)
    const dispatcher = new lark.EventDispatcher({ logger: sdkLogger }).register(routes)

    // Resolves the first time the connection reaches `ready`; the startup
    // watchdog below races against it.
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })

    let startupComplete = false
    const createWs = options.wsClientForTest ?? ((params) => new lark.WSClient(params))
    const ws = createWs({
      appId: creds.appId,
      appSecret: creds.appSecret,
      // Route the SDK's own logging to stderr — see `sdkLogger`.
      logger: sdkLogger,
      // Bound a stuck WebSocket handshake so it fails into a retry rather
      // than holding a stuck DNS / NAT path open indefinitely.
      handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
      // autoReconnect stays on: an established connection that drops should
      // self-heal. The callbacks make every step of that loop visible, so a
      // failing connection is observable instead of a silent retry loop.
      autoReconnect: true,
      onReady: () => {
        logConnection('Feishu WebSocket connection is ready')
        markReady()
      },
      onReconnecting: () => runningReconnectGuard?.reconnecting(),
      onReconnected: () => runningReconnectGuard?.reconnected(),
      onError: (err) => {
        runningReconnectGuard?.errored()
        logConnection(connectionErrorLogLine(err))
        if (startupComplete) options.onTerminalConnectionError?.(err)
      },
    })
    wsClient = ws
    runningReconnectGuard = createRunningReconnectGuard({
      ws,
      maxAttempts: options.runningReconnectMaxAttempts,
      pollMs: options.runningReconnectPollMs,
      logConnection,
      onExhausted: options.onRunningReconnectExhausted,
    })

    void ws.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
      logConnection(connectionErrorLogLine(err))
    })

    // The SDK retries pullConnectConfig with no delay until it first
    // succeeds — it has no server-provided reconnect interval yet — so a
    // Feishu that is unreachable at startup spins a tight retry loop.
    // Give the initial connection a grace window; if it is still not up,
    // stop it so the loop does not run unbounded and unobserved.
    const cameUp = await raceConnectionReady(ready, options.startupGraceMs ?? WS_STARTUP_GRACE_MS)
    if (!cameUp) {
      const gaveUp = ws.getConnectionStatus().state === 'failed'
      const line = startupTimeoutLogLine(options.startupGraceMs ?? WS_STARTUP_GRACE_MS, gaveUp)
      logConnection(line)
      ws.close()
      runningReconnectGuard?.stop()
      runningReconnectGuard = undefined
      throw new Error(line)
    }
    startupComplete = true
  }

  return {
    get appId(): string {
      return creds.appId
    },

    get botOpenId(): string | undefined {
      return resolvedBotOpenId
    },

    async start(routes: InboundRoutes): Promise<void> {
      if (!singleInstance) {
        logConnection('opening inbound connection without legacy instance lock')
        await openInbound(routes)
        return
      }

      // Exactly one process per machine opens the inbound WebSocket. A freshly
      // started server takes the lock when it is free, and evicts an older
      // channel server still holding it from a previous plugin version — so a
      // plugin upgrade takes effect at once instead of waiting out the old
      // server. Every other instance stands by and polls, so a crashed holder
      // is taken over rather than leaving the channel dark.
      const acquired = await acquireInstanceLockWithEviction(lockPath)
      if (acquired.acquired) {
        holdsLock = true
        logConnection(
          acquired.evicted
            ? 'evicted an older channel server and took over the inbound connection'
            : 'single-instance lock acquired — opening the inbound connection',
        )
        await openInbound(routes)
        return
      }

      logConnection(
        'another channel instance holds the inbound connection — standing by as secondary',
      )
      standbyTimer = setInterval(() => {
        if (!acquireInstanceLock(lockPath).acquired) return
        holdsLock = true
        if (standbyTimer) {
          clearInterval(standbyTimer)
          standbyTimer = undefined
        }
        logConnection('single-instance lock taken over — opening the inbound connection')
        void openInbound(routes)
      }, STANDBY_POLL_MS)
      // The poll must not by itself keep the process alive.
      ;(standbyTimer as { unref?: () => void }).unref?.()
    },

    async sendText(
      chatId: string,
      text: string,
      opts?: { replyToMessageId?: string },
    ): Promise<FeishuSendResult> {
      // Render the markdown source into one or more v2 cards. Routing per
      // block type — headings to `header.title`, tables to `tag: table`,
      // everything else to `tag: markdown` (lark_md) — keeps GFM tables and
      // ATX headings from leaking through as literal `|` and `#`. A body too
      // large for one card produces several cards, each its own message_id.
      // Re-style the rendered cards (size-adaptive collapsible frame) before
      // sending: short replies pass through untouched, long ones gain a
      // foldable panel and a tinted header. See `card-style.ts`.
      const cards = styleReplyCards(renderMarkdownToCards(text))
      const messageIds: string[] = []
      // The chat the message actually landed in. The whole send is either a
      // reply (every card replies to the same message_id) or a create (every
      // card to the same chat_id) — never a mix — so this resolves once per
      // path. For a reply it comes only from the reply response, so a
      // caller-supplied chat_id never participates; for a create it is the
      // chat the create routed to.
      let landedChatId: string | undefined
      for (const card of cards) {
        const content = cardToContent(card)
        if (opts?.replyToMessageId) {
          // Reply to the message: Feishu places it wherever that message lives
          // (its topic, or the main timeline) — no thread flag, and the chat_id
          // arg does not steer it. Every card replies to the same message so a
          // split answer stays together.
          const reply = await replyToMessageOnce(client, opts.replyToMessageId, content)
          if (reply.messageId) messageIds.push(reply.messageId)
          landedChatId = reply.chatId
        } else {
          const id = await createMessageOnce(client, chatId, content)
          if (id) messageIds.push(id)
          landedChatId = chatId
        }
      }
      // `?? chatId` only covers the degenerate empty-body case (no cards); a
      // non-empty body always renders at least one card, so on the reply path
      // landedChatId is the reply response's chat.
      return { messageIds, chatId: landedChatId ?? chatId }
    },

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res.data?.reaction_id ?? ''
    },

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    },

    async editText(messageId: string, text: string): Promise<void> {
      // An edit patches one message_id in place and cannot fan out, so
      // `renderSingleCard` rejects a body the renderer would otherwise split
      // across several cards. `assertCardContentFits` then catches the
      // residual case of a single-card body that still serialises past the
      // 30 KB request cap — both checks surface as actionable errors before
      // any SDK round-trip.
      // Style the single rendered card to match the send path, then verify
      // the styled content still fits one card before patching in place.
      const card = styleReplyCard(renderSingleCard(text))
      const cardContent = cardToContent(card)
      assertCardContentFits(cardContent)
      try {
        // The send path produces an interactive card, so the matching edit
        // is `im.message.patch` (card-content update). The original card was
        // sent with `update_multi: true`, which Feishu requires for a later
        // patch on the same message_id to be accepted.
        await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: cardContent },
        })
      } catch (patchErr) {
        // Legacy compatibility: a message_id Claude is still holding may
        // belong to a `msg_type: 'text'` message that this channel sent
        // before the upgrade to interactive cards. Feishu rejects `patch`
        // on a non-card target, so fall back to `im.message.update` with
        // the legacy text payload. If the update also fails — auth, rate
        // limit, deleted message — surface the original patch error, which
        // describes the path the channel actually intends to use.
        try {
          await client.im.message.update({
            path: { message_id: messageId },
            data: { msg_type: 'text', content: textMessageContent(text) },
          })
        } catch {
          throw patchErr
        }
      }
    },

    async downloadInboundResource(req: InboundResourceRequest): Promise<string | null> {
      try {
        // TODO: the timeout bounds the wait but does not cancel the underlying
        // SDK `get` / `writeFile` — a hung transfer keeps its handle until it
        // settles. Acceptable for v1: inbound messages are processed
        // sequentially and a message carries at most one top-level attachment,
        // so there is no concurrent fan-out to accumulate handles. Wire an
        // AbortController (or switch to `getReadableStream` + `destroy`) if v1
        // ever gains concurrent or inline-image downloads.
        return await withTimeout(
          downloadResourceToDisk(client, req),
          RESOURCE_DOWNLOAD_TIMEOUT_MS,
        )
      } catch (err) {
        // Every failure mode — unsupported type, over the size limit, a missing
        // scope, a timeout — lands here and degrades to a token-ref placeholder.
        // The message is still delivered; only the local copy is missing.
        console.error(
          `[feishu-channel] could not download ${req.type} resource ${req.fileKey} ` +
            `on message ${req.messageId}:`,
          err,
        )
        return null
      }
    },

    async fetchDocComment(
      fileToken: string,
      fileType: string,
      commentId: string,
    ): Promise<FeishuDocComment | null> {
      // The file-comment API only serves a subset of document types; for any
      // other type there is no comment to fetch, so skip the call outright.
      const ct = asCommentFileType(fileType)
      if (!ct) return null
      try {
        // `batchQuery` resolves a comment by id and serves both
        // whole-document and local-selection comments. The single-comment
        // `get` endpoint serves only whole-document comments — it returns
        // "not exist" for a comment anchored to a text selection, which is
        // most document comments.
        const res = await client.drive.fileComment.batchQuery({
          path: { file_token: fileToken },
          // Resolve reply authors to open_id, so they match the open_id the
          // event carries and the sender_id of chat messages.
          params: { file_type: ct, user_id_type: 'open_id' },
          data: { comment_ids: [commentId] },
        })
        return commentFromBatchQuery(res.data?.items ?? [], commentId)
      } catch (err) {
        console.error(
          `[feishu-channel] could not fetch comment ${commentId} on ${fileToken}:`,
          err,
        )
        return null
      }
    },

    async fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null> {
      const dt = asMetaDocType(fileType)
      if (!dt) return null
      try {
        const res = await client.drive.meta.batchQuery({
          data: { request_docs: [{ doc_token: fileToken, doc_type: dt }], with_url: true },
        })
        const meta = res.data?.metas?.[0]
        if (!meta) return null
        return { title: meta.title ?? '', url: meta.url ?? '' }
      } catch (err) {
        console.error(`[feishu-channel] could not fetch metadata for ${fileToken}:`, err)
        return null
      }
    },

    async close(): Promise<void> {
      if (standbyTimer) {
        clearInterval(standbyTimer)
        standbyTimer = undefined
      }
      try {
        runningReconnectGuard?.stop()
        runningReconnectGuard = undefined
        wsClient?.close()
      } catch (err) {
        // A close on an already-closed socket is expected; anything else
        // (e.g. the SDK's close surface changed) is worth a diagnostic line.
        console.error('[feishu-channel] error while closing the Feishu WebSocket:', err)
      }
      wsClient = undefined
      // Release the single-instance lock so a standing-by sibling can take
      // over. `releaseInstanceLock` removes the file only when this process
      // is the recorded holder, so a secondary calling `close()` cannot
      // disturb the real holder's lock.
      if (holdsLock) {
        releaseInstanceLock(lockPath)
        holdsLock = false
      }
    },
  }
}

export function createRunningReconnectGuard(deps: RunningReconnectGuardDeps): RunningReconnectGuard {
  const maxAttempts = deps.maxAttempts ?? WS_RUNNING_RECONNECT_MAX_ATTEMPTS
  const pollMs = deps.pollMs ?? WS_RUNNING_RECONNECT_POLL_MS
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval
  const log = deps.logConnection ?? (() => {})
  let timer: ReturnType<typeof setInterval> | undefined
  let exhausted = false

  const stop = (): void => {
    if (!timer) return
    clearIntervalFn(timer)
    timer = undefined
  }

  return {
    reconnecting() {
      log(reconnectingLogLine())
      if (timer || exhausted) return
      timer = setIntervalFn(() => {
        const status = deps.ws.getConnectionStatus()
        if (status.state !== 'reconnecting') return
        if (status.reconnectAttempts < maxAttempts) return

        exhausted = true
        stop()
        log(reconnectExhaustedLogLine(status.reconnectAttempts))
        deps.ws.close({ force: true })
        deps.onExhausted?.(status.reconnectAttempts)
      }, pollMs)
      timer.unref?.()
    },

    reconnected() {
      stop()
      exhausted = false
      log(reconnectedLogLine())
    },

    errored() {
      stop()
    },

    stop,
  }
}

/** How many times to try resolving the bot's open_id before giving up. */
const BOT_INFO_ATTEMPTS = 3

/**
 * Resolve the bot's own open_id, needed for group mention-gating. The SDK does
 * not expose a bot-info method, so this calls the raw endpoint through the
 * client (which still attaches the token).
 *
 * Best-effort: a failure leaves the open_id unknown rather than blocking
 * startup — but it is not silent. An unknown open_id makes `isBotMentioned`
 * never match, so every mention-gated group would drop every message; each
 * failure is logged with that consequence spelled out, and a transient error
 * is retried a few times before the channel gives up.
 */
async function resolveBotOpenId(client: lark.Client): Promise<string | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{ bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      if (openId) return openId
      // A well-formed response that simply lacks the field will not improve
      // on retry — stop here rather than spend the remaining attempts.
      console.error(
        '[feishu-channel] bot info response carried no open_id — groups that ' +
          'require an @-mention will drop every message until the channel restarts',
      )
      return undefined
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      console.error(
        `[feishu-channel] could not resolve the bot open_id after ${BOT_INFO_ATTEMPTS} ` +
          'attempts — groups that require an @-mention will drop every message ' +
          'until the channel restarts:',
        err,
      )
      return undefined
    }
  }
  return undefined
}

/** Resolve after `ms` milliseconds — the backoff between bot-info attempts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Write a timestamped connection-lifecycle line to the channel's stderr log. */
function logConnection(line: string): void {
  console.error(`[feishu-channel] ${new Date().toISOString()} ${line}`)
}

/**
 * Resolve `true` if `ready` settles within the startup grace window, `false`
 * if the window elapses first. The timer is cleared on the winning path so it
 * does not keep the process alive after the race is decided.
 */
function raceConnectionReady(ready: Promise<void>, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), graceMs)
    void ready.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Download one message resource to `inboundResourceDir()` and return its path.
 * The extension is chosen so Claude Code's `Read` recognizes the file: a file
 * keeps its original name's extension, an image's comes from the response
 * content-type (default `.png`). Throws on any SDK or filesystem failure;
 * `downloadInboundResource` catches it and falls back to a token-ref.
 */
async function downloadResourceToDisk(
  client: lark.Client,
  req: InboundResourceRequest,
): Promise<string> {
  const res = await client.im.messageResource.get({
    params: { type: req.type },
    path: { message_id: req.messageId, file_key: req.fileKey },
  })
  const ext =
    req.type === 'file'
      ? extFromFileName(req.fileName)
      : extFromContentType(readContentType(res.headers))
  // `inboundResourcePath` sanitizes the externally-supplied id/key/ext and
  // refuses a path that escapes the cache dir, so a crafted file_key cannot
  // write outside the inbound cache.
  const path = inboundResourcePath(req.messageId, req.fileKey, ext)
  const dir = inboundResourceDir()
  // Owner-only directory: a downloaded resource may be private and /tmp is
  // world-readable. mkdir's mode is umask-masked and only applies on create, so
  // chmod also covers a pre-existing or stricter-umask directory. This is the
  // load-bearing boundary — no other user can enter a 0700 directory they do
  // not own — so a failure here propagates and the download falls back.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  await res.writeFile(path)
  // Tighten the file to owner-only too (defense in depth on top of the 0700
  // directory). Best-effort: the file is already written and protected by the
  // directory mode, so a chmod hiccup must not discard a good download.
  try {
    chmodSync(path, 0o600)
  } catch {
    /* directory mode already restricts access; file-mode tightening is a bonus */
  }
  return path
}

/** The lower-cased extension (with leading dot) of a file name, or '' if none. */
function extFromFileName(fileName: string | undefined): string {
  if (!fileName) return ''
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot).toLowerCase()
}

/** Read the `content-type` value from the SDK's loosely-typed headers bag. */
function readContentType(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return ''
  const value = (headers as Record<string, unknown>)['content-type']
  return typeof value === 'string' ? value : ''
}

/** Map an image download's content-type to a `Read`-recognized extension. */
function extFromContentType(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  switch (type) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/bmp':
      return '.bmp'
    default:
      return '.png'
  }
}

/** Reject with a timeout error if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}
