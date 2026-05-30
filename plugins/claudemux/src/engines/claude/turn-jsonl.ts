/**
 * JSONL turn-state reads for the Claude engine — the transcript-side
 * signals that back `tm send`'s submit confirmation and the no-hook wait
 * fallback. These mirror what `hooks/on-stop.sh` decides in bash
 * (terminal stop_reason + a text/tool_use block = a settled turn), but
 * run inside `tm` so a session whose Stop hook never fired still gets
 * JSONL-grade turn detection instead of a pane-quiet heuristic.
 *
 * Every read is anchored to a byte offset snapshotted at send time, so a
 * settled assistant entry from a PRIOR turn (which lives before the
 * offset) can never be mistaken for this turn's completion. Reads of the
 * appended region only; a file that shrank (compaction rewrote it) is
 * treated as "nothing new yet" rather than risking a false positive.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Terminal `stop_reason` values — the API call ended without expecting the agent loop to continue. */
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Byte size of the transcript, or 0 when it does not exist yet. */
export function transcriptSizeBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Read the bytes appended after `sinceBytes`. Returns `''` when the file
 * is missing, unreadable, or no larger than `sinceBytes` (including the
 * shrink-after-compaction case). Reading only the tail keeps every poll
 * O(one turn) rather than O(whole transcript).
 */
function readAppended(path: string, sinceBytes: number): string {
  let fd: number
  try {
    const size = statSync(path).size
    if (size <= sinceBytes) return ''
    fd = openSync(path, 'r')
    try {
      const len = size - sinceBytes
      const buf = Buffer.allocUnsafe(len)
      const read = readSync(fd, buf, 0, len, sinceBytes)
      return buf.toString('utf8', 0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Parse the complete JSONL lines in `text`; a trailing partial line (mid-write) is dropped. */
function parsedLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      // A half-written final line, or a non-JSON line — skip it. A real
      // entry reappears intact on the next poll.
      continue
    }
    if (isPlainObject(value)) out.push(value)
  }
  return out
}

/**
 * Whether any `type: "user"` entry appears in the region appended after
 * `sinceBytes`. Claude Code writes the submitted prompt as a user entry,
 * so a new user entry after the send offset is positive evidence the
 * input was accepted as a turn — the signal `tm send` uses to tell
 * "submitted" from "the Enter was swallowed by a modal". Slash-command
 * and tool_result entries are also `type: "user"`; counting them is
 * correct here — any of them proves the REPL took the input, which is
 * exactly the question submit-confirmation answers.
 */
export function userEntryAppearedAfter(path: string, sinceBytes: number): boolean {
  for (const entry of parsedLines(readAppended(path, sinceBytes))) {
    if (entry['type'] === 'user') return true
  }
  return false
}

/**
 * Whether the most recent assistant entry in the region appended after
 * `sinceBytes` is SETTLED — terminal `stop_reason` AND at least one
 * `text` or `tool_use` content block. This is `on-stop.sh`'s
 * `is_assistant_settled` predicate, scoped to this turn's appended
 * region:
 *
 *  - mid tool-loop → the last assistant entry's stop_reason is
 *    `tool_use` (non-terminal) → not settled → keep waiting;
 *  - a thinking-only response that ended with `end_turn` before the
 *    text response landed → no text/tool_use block → not settled →
 *    keep waiting (the split-turn case `on-stop.sh` guards against);
 *  - the final text/tool_use response with a terminal stop_reason →
 *    settled → the turn is over.
 */
export function terminalAssistantAfter(path: string, sinceBytes: number): boolean {
  let lastAssistantSettled = false
  let sawAssistant = false
  for (const entry of parsedLines(readAppended(path, sinceBytes))) {
    if (entry['type'] !== 'assistant') continue
    sawAssistant = true
    const message = entry['message']
    if (!isPlainObject(message)) {
      lastAssistantSettled = false
      continue
    }
    const reason = message['stop_reason']
    const content = Array.isArray(message['content']) ? message['content'] : []
    const types = new Set(
      content.filter(isPlainObject).map((block) => block['type']),
    )
    lastAssistantSettled =
      typeof reason === 'string' &&
      TERMINAL_STOP_REASONS.has(reason) &&
      (types.has('text') || types.has('tool_use'))
  }
  return sawAssistant && lastAssistantSettled
}

/**
 * The joined text of the most recent text-bearing assistant entry in the
 * region appended after `sinceBytes`, or `null` when none exists (no
 * assistant entry, or a tool-only / thinking-only turn with no `text`
 * block). Mirrors `readLastAssistantText` — the on-stop hook's
 * `extract_last_turn` shape — but scoped to THIS turn's appended region,
 * so a prior turn's reply can never be recovered as this turn's.
 *
 * `tm send` uses this on the no-hook JSONL wait-fallback path: the Stop
 * hook never wrote `<sid>.last`, so the deliverable lives only in the
 * transcript, and this recovers it to repopulate `.last` and stdout.
 */
export function lastAssistantTextAfter(path: string, sinceBytes: number): string | null {
  const entries = parsedLines(readAppended(path, sinceBytes))
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry['type'] !== 'assistant') continue
    const message = entry['message']
    if (!isPlainObject(message)) continue
    const content = Array.isArray(message['content']) ? message['content'] : []
    const texts: string[] = []
    for (const block of content) {
      if (!isPlainObject(block)) continue
      if (block['type'] !== 'text') continue
      const t = block['text']
      if (typeof t === 'string') texts.push(t)
    }
    const joined = texts.join('')
    if (joined.length > 0) return joined
  }
  return null
}
