/**
 * The `im.chat.member.bot.added_v1` handler — the bot was added to a group.
 *
 * Per Feishu's documented semantics this event is delivered to the bot that was
 * just added, and its payload carries the operator and the chat but NOT the
 * added bot's own open_id. So it is useful for exactly one thing: knowing "I
 * just joined chat X". The handler records that as `needsBaselineOnNextMention`
 * so the next message this channel delivers in that chat is prefixed with a
 * one-shot roster of the peer bots discovered so far. It never notifies the
 * model directly — a membership change is not a message to answer.
 *
 * It cannot enumerate the other bots already in the group: Feishu has no API to
 * list a chat's bot members, and the event names none. The baseline is built
 * from passive auto-observe and `/introduce`, so on a fresh join it may be
 * empty and fill in as peers speak.
 */

import { markNeedsBaseline, recordSeenEvent } from '../chat-bots-store'
import type { ChannelDelivery, EventHandler, HandlerContext } from '../events'
import { BOT_MEMBER_ADDED_EVENT_TYPE, normalizeBotMemberAddedEvent } from '@excitedjs/feishu-transport'

// The event-type constant and the pure envelope parse now live in the shared
// core (`@excitedjs/feishu-transport`, per the 长链/分发/解析/编码 boundary).
// Re-exported so this handler's import sites (route registry, tests) are stable.
export { BOT_MEMBER_ADDED_EVENT_TYPE }

/**
 * Build the `im.chat.member.bot.added_v1` handler: record the join so the next
 * delivered message in that chat carries a discovery baseline, and drop the
 * event (return `null`) since there is nothing to deliver.
 */
export function createBotMemberHandler(): EventHandler {
  return {
    eventType: BOT_MEMBER_ADDED_EVENT_TYPE,
    async handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null> {
      const info = normalizeBotMemberAddedEvent(raw)
      if (!info) return null

      // Idempotency: a redelivered event must not re-arm the baseline twice.
      if (info.eventId) {
        const { wasNew } = recordSeenEvent(ctx.baseDir, ctx.transport.appId, info.chatId, info.eventId)
        if (!wasNew) return null
      }

      markNeedsBaseline(ctx.baseDir, ctx.transport.appId, info.chatId)
      return null
    },
  }
}
