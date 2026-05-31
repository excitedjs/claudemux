import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDiscoveryContext, observeBotSender } from '../src/bot-discovery'
import { getBotIdentity } from '../src/identity-store'
import {
  enqueuePendingNewBot,
  markNeedsBaseline,
  readChatBots,
  recordChatMember,
} from '../src/chat-bots-store'
import { recordBotIdentity } from '../src/identity-store'

const APP = 'cli_app_a'
const CHAT = 'oc_chat_1'
const SELF = 'ou_self'
const NOW = 1_700_000_000_000

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-discovery-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('observeBotSender', () => {
  test('records a bot sender into identity + membership and enqueues it as new', () => {
    observeBotSender(dir, APP, CHAT, {
      senderType: 'bot',
      senderOpenId: 'ou_b',
      senderName: 'BotB',
      botOpenId: SELF,
      now: NOW,
    })
    expect(getBotIdentity(dir, APP, 'ou_b')).toMatchObject({ name: 'BotB', source: 'observed' })
    const s = readChatBots(dir, APP, CHAT)
    expect(s.openIds).toEqual(['ou_b'])
    expect(s.pendingNewBots).toEqual(['ou_b'])
    // Auto-observe must not authorize the gate.
    expect(s.introducedOpenIds).toEqual([])
  })

  test('ignores a human sender', () => {
    observeBotSender(dir, APP, CHAT, {
      senderType: 'user',
      senderOpenId: 'ou_human',
      senderName: 'Alice',
      botOpenId: SELF,
      now: NOW,
    })
    expect(readChatBots(dir, APP, CHAT).openIds).toEqual([])
  })

  test('ignores the bot itself', () => {
    observeBotSender(dir, APP, CHAT, {
      senderType: 'bot',
      senderOpenId: SELF,
      senderName: 'Me',
      botOpenId: SELF,
      now: NOW,
    })
    expect(readChatBots(dir, APP, CHAT).openIds).toEqual([])
  })

  test('a repeat sighting refreshes lastSeen but does not re-enqueue pending', () => {
    observeBotSender(dir, APP, CHAT, { senderType: 'bot', senderOpenId: 'ou_b', senderName: 'B', botOpenId: SELF, now: NOW })
    // Simulate the first pending having been consumed.
    readChatBots(dir, APP, CHAT)
    observeBotSender(dir, APP, CHAT, { senderType: 'bot', senderOpenId: 'ou_b', senderName: 'B', botOpenId: SELF, now: NOW + 5 })
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_b'])
    expect(getBotIdentity(dir, APP, 'ou_b')?.lastSeenAt).toBe(NOW + 5)
  })

  test('falls back to the open_id as name when the sender name is empty', () => {
    observeBotSender(dir, APP, CHAT, { senderType: 'bot', senderOpenId: 'ou_b', senderName: '', botOpenId: SELF, now: NOW })
    expect(getBotIdentity(dir, APP, 'ou_b')?.name).toBe('ou_b')
  })
})

describe('buildDiscoveryContext — sender line', () => {
  test('prepends a sender line for a bot sender, using the known identity name', () => {
    recordBotIdentity(dir, APP, CHAT, [{ openId: 'ou_b', name: 'BotB' }], 'introduce', NOW)
    const { prefix } = buildDiscoveryContext(dir, APP, CHAT, {
      botOpenId: SELF,
      senderType: 'bot',
      senderOpenId: 'ou_b',
      now: NOW,
    })
    expect(prefix).toContain('ou_b')
    expect(prefix).toContain('BotB')
  })

  test('adds no sender line for a human sender', () => {
    const { prefix } = buildDiscoveryContext(dir, APP, CHAT, {
      botOpenId: SELF,
      senderType: 'user',
      senderOpenId: 'ou_human',
      now: NOW,
    })
    expect(prefix).toBe('')
  })
})

describe('buildDiscoveryContext — baseline', () => {
  test('shows a baseline listing peers (excluding self) when one is pending, and commit stamps it', () => {
    recordBotIdentity(dir, APP, CHAT, [{ openId: 'ou_b', name: 'BotB' }], 'observed', NOW)
    recordChatMember(dir, APP, CHAT, 'ou_b')
    recordChatMember(dir, APP, CHAT, SELF)
    markNeedsBaseline(dir, APP, CHAT)

    const { prefix, commit } = buildDiscoveryContext(dir, APP, CHAT, {
      botOpenId: SELF,
      senderType: 'user',
      senderOpenId: 'ou_human',
      now: NOW,
    })
    expect(prefix).toContain('ou_b')
    expect(prefix).toContain('BotB')
    expect(prefix).not.toContain(SELF)

    // Not committed yet: baseline still pending.
    expect(readChatBots(dir, APP, CHAT).baselineInjectedAt).toBeNull()
    commit()
    const s = readChatBots(dir, APP, CHAT)
    expect(s.baselineInjectedAt).toBe(NOW)
    expect(s.needsBaselineOnNextMention).toBe(false)
  })

  test('shows an explicit empty-baseline note when no peers are known yet', () => {
    markNeedsBaseline(dir, APP, CHAT)
    const { prefix } = buildDiscoveryContext(dir, APP, CHAT, {
      botOpenId: SELF,
      senderType: 'user',
      senderOpenId: 'ou_human',
      now: NOW,
    })
    expect(prefix).toMatch(/暂未发现|no other bot/i)
  })

  test('does not repeat the baseline once it has been injected', () => {
    recordChatMember(dir, APP, CHAT, 'ou_b')
    markNeedsBaseline(dir, APP, CHAT)
    const first = buildDiscoveryContext(dir, APP, CHAT, { botOpenId: SELF, senderType: 'user', senderOpenId: 'ou_human', now: NOW })
    first.commit()
    const second = buildDiscoveryContext(dir, APP, CHAT, { botOpenId: SELF, senderType: 'user', senderOpenId: 'ou_human', now: NOW + 1 })
    expect(second.prefix).toBe('')
  })
})

describe('buildDiscoveryContext — incremental delta', () => {
  test('shows pending new bots when the baseline is already injected, and commit clears them', () => {
    recordBotIdentity(dir, APP, CHAT, [{ openId: 'ou_c', name: 'NewBot' }], 'observed', NOW)
    recordChatMember(dir, APP, CHAT, 'ou_c')
    // Baseline already done previously.
    markNeedsBaseline(dir, APP, CHAT)
    buildDiscoveryContext(dir, APP, CHAT, { botOpenId: SELF, senderType: 'user', senderOpenId: 'ou_human', now: NOW }).commit()
    // Now a new bot shows up.
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_c')

    const { prefix, commit } = buildDiscoveryContext(dir, APP, CHAT, {
      botOpenId: SELF,
      senderType: 'user',
      senderOpenId: 'ou_human',
      now: NOW + 100,
    })
    expect(prefix).toContain('ou_c')
    expect(prefix).toContain('NewBot')

    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_c'])
    commit()
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual([])
  })

  test('without commit, pending is preserved (delivery-failure safety)', () => {
    // Get the baseline out of the way first so the delta path is taken.
    markNeedsBaseline(dir, APP, CHAT)
    buildDiscoveryContext(dir, APP, CHAT, { botOpenId: SELF, senderType: 'user', senderOpenId: 'ou_human', now: NOW }).commit()

    // A fresh bot shows up after the baseline.
    recordBotIdentity(dir, APP, CHAT, [{ openId: 'ou_c', name: 'C' }], 'observed', NOW + 1)
    recordChatMember(dir, APP, CHAT, 'ou_c')
    enqueuePendingNewBot(dir, APP, CHAT, 'ou_c')

    const { prefix } = buildDiscoveryContext(dir, APP, CHAT, { botOpenId: SELF, senderType: 'user', senderOpenId: 'ou_human', now: NOW + 2 })
    expect(prefix).toContain('ou_c')
    // Built but never committed → still pending, so a failed delivery can retry.
    expect(readChatBots(dir, APP, CHAT).pendingNewBots).toEqual(['ou_c'])
  })
})
