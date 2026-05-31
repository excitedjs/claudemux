import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBotIdentity, listBotIdentities, recordBotIdentity } from '../src/identity-store'

const APP = 'cli_app_a'
const CHAT = 'oc_chat_1'
const NOW = 1_700_000_000_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-identity-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recordBotIdentity', () => {
  test('persists a bot and getBotIdentity returns it', () => {
    recordBotIdentity(dir, APP, CHAT, [{ openId: 'ou_b', name: 'BotB' }], 'observed', NOW)
    expect(getBotIdentity(dir, APP, 'ou_b')).toMatchObject({
      openId: 'ou_b',
      name: 'BotB',
      source: 'observed',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      firstSeenChat: CHAT,
    })
  })

  test('skips entries with empty openId or name', () => {
    recordBotIdentity(dir, APP, CHAT, [
      { openId: '', name: 'X' },
      { openId: 'ou_y', name: '' },
    ], 'observed', NOW)
    expect(listBotIdentities(dir, APP)).toHaveLength(0)
  })

  test('on re-record bumps lastSeenAt and name but keeps firstSeenAt, firstSeenChat, source', () => {
    recordBotIdentity(dir, APP, 'oc_first', [{ openId: 'ou_b', name: 'Old' }], 'introduce', NOW)
    recordBotIdentity(dir, APP, 'oc_second', [{ openId: 'ou_b', name: 'New' }], 'observed', NOW + 1000)

    const entry = getBotIdentity(dir, APP, 'ou_b')
    expect(entry).toMatchObject({
      name: 'New',
      source: 'introduce',
      firstSeenAt: NOW,
      lastSeenAt: NOW + 1000,
      firstSeenChat: 'oc_first',
    })
  })

  test('is keyed per appId — another app does not see it', () => {
    recordBotIdentity(dir, 'app_a', CHAT, [{ openId: 'ou_b', name: 'B' }], 'observed', NOW)
    expect(getBotIdentity(dir, 'app_b', 'ou_b')).toBeUndefined()
  })

  test('is shared across chats within one app (cross-chat reuse)', () => {
    recordBotIdentity(dir, APP, 'oc_one', [{ openId: 'ou_b', name: 'B' }], 'observed', NOW)
    // Looked up without any chat scoping — identity is app-wide.
    expect(getBotIdentity(dir, APP, 'ou_b')?.name).toBe('B')
  })

  test('creates the baseDir when missing', () => {
    const nested = join(dir, 'a', 'b')
    recordBotIdentity(nested, APP, CHAT, [{ openId: 'ou_b', name: 'B' }], 'observed', NOW)
    expect(getBotIdentity(nested, APP, 'ou_b')?.name).toBe('B')
  })
})

describe('getBotIdentity / listBotIdentities', () => {
  test('getBotIdentity returns undefined for an unknown open_id', () => {
    expect(getBotIdentity(dir, APP, 'ou_missing')).toBeUndefined()
  })

  test('tolerates a corrupt file as empty', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `feishu-bot-identity-${APP}.json`), '{bad', 'utf-8')
    expect(listBotIdentities(dir, APP)).toHaveLength(0)
  })
})
