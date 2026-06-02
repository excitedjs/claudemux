/**
 * The Claude stream-json wire protocol — a clean-room model of the envelopes
 * the `claude` CLI emits and accepts on stdio under
 * `--output-format stream-json --input-format stream-json`.
 *
 * Two design rules, both load-bearing:
 *
 *  - **Forward-tolerant by construction.** The CLI's real envelope set is much
 *    wider than anything claudemux consumes (extra `system` subtypes —
 *    `post_turn_summary`, `api_retry`, `hook_started`/`hook_response`,
 *    `tool_progress`, `auth_status` — plus `rate_limit_event`, `keep_alive`,
 *    streamlined variants, and `result` fields like `modelUsage` /
 *    `permission_denials` / `structured_output` / `fast_mode_state`). This
 *    parser never validates a closed schema and never throws on an unknown
 *    `type`/`subtype`; it reads only the fields the broker needs and ignores
 *    the rest. A wider or newer CLI build cannot break a turn.
 *
 *  - **No third-party dependency.** claudemux is zero-install
 *    (decision zero-install-type-stripping); parsing is hand-rolled `typeof`
 *    narrowing over `JSON.parse`, the same discipline as
 *    `engines/claude/turn-jsonl.ts`.
 *
 * This module is pure — no I/O, no process, no clock — so the line parser and
 * the turn aggregator are unit-tested against **synthetic** envelope sequences
 * (hand-authored to the real wire shapes, not captured from a live session)
 * with no real `claude` binary.
 */

// ─── Low-level value helpers ────────────────────────────────────────────────

/** A parsed JSON object, or `null` for anything that is not a JSON object. */
export type JsonObject = Record<string, unknown>

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// ─── Line framing ───────────────────────────────────────────────────────────

/**
 * Incremental newline framer. The child's stdout is NDJSON but arrives in
 * arbitrary chunks; `push` returns the complete lines so far and buffers a
 * trailing partial line until its newline lands. Blank lines are dropped.
 */
export class LineBuffer {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const out: string[] = []
    let nl = this.buf.indexOf('\n')
    while (nl >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      if (trimmed.length > 0) out.push(trimmed)
      nl = this.buf.indexOf('\n')
    }
    return out
  }

  /** Any buffered bytes with no trailing newline (e.g. at stream end). */
  flush(): string | null {
    const rest = this.buf.trim()
    this.buf = ''
    return rest.length > 0 ? rest : null
  }
}

// ─── Parsed envelope ────────────────────────────────────────────────────────

/**
 * One decoded stdout line. `kind` is claudemux's coarse classification, not
 * the CLI's `type` — it groups the wire types by how the broker reacts:
 *
 *  - `init` / `status` / `assistant` / `stream_event` / `result` — the
 *    data-plane envelopes the turn aggregator consumes.
 *  - `control_request` / `control_response` / `control_cancel` — the control
 *    plane (permission callbacks, the remote-control handshake).
 *  - `other` — a valid JSON object the broker does not act on (rate-limit
 *    events, hook lifecycle, streamlined text, …). Carried, never dropped.
 *  - `parse_error` — the line was not JSON; surfaced for logging, never thrown.
 */
export type ParsedLine =
  | { kind: 'init'; sessionId: string | null; model: string | null; permissionMode: string | null; raw: JsonObject }
  | { kind: 'status'; status: string | null; raw: JsonObject }
  | { kind: 'assistant'; text: string; sessionId: string | null; raw: JsonObject }
  | { kind: 'stream_event'; eventType: string | null; textDelta: string | null; raw: JsonObject }
  | { kind: 'result'; outcome: ResultEnvelope; raw: JsonObject }
  | { kind: 'control_request'; requestId: string | null; subtype: string | null; request: JsonObject; raw: JsonObject }
  | { kind: 'control_response'; requestId: string | null; ok: boolean; response: JsonObject | null; error: string | null; raw: JsonObject }
  | { kind: 'control_cancel'; requestId: string | null; raw: JsonObject }
  | { kind: 'other'; type: string | null; subtype: string | null; raw: JsonObject }
  | { kind: 'parse_error'; raw: string }

/** Token-usage counts, cache-inclusive on the input side. All optional upstream. */
export interface UsageCounts {
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheCreationInputTokens: number | null
  readonly cacheReadInputTokens: number | null
}

/** The terminal `result` envelope, reduced to what the broker records per turn. */
export interface ResultEnvelope {
  /** `success` or one of the `error_*` subtypes. Unknown subtypes pass through verbatim. */
  readonly subtype: string | null
  readonly isError: boolean
  /** The success-path final text (`result`); `null` for error subtypes. */
  readonly text: string | null
  readonly stopReason: string | null
  readonly usage: UsageCounts | null
  readonly totalCostUsd: number | null
  readonly numTurns: number | null
  readonly durationMs: number | null
  readonly sessionId: string | null
  /** Error subtypes carry a message list; empty otherwise. */
  readonly errors: readonly string[]
}

function parseUsage(v: unknown): UsageCounts | null {
  if (!isObject(v)) return null
  return {
    inputTokens: num(v['input_tokens']),
    outputTokens: num(v['output_tokens']),
    cacheCreationInputTokens: num(v['cache_creation_input_tokens']),
    cacheReadInputTokens: num(v['cache_read_input_tokens']),
  }
}

/**
 * Join the text blocks of an Anthropic assistant `message.content` array.
 * `thinking` and `tool_use` blocks contribute no visible text and are skipped,
 * matching how `tm last` has always surfaced a Claude turn.
 */
export function assistantText(message: unknown): string {
  if (!isObject(message)) return ''
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isObject(block)) continue
    if (block['type'] === 'text') {
      const t = str(block['text'])
      if (t !== null) parts.push(t)
    }
  }
  return parts.join('')
}

function parseResult(o: JsonObject): ResultEnvelope {
  const subtype = str(o['subtype'])
  const errorsRaw = o['errors']
  const errors = Array.isArray(errorsRaw) ? errorsRaw.filter((e): e is string => typeof e === 'string') : []
  return {
    subtype,
    isError: o['is_error'] === true || (subtype !== null && subtype !== 'success'),
    text: str(o['result']),
    stopReason: str(o['stop_reason']),
    usage: parseUsage(o['usage']),
    totalCostUsd: num(o['total_cost_usd']),
    numTurns: num(o['num_turns']),
    durationMs: num(o['duration_ms']),
    sessionId: str(o['session_id']),
    errors,
  }
}

function parseStreamEvent(o: JsonObject): { eventType: string | null; textDelta: string | null } {
  const event = o['event']
  if (!isObject(event)) return { eventType: null, textDelta: null }
  const eventType = str(event['type'])
  // content_block_delta → { delta: { type: 'text_delta', text } }
  let textDelta: string | null = null
  if (eventType === 'content_block_delta') {
    const delta = event['delta']
    if (isObject(delta) && delta['type'] === 'text_delta') textDelta = str(delta['text'])
  }
  return { eventType, textDelta }
}

/**
 * Decode one stdout line. Never throws: a non-JSON line becomes
 * `parse_error`, and a JSON object of an unmodelled type becomes `other`.
 */
export function parseLine(line: string): ParsedLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'parse_error', raw: line }
  }
  if (!isObject(parsed)) return { kind: 'parse_error', raw: line }
  const type = str(parsed['type'])
  const subtype = str(parsed['subtype'])

  switch (type) {
    case 'system':
      if (subtype === 'init') {
        return {
          kind: 'init',
          sessionId: str(parsed['session_id']),
          model: str(parsed['model']),
          permissionMode: str(parsed['permissionMode']),
          raw: parsed,
        }
      }
      if (subtype === 'status') {
        const s = parsed['status']
        return { kind: 'status', status: isObject(s) ? str(s['status']) ?? str(parsed['status']) : str(parsed['status']), raw: parsed }
      }
      return { kind: 'other', type, subtype, raw: parsed }
    case 'assistant':
      return { kind: 'assistant', text: assistantText(parsed['message']), sessionId: str(parsed['session_id']), raw: parsed }
    case 'stream_event': {
      const { eventType, textDelta } = parseStreamEvent(parsed)
      return { kind: 'stream_event', eventType, textDelta, raw: parsed }
    }
    case 'result':
      return { kind: 'result', outcome: parseResult(parsed), raw: parsed }
    case 'control_request': {
      const request = parsed['request']
      return {
        kind: 'control_request',
        requestId: str(parsed['request_id']),
        subtype: isObject(request) ? str(request['subtype']) : null,
        request: isObject(request) ? request : {},
        raw: parsed,
      }
    }
    case 'control_response': {
      const response = parsed['response']
      if (isObject(response)) {
        const inner = response['response']
        return {
          kind: 'control_response',
          requestId: str(response['request_id']),
          ok: response['subtype'] === 'success',
          response: isObject(inner) ? inner : null,
          error: str(response['error']),
          raw: parsed,
        }
      }
      return { kind: 'control_response', requestId: null, ok: false, response: null, error: null, raw: parsed }
    }
    case 'control_cancel_request':
      return { kind: 'control_cancel', requestId: str(parsed['request_id']), raw: parsed }
    default:
      return { kind: 'other', type, subtype, raw: parsed }
  }
}

// ─── Outbound message builders (stdin) ──────────────────────────────────────

/** One user turn as a stream-json `user` message line (no trailing newline). */
export function buildUserMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

/** Enable Remote Control via a `remote_control` control request. */
export function buildRemoteControlEnable(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'remote_control', enabled: true },
  })
}

/**
 * Answer a `can_use_tool` control request with `allow`. The broker runs
 * unattended, so the answer for a teammate that has no human to consult is
 * "allow". `updatedInput` echoes the tool's original input — the permission
 * result shape carries the (possibly-rewritten) input the tool should run with,
 * so the unmodified input is passed straight back rather than omitted.
 *
 * This is a defensive path: under `--dangerously-skip-permissions` the CLI does
 * not gate tools, so `can_use_tool` is not normally emitted. It is wired so that
 * if a build or mode does emit one, the broker answers it rather than leaving
 * the turn waiting on an unanswered control request.
 */
export function buildCanUseToolAllow(requestId: string, input: JsonObject): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } },
  })
}

/** Acknowledge any other control request with a bare success so the CLI proceeds. */
export function buildControlAck(requestId: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: {} },
  })
}

// ─── Turn aggregation ───────────────────────────────────────────────────────

/** The reduced outcome of one assistant turn, terminated by a `result`. */
export interface TurnOutcome {
  readonly isError: boolean
  /** Final reply text: the `result.result`, falling back to the last assistant snapshot. */
  readonly text: string
  readonly stopReason: string | null
  readonly usage: UsageCounts | null
  readonly totalCostUsd: number | null
  readonly numTurns: number | null
  readonly durationMs: number | null
  readonly sessionId: string | null
  readonly subtype: string | null
  readonly errors: readonly string[]
}

/**
 * Accumulates the envelopes of a single turn and resolves a `TurnOutcome` when
 * the `result` lands. One aggregator per turn: feed every `ParsedLine`, then
 * read `outcome()` once `done` is true.
 *
 * The final text prefers the `result.result` (the CLI's own canonical answer)
 * and falls back to the latest `assistant` snapshot — so a turn that ends
 * tool-only or whose result text is empty still surfaces whatever the model
 * last said.
 */
export class TurnAggregator {
  private lastAssistantText = ''
  private result: ResultEnvelope | null = null
  private initSessionId: string | null = null

  /** Returns `true` once the terminal `result` has been seen. */
  get done(): boolean {
    return this.result !== null
  }

  /** The session id from `init` (or the result), once known. */
  get sessionId(): string | null {
    return this.result?.sessionId ?? this.initSessionId
  }

  accept(line: ParsedLine): void {
    switch (line.kind) {
      case 'init':
        if (line.sessionId !== null) this.initSessionId = line.sessionId
        break
      case 'assistant':
        if (line.text.length > 0) this.lastAssistantText = line.text
        break
      case 'result':
        this.result = line.outcome
        break
      default:
        break
    }
  }

  outcome(): TurnOutcome | null {
    const r = this.result
    if (r === null) return null
    const text = r.text !== null && r.text.length > 0 ? r.text : this.lastAssistantText
    return {
      isError: r.isError,
      text,
      stopReason: r.stopReason,
      usage: r.usage,
      totalCostUsd: r.totalCostUsd,
      numTurns: r.numTurns,
      durationMs: r.durationMs,
      sessionId: r.sessionId ?? this.initSessionId,
      subtype: r.subtype,
      errors: r.errors,
    }
  }
}
