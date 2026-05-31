import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccess } from '../src/access-store'
import { DOC_COMMENT_EVENT_TYPE } from '../src/handlers/doc-comment'
import { IM_MESSAGE_EVENT_TYPE } from '../src/handlers/im-message'
import {
  createChannelCore,
  loadCredentials,
  readEnvFile,
  RECEIVED_REACTION_EMOJIS,
} from '../src/server'
import type { Access } from '../src/types'
import { BOT_MEMBER_ADDED_EVENT_TYPE } from '../src/handlers/bot-member'
import {
  commitBaselineInjected,
  markNeedsBaseline,
  readChatBots,
  recordChatMember,
} from '../src/chat-bots-store'
import { recordBotIdentity } from '../src/identity-store'
import { FakeTransport } from './support/fake-transport'

const NOW = 1_700_000_000_000

interface Note {
  content: string
  meta: Record<string, string>
}

let dir: string
let accessFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-server-'))
  accessFile = join(dir, 'access.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Build a channel core wired to fakes, capturing every notification in `notes`. */
function makeCore(
  transport: FakeTransport,
  notes: Note[],
  logErrors: string[] = [],
  notify?: (content: string, meta: Record<string, string>) => void,
) {
  return createChannelCore({
    transport,
    accessFile,
    baseDir: dir,
    notify:
      notify ??
      ((content, meta) => {
        notes.push({ content, meta })
      }),
    now: () => NOW,
    generateCode: () => 'abc123',
    logError: (message) => {
      logErrors.push(message)
    },
  })
}

/** A raw `im.message.receive_v1` event body with a given message_id and chat_id. */
function rawIm(messageId: string, chatId: string): Record<string, unknown> {
  return {
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello there"}',
      mentions: [],
    },
  }
}

/** A raw `im.message.receive_v1` event body from a fixed test sender. */
function rawImEvent(): Record<string, unknown> {
  return rawIm('om_msg', 'oc_chat')
}

function writeAccess(overrides: Partial<Access>): void {
  saveAccess(accessFile, {
    dmPolicy: 'pairing',
    groupPolicy: 'allowlist',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  })
}

describe('createChannelCore — event registry wiring', () => {
  test('exposes a route for every registered event type', () => {
    const core = makeCore(new FakeTransport(), [])
    expect(Object.keys(core.routes)).toContain(IM_MESSAGE_EVENT_TYPE)
  })

  test('a route callback dispatches through the matching handler', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport(), notes)

    await core.routes[IM_MESSAGE_EVENT_TYPE]?.(rawImEvent())

    expect(notes).toHaveLength(1)
    expect(notes[0]?.content).toBe('hello there')
    expect(notes[0]?.meta.kind).toBe('message')
    expect(notes[0]?.meta.chat_id).toBe('oc_chat')
  })
})

describe('handleEvent — dispatch', () => {
  test('delivers an im.message event through its handler', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport(), notes)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.message_id).toBe('om_msg')
  })

  test('an unregistered event type is a silent no-op', async () => {
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), notes, logErrors)

    await core.handleEvent('drive.file.read_v1', { anything: true })

    expect(notes).toHaveLength(0)
    expect(logErrors).toHaveLength(0)
  })

  test('a notifier that throws is caught — handleEvent never rejects', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), [], logErrors, () => {
      throw new Error('notify blew up')
    })

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(logErrors.some((m) => m.includes('deliver'))).toBe(true)
  })

  test('a malformed payload for a known event type is dropped, not thrown', async () => {
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), notes, logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, 'not an event')

    expect(notes).toHaveLength(0)
  })
})

describe('tools', () => {
  test('exposes reply, react, edit_message, and feishu_list_chat_bots', () => {
    const core = makeCore(new FakeTransport(), [])
    expect(core.tools.map((t) => t.name).sort()).toEqual([
      'edit_message',
      'feishu_list_chat_bots',
      'react',
      'reply',
    ])
  })
})

describe('handleTool — feishu_list_chat_bots', () => {
  test('returns the known peer bots in a chat, excluding self by default', async () => {
    const transport = new FakeTransport('ou_self')
    recordBotIdentity(dir, transport.appId, 'oc_grp', [{ openId: 'ou_b', name: 'BotB' }], 'introduce', NOW)
    recordChatMember(dir, transport.appId, 'oc_grp', 'ou_b')
    recordChatMember(dir, transport.appId, 'oc_grp', 'ou_self')
    const core = makeCore(transport, [])

    const result = await core.handleTool('feishu_list_chat_bots', { chat_id: 'oc_grp' })

    expect(result.isError).toBeUndefined()
    const text = JSON.stringify(result.content)
    expect(text).toContain('ou_b')
    expect(text).toContain('BotB')
    expect(text).not.toContain('ou_self')
  })

  test('include_self=true includes the bot itself', async () => {
    const transport = new FakeTransport('ou_self')
    recordBotIdentity(dir, transport.appId, 'oc_grp', [{ openId: 'ou_self', name: 'Me' }], 'observed', NOW)
    recordChatMember(dir, transport.appId, 'oc_grp', 'ou_self')
    const core = makeCore(transport, [])

    const result = await core.handleTool('feishu_list_chat_bots', {
      chat_id: 'oc_grp',
      include_self: true,
    })

    expect(JSON.stringify(result.content)).toContain('ou_self')
  })

  test('an unknown chat returns an empty list, not an error', async () => {
    const core = makeCore(new FakeTransport('ou_self'), [])
    const result = await core.handleTool('feishu_list_chat_bots', { chat_id: 'oc_none' })
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('[]')
  })

  test('a missing chat_id is an error result, not a throw', async () => {
    const core = makeCore(new FakeTransport('ou_self'), [])
    const result = await core.handleTool('feishu_list_chat_bots', {})
    expect(result.isError).toBe(true)
  })
})

describe('bot-discovery commit runs only after a successful notify', () => {
  /** A group follow-user @-mention from an allowlisted human, with a baseline armed. */
  function groupMention(): Record<string, unknown> {
    return {
      sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
      message: {
        message_id: 'om_grp',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hello"}',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
      },
    }
  }

  test('a successful delivery commits the baseline as injected', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: ['ou_human'] })
    const transport = new FakeTransport('ou_self')
    markNeedsBaseline(dir, transport.appId, 'oc_grp')
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, groupMention())

    expect(readChatBots(dir, transport.appId, 'oc_grp').baselineInjectedAt).toBe(NOW)
  })

  test('a failed notify leaves the baseline un-injected, to retry next time', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: ['ou_human'] })
    const transport = new FakeTransport('ou_self')
    markNeedsBaseline(dir, transport.appId, 'oc_grp')
    const core = makeCore(transport, [], [], () => {
      throw new Error('notify failed')
    })

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, groupMention())

    expect(readChatBots(dir, transport.appId, 'oc_grp').baselineInjectedAt).toBeNull()
    expect(readChatBots(dir, transport.appId, 'oc_grp').needsBaselineOnNextMention).toBe(true)
  })
})

describe('/introduce backfill after baseline → incremental delta', () => {
  function introduceByHuman(): Record<string, unknown> {
    return {
      sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
      message: {
        message_id: 'om_intro',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 @_user_2 /introduce' }),
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_self' }, name: 'Me' },
          { key: '@_user_2', id: { open_id: 'ou_peer' }, name: 'PeerBot' },
        ],
      },
    }
  }
  function mentionByHuman(messageId: string): Record<string, unknown> {
    return {
      sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"anything"}',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
      },
    }
  }

  test('a bot introduced after the baseline is delivered as a delta on the next mention, then cleared', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: ['ou_human'] })
    const transport = new FakeTransport('ou_self')
    commitBaselineInjected(dir, transport.appId, 'oc_grp', NOW) // baseline already injected
    const notes: Note[] = []
    const core = makeCore(transport, notes)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, introduceByHuman())
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, mentionByHuman('om_next'))

    const delta = notes.find((n) => n.meta.message_id === 'om_next')
    expect(delta?.content).toContain('ou_peer')
    expect(delta?.content).toContain('PeerBot')
    // notify succeeded → pending cleared.
    expect(readChatBots(dir, transport.appId, 'oc_grp').pendingNewBots).not.toContain('ou_peer')
  })

  test('a failed notify keeps the introduced bot pending for the next mention', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: ['ou_human'] })
    const transport = new FakeTransport('ou_self')
    commitBaselineInjected(dir, transport.appId, 'oc_grp', NOW)
    const core = makeCore(transport, [], [], () => {
      throw new Error('notify failed')
    })

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, introduceByHuman())
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, mentionByHuman('om_next'))

    expect(readChatBots(dir, transport.appId, 'oc_grp').pendingNewBots).toContain('ou_peer')
  })
})

describe('event registry — bot-added route', () => {
  test('exposes a route for the bot-added event type', () => {
    const core = makeCore(new FakeTransport(), [])
    expect(Object.keys(core.routes)).toContain(BOT_MEMBER_ADDED_EVENT_TYPE)
  })
})

describe('handleTool — reply', () => {
  test('sends the text and reports success', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'hi back' })

    expect(result.isError).toBeUndefined()
    expect(transport.sent).toEqual([{ chatId: 'oc_chat', text: 'hi back' }])
  })

  test('a missing argument yields an error result, not a throw', async () => {
    const core = makeCore(new FakeTransport(), [])
    const result = await core.handleTool('reply', { chat_id: 'oc_chat' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('text')
  })

  test('a transport failure becomes an error result, not a throw', async () => {
    const transport = new FakeTransport()
    transport.failOn = 'sendText'
    const core = makeCore(transport, [])

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'hi' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('feishu send failed')
  })
})

describe('handleTool — reply splitting', () => {
  test('a reply that fits one card is sent as a single message', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'short enough' })

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toBe('short enough')
    expect(JSON.stringify(result.content)).toContain('as om_sent_0')
  })

  test('a reply too large for one card surfaces an N-messages summary', async () => {
    // The renderer splits a body that would exceed Feishu's ~30 KB request
    // cap into multiple cards; the fake transport returns one message_id per
    // card the renderer produced, and the `reply` summary reports the count.
    const transport = new FakeTransport()
    const core = makeCore(transport, [])
    // 60 KB of fence-free text exceeds the ~28 KB per-card budget, so the
    // renderer produces at least two cards regardless of CJK/ASCII width.
    const long = 'x'.repeat(60_000)

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: long })

    expect(result.isError).toBeUndefined()
    // The server now calls the transport once with the full body; the
    // transport itself handles per-card splitting and returns the list of
    // message_ids.
    expect(transport.sent).toHaveLength(1)
    expect(JSON.stringify(result.content)).toMatch(/in [0-9]+ messages/)
  })
})

describe('handleTool — react and edit_message', () => {
  test('react adds the emoji to the message', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('react', { message_id: 'om_msg', emoji: 'THUMBSUP' })

    expect(result.isError).toBeUndefined()
    expect(transport.reactions).toEqual([{ messageId: 'om_msg', emoji: 'THUMBSUP' }])
  })

  test('edit_message replaces the message text', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('edit_message', {
      message_id: 'om_msg',
      text: 'revised',
    })

    expect(result.isError).toBeUndefined()
    expect(transport.edits).toEqual([{ messageId: 'om_msg', text: 'revised' }])
  })
})

describe('received-reaction indicator', () => {
  test('adds the received reaction once an inbound chat message is delivered', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(transport.reactions).toHaveLength(1)
    const reaction = transport.reactions[0]!
    expect(reaction.messageId).toBe('om_msg')
    expect(RECEIVED_REACTION_EMOJIS as readonly string[]).toContain(reaction.emoji)
  })

  test('a reply clears the received reaction for that chat', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(transport.reactionRemovals).toEqual([
      { messageId: 'om_msg', reactionId: 'rk_om_msg' },
    ])
  })

  test('a reply clears every message still pending in that chat', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_a', 'oc_chat'))
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_b', 'oc_chat'))
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered both' })

    expect(transport.reactionRemovals.map((r) => r.messageId).sort()).toEqual(['om_a', 'om_b'])
  })

  test('a reply leaves another chat’s pending reaction in place', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_a', 'oc_one'))
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_b', 'oc_two'))
    await core.handleTool('reply', { chat_id: 'oc_one', text: 'answered one' })

    expect(transport.reactionRemovals).toEqual([{ messageId: 'om_a', reactionId: 'rk_om_a' }])

    // The untouched chat still clears on its own reply.
    await core.handleTool('reply', { chat_id: 'oc_two', text: 'answered two' })
    expect(transport.reactionRemovals.map((r) => r.messageId)).toEqual(['om_a', 'om_b'])
  })

  test('a gated-out message gets no reaction', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(transport.reactions).toHaveLength(0)
  })

  test('a delivered doc comment gets no reaction — it is not an IM message', async () => {
    const transport = new FakeTransport()
    const notes: Note[] = []
    const core = makeCore(transport, notes)

    await core.handleEvent(DOC_COMMENT_EVENT_TYPE, {
      file_token: 'doccnAbC123',
      file_type: 'docx',
      comment_id: 'cmt_1',
      user_id: { open_id: 'ou_commenter' },
      is_mentioned: true,
      create_time: '1716200000000',
    })

    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.kind).toBe('doc_comment')
    expect(transport.reactions).toHaveLength(0)
  })

  test('a failed addReaction is logged and never blocks delivery', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    transport.failOn = 'addReaction'
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(transport, notes, logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(notes).toHaveLength(1)
    expect(logErrors.some((m) => m.includes('received reaction'))).toBe(true)
  })

  test('a failed removeReaction is logged, and the message is not retried later', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    transport.failOn = 'removeReaction'
    const logErrors: string[] = []
    const core = makeCore(transport, [], logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(result.isError).toBeUndefined()
    const removalErrors = (): number =>
      logErrors.filter((m) => m.includes('remove the received reaction')).length
    expect(removalErrors()).toBe(1)

    // The message was dropped from the pending set despite the failure, so a
    // later reply into the same chat does not retry the doomed removal — the
    // removal error count stays at one.
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'again' })
    expect(removalErrors()).toBe(1)
  })

  test('a reply that fails to send leaves the indicator in place', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    transport.failOn = 'sendText'
    const failed = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(failed.isError).toBe(true)
    expect(transport.reactionRemovals).toHaveLength(0)

    // The message is still pending — a later successful reply clears it.
    transport.failOn = undefined
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'retry' })
    expect(transport.reactionRemovals).toEqual([
      { messageId: 'om_msg', reactionId: 'rk_om_msg' },
    ])
  })
})

describe('handleTool — unknown tool', () => {
  test('an unknown tool name yields an error result', async () => {
    const core = makeCore(new FakeTransport(), [])
    const result = await core.handleTool('teleport', {})
    expect(result.isError).toBe(true)
  })
})

/** Restore an environment variable to a captured prior value. */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('readEnvFile', () => {
  test('a missing file yields an empty map', () => {
    expect(readEnvFile(join(dir, 'nope.env'))).toEqual({})
  })

  test('parses keys, strips surrounding quotes, and ignores noise lines', () => {
    const file = join(dir, '.env')
    writeFileSync(
      file,
      [
        '# a comment',
        '',
        'FEISHU_APP_ID=cli_plain',
        'FEISHU_APP_SECRET="quoted secret"',
        "OTHER='single quoted'",
        'this line is not a key=value assignment',
        '  SPACED  =  trimmed  ',
      ].join('\n'),
    )
    expect(readEnvFile(file)).toEqual({
      FEISHU_APP_ID: 'cli_plain',
      FEISHU_APP_SECRET: 'quoted secret',
      OTHER: 'single quoted',
      SPACED: 'trimmed',
    })
  })
})

describe('loadCredentials', () => {
  test('returns both credentials read from the env file', () => {
    const file = join(dir, '.env')
    writeFileSync(file, 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=secret_y\n')
    expect(loadCredentials(file)).toEqual({ appId: 'cli_x', appSecret: 'secret_y' })
  })

  test('throws a clear error when a credential is missing', () => {
    const savedSecret = process.env.FEISHU_APP_SECRET
    delete process.env.FEISHU_APP_SECRET
    const file = join(dir, '.env')
    writeFileSync(file, 'FEISHU_APP_ID=cli_x\n')
    try {
      expect(() => loadCredentials(file)).toThrow('Feishu credentials missing')
    } finally {
      restoreEnv('FEISHU_APP_SECRET', savedSecret)
    }
  })

  test('falls back to the process environment when the file is absent', () => {
    const savedId = process.env.FEISHU_APP_ID
    const savedSecret = process.env.FEISHU_APP_SECRET
    process.env.FEISHU_APP_ID = 'cli_env'
    process.env.FEISHU_APP_SECRET = 'secret_env'
    try {
      expect(loadCredentials(join(dir, 'absent.env'))).toEqual({
        appId: 'cli_env',
        appSecret: 'secret_env',
      })
    } finally {
      restoreEnv('FEISHU_APP_ID', savedId)
      restoreEnv('FEISHU_APP_SECRET', savedSecret)
    }
  })
})

