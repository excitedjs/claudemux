/**
 * Per-(appId, chatId) record of which bots are in a chat and how far the
 * one-shot discovery injection has progressed for it.
 *
 * It answers "who is in this chat, and what have we already told the model
 * about them?". Identity (open_id → name) is app-wide and lives in
 * `./identity-store`; this store holds only the per-chat membership and the
 * injection bookkeeping.
 *
 * Two membership sets are kept on purpose:
 *  - `openIds`           — every bot discovered in this chat, by any means
 *                          (passive auto-observe included). Feeds discovery:
 *                          the baseline/delta context and the MCP query tool.
 *  - `introducedOpenIds` — only bots authorized via `/introduce` (human or the
 *                          ambient self-introduce). Feeds the access gate, so
 *                          passive observation never widens who may talk to the
 *                          session — it only widens what the model can see.
 *
 * Atomic writes via unique tmp + rename (pid + randomUUID): a fixed `.tmp`
 * suffix would race between concurrent writers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { chatBotsFile } from './paths'

/** Upper bound on retained `seenEventIds` so the file cannot grow without end. */
const MAX_SEEN_EVENT_IDS = 200

/** The persisted per-chat state. */
export interface ChatBotsState {
  /** Every bot open_id discovered in this chat (auto-observe + introduce). */
  openIds: string[]
  /** Bots authorized via `/introduce` in this chat — the gate's trust set. */
  introducedOpenIds: string[]
  /** When the one-shot baseline was injected for this chat; `null` until then. */
  baselineInjectedAt: number | null
  /** Set when this bot joined the chat; consumed by the next delivered mention. */
  needsBaselineOnNextMention: boolean
  /** Bots discovered after the baseline, awaiting an incremental injection. */
  pendingNewBots: string[]
  /** Recently handled member-event ids, for idempotent event processing. */
  seenEventIds: string[]
}

function emptyState(): ChatBotsState {
  return {
    openIds: [],
    introducedOpenIds: [],
    baselineInjectedAt: null,
    needsBaselineOnNextMention: false,
    pendingNewBots: [],
    seenEventIds: [],
  }
}

/** Read the per-chat state, returning a fresh default for a missing/corrupt file. */
export function readChatBots(baseDir: string, appId: string, chatId: string): ChatBotsState {
  const fp = chatBotsFile(baseDir, appId, chatId)
  if (!existsSync(fp)) return emptyState()
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as Partial<ChatBotsState>
      return {
        openIds: Array.isArray(p.openIds) ? p.openIds : [],
        introducedOpenIds: Array.isArray(p.introducedOpenIds) ? p.introducedOpenIds : [],
        baselineInjectedAt: typeof p.baselineInjectedAt === 'number' ? p.baselineInjectedAt : null,
        needsBaselineOnNextMention: p.needsBaselineOnNextMention === true,
        pendingNewBots: Array.isArray(p.pendingNewBots) ? p.pendingNewBots : [],
        seenEventIds: Array.isArray(p.seenEventIds) ? p.seenEventIds : [],
      }
    }
  } catch {
    // corrupt — fall through to default
  }
  return emptyState()
}

function write(baseDir: string, appId: string, chatId: string, state: ChatBotsState): void {
  if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
  const fp = chatBotsFile(baseDir, appId, chatId)
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  renameSync(tmp, fp)
}

/** Read, mutate, and atomically write back the state. */
function update(
  baseDir: string,
  appId: string,
  chatId: string,
  mutate: (state: ChatBotsState) => void,
): ChatBotsState {
  const state = readChatBots(baseDir, appId, chatId)
  mutate(state)
  write(baseDir, appId, chatId, state)
  return state
}

/**
 * Record a bot as present in this chat. `introduced` adds it to the gate's
 * trust set as well (default false: passive observation must not authorize).
 * Returns `{ wasNew: true }` the first time the open_id appears in `openIds`.
 */
export function recordChatMember(
  baseDir: string,
  appId: string,
  chatId: string,
  openId: string,
  opts: { introduced?: boolean } = {},
): { wasNew: boolean } {
  let wasNew = false
  update(baseDir, appId, chatId, (s) => {
    if (!s.openIds.includes(openId)) {
      s.openIds.push(openId)
      wasNew = true
    }
    if (opts.introduced && !s.introducedOpenIds.includes(openId)) {
      s.introducedOpenIds.push(openId)
    }
  })
  return { wasNew }
}

/** Queue a newly discovered bot for the next incremental injection. */
export function enqueuePendingNewBot(
  baseDir: string,
  appId: string,
  chatId: string,
  openId: string,
): void {
  update(baseDir, appId, chatId, (s) => {
    if (!s.pendingNewBots.includes(openId)) s.pendingNewBots.push(openId)
  })
}

/** Drop the given open_ids from the pending queue (after a successful inject). */
export function clearPendingNewBots(
  baseDir: string,
  appId: string,
  chatId: string,
  openIds: readonly string[],
): void {
  const drop = new Set(openIds)
  update(baseDir, appId, chatId, (s) => {
    s.pendingNewBots = s.pendingNewBots.filter((id) => !drop.has(id))
  })
}

/** Flag that this bot just joined the chat, so the next mention carries a baseline. */
export function markNeedsBaseline(baseDir: string, appId: string, chatId: string): void {
  update(baseDir, appId, chatId, (s) => {
    s.needsBaselineOnNextMention = true
  })
}

/** Stamp the baseline as injected and clear the pending-baseline flag. */
export function commitBaselineInjected(
  baseDir: string,
  appId: string,
  chatId: string,
  now: number,
): void {
  update(baseDir, appId, chatId, (s) => {
    s.baselineInjectedAt = now
    s.needsBaselineOnNextMention = false
  })
}

/**
 * Record a member-event id, returning `{ wasNew: true }` the first time it is
 * seen. Retains only the most recent {@link MAX_SEEN_EVENT_IDS} ids.
 */
export function recordSeenEvent(
  baseDir: string,
  appId: string,
  chatId: string,
  eventId: string,
): { wasNew: boolean } {
  let wasNew = false
  update(baseDir, appId, chatId, (s) => {
    if (s.seenEventIds.includes(eventId)) return
    wasNew = true
    s.seenEventIds.push(eventId)
    if (s.seenEventIds.length > MAX_SEEN_EVENT_IDS) {
      s.seenEventIds = s.seenEventIds.slice(s.seenEventIds.length - MAX_SEEN_EVENT_IDS)
    }
  })
  return { wasNew }
}
