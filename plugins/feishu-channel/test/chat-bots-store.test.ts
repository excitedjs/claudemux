import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPendingNewBots,
  commitBaselineInjected,
  enqueuePendingNewBot,
  markNeedsBaseline,
  readChatBots,
  recordChatMember,
  recordSeenEvent,
} from '../src/chat-bots-store'

const APP = 'cli_app_a'
const CHAT = 'oc_chat_1'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-chatbots-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readChatBots', () => {
  test('returns an empty default state when no file exists', () => {
    expect(readChatBots(dir, APP, CHAT)).toEqual({
      openIds: [],
      introducedOpenIds: [],
      baselineInjectedAt: null,
      needsBaselineOnNextMention: false,
      pendingNewBots: [],
      seenEventIds: [],
    })
  })

  test('tolerates a corrupt file as the default state', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `feishu-chat-bots-${APP}-${CHAT}.json`), 'nope', 'utf-8')
    expect(readChatBots(dir, APP, CHAT).openIds).toEqual([])
  })

  test('is isolated per (appId, chatId)', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b')
    expect(readChatBots(dir, APP, 'oc_other').openIds).toEqual([])
    expect(readChatBots(dir, 'cli_other', CHAT).openIds).toEqual([])
  })
})

describe('recordChatMember', () => {
  test('adds an open_id and reports it was new', () => {
    expect(recordChatMember(dir, APP, CHAT, 'ou_b')).toEqual({ wasNew: true })
    expect(readChatBots(dir, APP, CHAT).openIds).toEqual(['ou_b'])
  })

  test('re-adding the same open_id reports not new and does not duplicate', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b')
    expect(recordChatMember(dir, APP, CHAT, 'ou_b')).toEqual({ wasNew: false })
    expect(readChatBots(dir, APP, CHAT).openIds).toEqual(['ou_b'])
  })

  test('introduced=true also records the open_id in introducedOpenIds', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b', { introduced: true })
    const s = readChatBots(dir, APP, CHAT)
    expect(s.openIds).toEqual(['ou_b'])
    expect(s.introducedOpenIds).toEqual(['ou_b'])
  })

  test('introduced defaults to false — auto-observe does not authorize the gate', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b')
    expect(readChatBots(dir, APP, CHAT).introducedOpenIds).toEqual([])
  })

  test('a later introduced=true promotes an already-observed member', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b')
    recordChatMember(dir, APP, CHAT, 'ou_b', { introduced: true })
    expect(readChatBots(dir, APP, CHAT).introducedOpenIds).toEqual(['ou_b'])
  })
})

describe('pending new bots', () => {
  test('enqueue then clear', () => {
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_b')
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_c')
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_b', 'ou_c'])

    clearPendingNewBots(dir, APP, CHAT, ['ou_b'])
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_c'])
  })

  test('enqueue does not duplicate an open_id already pending', () => {
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_b')
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_b')
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_b'])
  })
})

describe('baseline state', () => {
  test('markNeedsBaseline sets the flag', () => {
    markNeedsBaseline(dir, APP, CHAT)
    expect(readChatBots(dir, APP, CHAT).needsBaselineOnNextMention).toBe(true)
  })

  test('commitBaselineInjected stamps the time and clears the flag', () => {
    markNeedsBaseline(dir, APP, CHAT)
    commitBaselineInjected(dir, APP, CHAT, 1234)
    const s = readChatBots(dir, APP, CHAT)
    expect(s.baselineInjectedAt).toBe(1234)
    expect(s.needsBaselineOnNextMention).toBe(false)
  })
})

describe('recordSeenEvent', () => {
  test('reports a new event id the first time and a duplicate after', () => {
    expect(recordSeenEvent(dir, APP, CHAT, 'evt_1')).toEqual({ wasNew: true })
    expect(recordSeenEvent(dir, APP, CHAT, 'evt_1')).toEqual({ wasNew: false })
  })

  test('caps the retained event ids so the file does not grow unbounded', () => {
    for (let i = 0; i < 250; i++) recordSeenEvent(dir, APP, CHAT, `evt_${i}`)
    const seen = readChatBots(dir, APP, CHAT).seenEventIds
    expect(seen.length).toBeLessThanOrEqual(200)
    // The most recent id is retained; the oldest is evicted.
    expect(seen).toContain('evt_249')
    expect(seen).not.toContain('evt_0')
  })
})
