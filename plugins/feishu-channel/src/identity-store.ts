/**
 * App-scoped identity map: `open_id → who that bot is`.
 *
 * Feishu `open_id` is scoped per application, not per chat — within one app a
 * given bot's open_id is the same in every group it shares with this app, and
 * only changes if the Feishu app itself changes. So the "which open_id is which
 * bot" mapping is stored once per `appId` and reused across every chat this
 * channel serves, rather than duplicated per chat.
 *
 * This store answers "who is open_id X?". Which bots are in which chat — and
 * the per-chat injection bookkeeping — lives in `./chat-bots-store`.
 *
 * Atomic writes via unique tmp + rename (pid + randomUUID): a fixed `.tmp`
 * suffix would race between concurrent writers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { botIdentityFile } from './paths'

/** How a bot's identity first became known. `/introduce` is an explicit, */
/** human- or bot-driven handshake; `observed` is passive auto-discovery. */
export type BotIdentitySource = 'introduce' | 'observed'

/** One bot's app-wide identity. */
export interface BotIdentity {
  openId: string
  name: string
  source: BotIdentitySource
  firstSeenAt: number
  lastSeenAt: number
  /** chat_id where this bot was first seen — a breadcrumb, not a scope. */
  firstSeenChat: string
}

type FileEntry = Omit<BotIdentity, 'openId'>
type FileShape = Record<string, FileEntry>

function readFile(baseDir: string, appId: string): FileShape {
  const fp = botIdentityFile(baseDir, appId)
  if (!existsSync(fp)) return {}
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape
  } catch {
    // corrupt — fall through to empty
  }
  return {}
}

function writeFileAtomic(baseDir: string, appId: string, data: FileShape): void {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
  const fp = botIdentityFile(baseDir, appId)
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  renameSync(tmp, fp)
}

/**
 * Merge a batch of (openId, name) pairs into the app's identity map.
 *
 * - Existing open_ids: keep `firstSeenAt`, `firstSeenChat`, and `source`; bump
 *   `lastSeenAt` and refresh `name`. The first source wins so an explicit
 *   `/introduce` is not downgraded to `observed` by a later passive sighting.
 * - New open_ids: `firstSeenAt = lastSeenAt = now`, `firstSeenChat = chatId`.
 * - Entries with an empty openId or name are skipped.
 * - Empty / all-skipped input is a no-op (no file write).
 */
export function recordBotIdentity(
  baseDir: string,
  appId: string,
  chatId: string,
  bots: ReadonlyArray<{ openId: string; name: string }>,
  source: BotIdentitySource,
  now: number,
): void {
  const valid = bots.filter((b) => b.openId && b.name)
  if (valid.length === 0) return

  const data = readFile(baseDir, appId)
  for (const b of valid) {
    const prior = data[b.openId]
    if (prior) {
      data[b.openId] = { ...prior, name: b.name, lastSeenAt: now }
    } else {
      data[b.openId] = {
        name: b.name,
        source,
        firstSeenAt: now,
        lastSeenAt: now,
        firstSeenChat: chatId,
      }
    }
  }
  writeFileAtomic(baseDir, appId, data)
}

/** The identity for one open_id, or `undefined` when it is unknown. */
export function getBotIdentity(
  baseDir: string,
  appId: string,
  openId: string,
): BotIdentity | undefined {
  const entry = readFile(baseDir, appId)[openId]
  return entry ? { openId, ...entry } : undefined
}

/** Every known bot identity for this app. Order is unspecified. */
export function listBotIdentities(baseDir: string, appId: string): BotIdentity[] {
  return Object.entries(readFile(baseDir, appId)).map(([openId, entry]) => ({ openId, ...entry }))
}
