import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandlerContext } from '../../src/events'
import {
  BOT_MEMBER_ADDED_EVENT_TYPE,
  createBotMemberHandler,
  normalizeBotAddedEvent,
} from '../../src/handlers/bot-member'
import { readChatBots } from '../../src/chat-bots-store'
import { FakeTransport } from '../support/fake-transport'

const NOW = 1_700_000_000_000
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-botmember-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(transport: FakeTransport): HandlerContext {
  return {
    transport,
    accessFile: join(dir, 'access.json'),
    baseDir: dir,
    now: () => NOW,
    generateCode: () => 'abc123',
    logError: () => {},
    logDebug: () => {},
  }
}

/** A raw `im.chat.member.bot.added_v1` envelope. */
function botAddedEvent(chatId: string, eventId = 'evt_1'): Record<string, unknown> {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: BOT_MEMBER_ADDED_EVENT_TYPE },
    event: {
      chat_id: chatId,
      operator_id: { open_id: 'ou_operator' },
      name: 'Some Group',
    },
  }
}

describe('normalizeBotAddedEvent', () => {
  test('extracts chat_id and event_id from a full envelope', () => {
    expect(normalizeBotAddedEvent(botAddedEvent('oc_grp', 'evt_9'))).toEqual({
      chatId: 'oc_grp',
      eventId: 'evt_9',
    })
  })

  test('tolerates a bare event body without a header (no event_id)', () => {
    expect(
      normalizeBotAddedEvent({ chat_id: 'oc_grp', operator_id: { open_id: 'ou_op' } }),
    ).toEqual({ chatId: 'oc_grp', eventId: '' })
  })

  test('returns null when chat_id is missing', () => {
    expect(normalizeBotAddedEvent({ header: { event_id: 'x' }, event: {} })).toBeNull()
    expect(normalizeBotAddedEvent('nonsense')).toBeNull()
  })
})

describe('createBotMemberHandler', () => {
  test('subscribes to the bot-added event type', () => {
    expect(createBotMemberHandler().eventType).toBe(BOT_MEMBER_ADDED_EVENT_TYPE)
  })

  test('marks the chat as needing a baseline on the next mention, and never notifies', async () => {
    const handler = createBotMemberHandler()
    const delivery = await handler.handle(botAddedEvent('oc_grp'), makeCtx(new FakeTransport('ou_self')))

    expect(delivery).toBeNull()
    expect(readChatBots(dir, 'cli_test_app', 'oc_grp').needsBaselineOnNextMention).toBe(true)
  })

  test('a redelivered event id is processed only once (idempotent)', async () => {
    const handler = createBotMemberHandler()
    const ctx = makeCtx(new FakeTransport('ou_self'))

    await handler.handle(botAddedEvent('oc_grp', 'evt_dup'), ctx)
    const seenAfterFirst = readChatBots(dir, 'cli_test_app', 'oc_grp').seenEventIds
    await handler.handle(botAddedEvent('oc_grp', 'evt_dup'), ctx)
    const seenAfterSecond = readChatBots(dir, 'cli_test_app', 'oc_grp').seenEventIds

    expect(seenAfterFirst).toEqual(['evt_dup'])
    expect(seenAfterSecond).toEqual(['evt_dup'])
  })

  test('a malformed payload is dropped, not thrown', async () => {
    const handler = createBotMemberHandler()
    expect(await handler.handle('not an event', makeCtx(new FakeTransport()))).toBeNull()
  })
})
