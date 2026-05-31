/**
 * The `im.message.receive_v1` handler — inbound Feishu chat messages.
 *
 * This is the channel's first event handler and the template for the rest.
 * It owns everything specific to one Feishu event type: the raw-payload
 * decode (`normalizeInboundEvent`), the content parse, the access gate, the
 * pairing side effect, and the mapping to a `ChannelDelivery`. The server
 * registers it into the `EventRegistry`; the core pipeline never references
 * it directly.
 */

import { gate, isBotSenderType, isGroupAuthorized } from '../access'
import { loadAccess, saveAccess } from '../access-store'
import { mentionName, parseInbound } from '@excitedjs/feishu-transport'
import type { ChannelDelivery, EventHandler, HandlerContext } from '../events'
import { asString, isRecord } from '@excitedjs/feishu-transport'
import { recordBotIdentity } from '../identity-store'
import { enqueuePendingNewBot, readChatBots, recordChatMember } from '../chat-bots-store'
import { buildDiscoveryContext, observeBotSender } from '../bot-discovery'
import type { Mention } from '@excitedjs/feishu-transport'

/** The Feishu event_type this handler subscribes to. */
export const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

/** A normalized inbound Feishu message, as the handler consumes it. */
export interface FeishuInboundEvent {
  /** message_id (`om_...`) — used to react to or edit this message. */
  messageId: string
  /** chat_id (`oc_...`) — the conversation the message arrived in. */
  chatId: string
  /** Feishu chat_type — `p2p` for a direct message, `group` for a group. */
  chatType: string
  /** open_id of the sender — the identity access control gates on. */
  senderId: string
  /** Feishu sender_type — `'user'` for a human, `'bot'` for an app/bot. */
  senderType: string
  /** Feishu message_type — `text`, `post`, `image`, `file`, ... */
  messageType: string
  /** JSON-encoded content string, exactly as Feishu delivered it. */
  content: string
  /** @-mentions carried by the message; always an array, never undefined. */
  mentions: Mention[]
  /** Feishu create_time (epoch millis as a string), or `''` if absent. */
  createTime: string
}

/**
 * Build the `im.message.receive_v1` event handler: decode the raw payload,
 * gate it, and either deliver it, send a pairing prompt, or drop it.
 */
export function createImMessageHandler(): EventHandler {
  return {
    eventType: IM_MESSAGE_EVENT_TYPE,
    async handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null> {
      const event = normalizeInboundEvent(raw)
      if (!event) return null

      const parsed = parseInbound({
        message_type: event.messageType,
        content: event.content,
        mentions: event.mentions,
      })

      const loaded = loadAccess(ctx.accessFile)
      if (loaded.corrupt) {
        ctx.logError('access.json was unreadable; started from defaults')
      }

      // Hoist the /introduce detection once; both paths below reuse this result.
      const isIntroduce = isIntroduceCommand(event.content, event.messageType, event.mentions)
      const isGroup = event.chatType === 'group'
      const groupAuthorized =
        isGroup && isGroupAuthorized(loaded.access, event.chatId, event.senderId)

      // Passive auto-observe: any bot message in an authorized group teaches us
      // that bot's open_id, so the model can later @-mention it. This is
      // discovery only — it records the bot into the per-chat membership and the
      // app-wide identity map, but NOT into the gate's trust set, so observing a
      // bot never widens who may reach the session. Runs before the gate so even
      // an about-to-be-dropped ambient message still contributes to discovery.
      if (isGroup && groupAuthorized && isBotSenderType(event.senderType)) {
        const senderName =
          mentionName(event.mentions, event.senderId) ?? ''
        observeBotSender(ctx.baseDir, ctx.transport.appId, event.chatId, {
          botOpenId: ctx.transport.botOpenId,
          senderType: event.senderType,
          senderOpenId: event.senderId,
          senderName,
          now: ctx.now(),
        })
      }

      // Ambient /introduce: a bot sender that broadcasts /introduce in an
      // authorized group authorizes itself — it joins the gate's trust set even
      // without @-mentioning us. Runs before the gate's trust set is read below,
      // so the sender passes the gate on this same message (single-step
      // self-introduction).
      if (isGroup && groupAuthorized && isBotSenderType(event.senderType) && isIntroduce) {
        const name =
          mentionName(event.mentions, event.senderId) ?? event.senderId
        try {
          recordBotIdentity(
            ctx.baseDir,
            ctx.transport.appId,
            event.chatId,
            [{ openId: event.senderId, name }],
            'introduce',
            ctx.now(),
          )
          recordChatMember(ctx.baseDir, ctx.transport.appId, event.chatId, event.senderId, {
            introduced: true,
          })
        } catch (err) {
          ctx.logError('ambient /introduce: failed to persist sender bot', err)
        }
      }

      // The gate's trust set is the introduce-authorized bots only — passive
      // auto-observe above does not feed it.
      const observedBotIds = isGroup
        ? new Set(readChatBots(ctx.baseDir, ctx.transport.appId, event.chatId).introducedOpenIds)
        : undefined

      const decision = gate({
        senderId: event.senderId,
        senderType: event.senderType,
        chatId: event.chatId,
        chatType: event.chatType,
        access: loaded.access,
        now: ctx.now(),
        newCode: ctx.generateCode(),
        mentions: event.mentions,
        botOpenId: ctx.transport.botOpenId,
        observedBotIds,
      })
      const persist = (): void => {
        if (decision.changed) saveAccess(ctx.accessFile, decision.access)
      }

      // @-mention /introduce collaboration handshake — intercept before normal
      // routing. Detect using raw content + mention keys (not display names) so
      // names with spaces don't break the prefix-strip. Side effects only fire
      // when the access gate would deliver; for pair/drop we consume silently
      // without persisting — saving a pair decision here would create a phantom
      // pairing code that was never shown to anyone, causing "group pairing
      // already pending" to block legitimate pairings until the entry expires.
      if (isIntroduce) {
        if (decision.action === 'deliver') {
          persist()
          await handleIntroduce(event, ctx)
        }
        return null
      }

      switch (decision.action) {
        case 'deliver': {
          persist()
          // Attach the one-shot bot-discovery context — a sender line for a
          // peer bot, the first-join baseline, and any incremental delta. The
          // `commit` persists "already injected" state and is returned on the
          // delivery so the server runs it only after the session notification
          // succeeds; a failed delivery then leaves the one-shot context to be
          // re-attached next time rather than silently consumed.
          const discovery = isGroup
            ? buildDiscoveryContext(ctx.baseDir, ctx.transport.appId, event.chatId, {
                botOpenId: ctx.transport.botOpenId,
                senderType: event.senderType,
                senderOpenId: event.senderId,
                now: ctx.now(),
              })
            : undefined
          const content =
            discovery && discovery.prefix ? discovery.prefix + parsed.text : parsed.text
          return { content, meta: buildMeta(event), commit: discovery?.commit }
        }
        case 'drop':
          persist()
          ctx.logDebug(
            `dropped a message from ${event.senderId} in chat ${event.chatId}: ` +
              decision.reason,
          )
          return null
        case 'pair': {
          // Send the pairing code before recording the pending entry. A
          // transient send failure then leaves no pending entry no one ever
          // received a code for — the next message simply starts a fresh
          // pairing instead of finding a code that was never seen.
          const prompt =
            event.chatType === 'group'
              ? groupPairingPrompt(decision.code)
              : pairingPrompt(decision.code, decision.isResend)
          try {
            await ctx.transport.sendText(event.chatId, prompt)
          } catch (err) {
            ctx.logError('failed to send a pairing code', err)
            return null
          }
          persist()
          return null
        }
      }
    },
  }
}

// ── /introduce collaboration handshake ─────────────────────────────────────
//
// A user sends `@BotA @BotB /introduce` in a group. Each bot receives the
// same event with mentions[] populated from its own app's perspective — the
// open_ids in that list are exactly the ids this app must use to @-mention the
// others. We persist them as introduced, gate-trusted members of that chat, so
// a peer bot's message there reaches the session.
//
// `/introduce` is the explicit path; passive auto-observe (above) also learns a
// peer's open_id from any message it sends, but only for discovery — it does
// not authorize the gate. Feishu has no API to list a group's bot members, so
// these two paths are the only ways to learn a peer bot's open_id.

const INTRODUCE_RE = /^\/introduce(?:\s|$)/i

/**
 * True when this message is a /introduce command.
 *
 * Detection operates on the raw message content (before mention-key → display-name
 * replacement) and strips leading mention keys by exact match. This is necessary
 * because display names can contain spaces: after `parseInbound` replaces `@_user_1`
 * with `@Claude Code`, a word-boundary regex only strips `@Claude` and leaves
 * `Code @Bot B /introduce` unmatched. Stripping the original Feishu placeholder
 * tokens (e.g. `@_user_1`) is safe because they never contain spaces.
 *
 * Supports `text` messages only; non-text types (image, file, post) cannot carry
 * a /introduce command and return false immediately.
 */
function isIntroduceCommand(rawContent: string, messageType: string, mentions: Mention[]): boolean {
  if (messageType !== 'text') return false
  let text: string
  try {
    const obj = JSON.parse(rawContent) as Record<string, unknown>
    text = typeof obj.text === 'string' ? obj.text : ''
  } catch {
    return false
  }
  // Strip leading Feishu mention-key tokens (e.g. "@_user_1 ") one at a time.
  // Keys are exact placeholders with no spaces, so stripping them is unambiguous.
  let remaining = text.trimStart()
  let progress = true
  while (progress) {
    progress = false
    for (const m of mentions) {
      if (remaining.startsWith(m.key)) {
        remaining = remaining.slice(m.key.length).trimStart()
        progress = true
        break
      }
    }
  }
  return INTRODUCE_RE.test(remaining)
}

/**
 * Side-effect for an authorized /introduce command: persist the @-mentioned
 * peer bots and send a best-effort ack. Only called when the access gate says
 * deliver. The bot itself is excluded — it is always in its own mentions, but
 * recording or counting itself as a "partner" is meaningless. Each peer is
 * double-written: into the app-wide identity map (open_id → name) and into the
 * per-chat membership as an introduced, gate-trusted member.
 */
async function handleIntroduce(event: FeishuInboundEvent, ctx: HandlerContext): Promise<void> {
  const external = event.mentions
    .map((m) => ({ openId: m.id?.open_id ?? '', name: m.name ?? '' }))
    .filter((b) => b.openId && b.name && b.openId !== ctx.transport.botOpenId)

  if (external.length === 0) {
    ctx.logDebug(`/introduce in ${event.chatId}: no external bot in mentions — ignoring`)
    return
  }

  try {
    recordBotIdentity(ctx.baseDir, ctx.transport.appId, event.chatId, external, 'introduce', ctx.now())
    for (const b of external) {
      const { wasNew } = recordChatMember(ctx.baseDir, ctx.transport.appId, event.chatId, b.openId, {
        introduced: true,
      })
      // /introduce is the backfill path: a bot learned here that the chat has
      // not seen before must still reach the model. If the baseline is already
      // injected it won't be re-listed, so queue it for the next incremental
      // delta — mirroring auto-observe. A bot already in the chat is not
      // re-queued.
      if (wasNew) enqueuePendingNewBot(ctx.baseDir, ctx.transport.appId, event.chatId, b.openId)
    }
  } catch (err) {
    ctx.logError('/introduce: failed to persist observed bots', err)
  }

  const items = external.map((b) => `@${b.name}`).join(' ')
  try {
    await ctx.transport.sendText(event.chatId, `✅ 已认识本群 ${external.length} 个伙伴：${items}`)
  } catch (err) {
    ctx.logError('/introduce: ack failed', err)
  }
}

/** Build the `<channel>` tag attributes for a delivered message. */
function buildMeta(event: FeishuInboundEvent): Record<string, string> {
  // Keys must be alphanumeric-plus-underscore — a hyphen would be dropped.
  return {
    kind: 'message',
    chat_id: event.chatId,
    message_id: event.messageId,
    chat_type: event.chatType,
    sender_id: event.senderId,
  }
}

/** The message sent back to an un-paired sender, carrying their pairing code. */
function pairingPrompt(code: string, isResend: boolean): string {
  const lead = isResend
    ? 'You already have a pending pairing request for this Claude Code channel.'
    : 'This Claude Code channel must pair with you before it will deliver your messages.'
  return [
    lead,
    `Pairing code: ${code}`,
    'Share this code with the operator running Claude Code so they can approve you.',
  ].join('\n')
}

/**
 * The message posted into an un-paired group, carrying its pairing code. The
 * code is visible to every group member, but it grants nothing on its own —
 * authorizing the group still takes the operator, the access skill, and the
 * running Claude Code session.
 */
function groupPairingPrompt(code: string): string {
  return [
    'This group is not yet authorized for this Claude Code channel.',
    `Pairing code: ${code}`,
    'Share this code with the operator running Claude Code so they can authorize this group.',
  ].join('\n')
}

/**
 * Reshape a raw `im.message.receive_v1` payload into a `FeishuInboundEvent`.
 *
 * Returns `null` when an essential field (sender open_id, chat_id, message_id)
 * is missing, since such an event can neither be gated nor answered. Pure: no
 * I/O, no clock, never throws. Tolerates either the event body alone (what the
 * SDK's `EventDispatcher` delivers) or a full `{ event: ... }` envelope.
 */
export function normalizeInboundEvent(raw: unknown): FeishuInboundEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw

  const sender = isRecord(event.sender) ? event.sender : {}
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {}
  const message = isRecord(event.message) ? event.message : {}

  const openId = asString(senderId.open_id)
  const messageId = asString(message.message_id)
  const chatId = asString(message.chat_id)
  if (!openId || !messageId || !chatId) return null

  return {
    messageId,
    chatId,
    chatType: asString(message.chat_type),
    senderId: openId,
    senderType: asString(sender.sender_type),
    messageType: asString(message.message_type) || 'unknown',
    content: asString(message.content),
    mentions: normalizeMentions(message.mentions),
    createTime: asString(message.create_time),
  }
}

/** Reshape a raw `mentions` array into well-formed `Mention` objects. */
function normalizeMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  const out: Mention[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const key = asString(item.key)
    if (!key) continue
    const mention: Mention = { key }
    if (isRecord(item.id)) {
      const id: NonNullable<Mention['id']> = {}
      const openId = asString(item.id.open_id)
      const unionId = asString(item.id.union_id)
      const userId = asString(item.id.user_id)
      if (openId) id.open_id = openId
      if (unionId) id.union_id = unionId
      if (userId) id.user_id = userId
      mention.id = id
    }
    const name = asString(item.name)
    if (name) mention.name = name
    out.push(mention)
  }
  return out
}
