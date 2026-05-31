import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import {
  accessFile,
  botIdentityFile,
  chatBotsFile,
  daemonInboundQueueFile,
  daemonLockFile,
  daemonSocketFile,
  envFile,
  lockFile,
  stateDir,
} from '../src/paths'

describe('paths', () => {
  const base = '/tmp/feishu-test-state'

  test('stateDir ends at the channel directory', () => {
    expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
  })

  test('builders compose onto an explicit base', () => {
    expect(accessFile(base)).toBe(join(base, 'access.json'))
    expect(envFile(base)).toBe(join(base, '.env'))
    expect(lockFile(base)).toBe(join(base, 'connection.lock'))
    expect(daemonSocketFile(base)).toBe(join(base, 'daemon.sock'))
    expect(daemonLockFile(base)).toBe(join(base, 'daemon.lock'))
    expect(daemonInboundQueueFile(base)).toBe(join(base, 'daemon-inbound-queue.json'))
  })

  test('every state file sits inside the state directory', () => {
    expect(accessFile(base).startsWith(base + '/')).toBe(true)
    expect(envFile(base).startsWith(base + '/')).toBe(true)
    expect(lockFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonSocketFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonLockFile(base).startsWith(base + '/')).toBe(true)
    expect(daemonInboundQueueFile(base).startsWith(base + '/')).toBe(true)
  })

  test('stateDir can be overridden for a spawned daemon process', () => {
    const previous = process.env.FEISHU_CHANNEL_STATE_DIR
    process.env.FEISHU_CHANNEL_STATE_DIR = base
    try {
      expect(stateDir()).toBe(base)
      expect(stateDir('/home/u')).toBe('/home/u/.claude/channels/feishu')
    } finally {
      if (previous === undefined) {
        delete process.env.FEISHU_CHANNEL_STATE_DIR
      } else {
        process.env.FEISHU_CHANNEL_STATE_DIR = previous
      }
    }
  })

  describe('botIdentityFile', () => {
    test('embeds appId in the file name and is keyed per app only', () => {
      expect(botIdentityFile(base, 'cli_app')).toBe(join(base, 'feishu-bot-identity-cli_app.json'))
    })

    test('sits inside the base directory', () => {
      expect(botIdentityFile(base, 'a').startsWith(base + '/')).toBe(true)
    })
  })

  describe('chatBotsFile', () => {
    test('embeds appId and chatId in the file name', () => {
      const p = chatBotsFile(base, 'cli_app', 'oc_chat')
      expect(p).toBe(join(base, 'feishu-chat-bots-cli_app-oc_chat.json'))
    })

    test('sits inside the base directory', () => {
      expect(chatBotsFile(base, 'a', 'b').startsWith(base + '/')).toBe(true)
    })
  })
})
