import { describe, expect, it } from 'vitest'

import {
  LineBuffer,
  TurnAggregator,
  assistantText,
  buildCanUseToolAllow,
  buildControlAck,
  buildRemoteControlEnable,
  buildUserMessage,
  parseLine,
} from '../../../../src/engines/claude/stream-json/protocol'

/**
 * A full no-tool turn, modelled on the real `claude -p --output-format
 * stream-json --verbose --include-partial-messages` wire sequence. Values are
 * synthetic — no captured content.
 */
/** Index `TURN_LINES` without `noUncheckedIndexedAccess` noise. */
function L(i: number): string {
  const line = TURN_LINES[i]
  if (line === undefined) throw new Error(`no fixture line ${i}`)
  return line
}

const TURN_LINES: string[] = [
  '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","hook_id":"h1","session_id":"s-1"}',
  '{"type":"system","subtype":"hook_response","hook_id":"h1","exit_code":0,"outcome":"continue","session_id":"s-1"}',
  '{"type":"system","subtype":"init","session_id":"s-1","cwd":"/repo","model":"claude-opus-4-8","tools":["Bash","Edit"],"mcp_servers":[],"permissionMode":"bypassPermissions","slash_commands":["compact"],"output_style":"default","skills":[],"plugins":[],"apiKeySource":"none","claude_code_version":"2.1.160","uuid":"u-init"}',
  '{"type":"system","subtype":"status","status":{"status":"requesting"},"session_id":"s-1","uuid":"u-st"}',
  '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-ms"}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-cbs"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-d1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-d2"}',
  '{"type":"assistant","message":{"id":"msg_1","model":"claude-opus-4-8","role":"assistant","type":"message","content":[{"type":"text","text":"Hello world"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-asst"}',
  '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-cbe"}',
  '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-md"}',
  '{"type":"stream_event","event":{"type":"message_stop"},"parent_tool_use_id":null,"session_id":"s-1","uuid":"u-mst"}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"session_id":"s-1","uuid":"u-rl"}',
  '{"type":"result","subtype":"success","is_error":false,"duration_ms":2462,"duration_api_ms":2063,"num_turns":1,"result":"Hello world","stop_reason":"end_turn","total_cost_usd":0.1,"usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":5},"modelUsage":{},"permission_denials":[],"session_id":"s-1","uuid":"u-res"}',
]

describe('parseLine', () => {
  it('classifies the data-plane envelopes', () => {
    expect(parseLine(L(2)).kind).toBe('init')
    expect(parseLine(L(3)).kind).toBe('status')
    expect(parseLine(L(8)).kind).toBe('assistant')
    expect(parseLine(L(6)).kind).toBe('stream_event')
    expect(parseLine(L(13)).kind).toBe('result')
  })

  it('extracts init metadata', () => {
    const p = parseLine(L(2))
    expect(p).toMatchObject({ kind: 'init', sessionId: 's-1', model: 'claude-opus-4-8', permissionMode: 'bypassPermissions' })
  })

  it('extracts assistant text and a text delta', () => {
    const a = parseLine(L(8))
    expect(a.kind === 'assistant' && a.text).toBe('Hello world')
    const d = parseLine(L(6))
    expect(d.kind === 'stream_event' && d.textDelta).toBe('Hello ')
  })

  it('reduces a success result with usage and cost', () => {
    const r = parseLine(L(13))
    if (r.kind !== 'result') throw new Error('expected result')
    expect(r.outcome.isError).toBe(false)
    expect(r.outcome.text).toBe('Hello world')
    expect(r.outcome.stopReason).toBe('end_turn')
    expect(r.outcome.totalCostUsd).toBe(0.1)
    expect(r.outcome.usage?.inputTokens).toBe(10)
    expect(r.outcome.usage?.cacheReadInputTokens).toBe(5)
  })

  it('treats an error result subtype as an error even without is_error', () => {
    const line = '{"type":"result","subtype":"error_during_execution","duration_ms":1,"num_turns":1,"stop_reason":null,"total_cost_usd":0,"usage":{},"errors":["boom"],"session_id":"s-1"}'
    const r = parseLine(line)
    if (r.kind !== 'result') throw new Error('expected result')
    expect(r.outcome.isError).toBe(true)
    expect(r.outcome.errors).toEqual(['boom'])
    expect(r.outcome.text).toBeNull()
  })

  it('is forward-tolerant: unknown system subtypes and types become "other", never throw', () => {
    expect(parseLine('{"type":"system","subtype":"post_turn_summary","title":"x","session_id":"s"}').kind).toBe('other')
    expect(parseLine('{"type":"system","subtype":"api_retry","attempt":1}').kind).toBe('other')
    expect(parseLine('{"type":"keep_alive"}').kind).toBe('other')
    expect(parseLine('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}').kind).toBe('other')
    expect(parseLine('{"type":"brand_new_future_type","x":1}').kind).toBe('other')
  })

  it('never throws on a non-JSON or non-object line', () => {
    expect(parseLine('not json at all').kind).toBe('parse_error')
    expect(parseLine('[1,2,3]').kind).toBe('parse_error')
    expect(parseLine('').kind).toBe('parse_error')
  })

  it('decodes the control plane', () => {
    const req = parseLine('{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t1"}}')
    expect(req).toMatchObject({ kind: 'control_request', requestId: 'r1', subtype: 'can_use_tool' })
    const res = parseLine('{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"session_url":"https://x"}}}')
    if (res.kind !== 'control_response') throw new Error('expected control_response')
    expect(res.ok).toBe(true)
    expect(res.response?.['session_url']).toBe('https://x')
  })
})

describe('assistantText', () => {
  it('joins text blocks and skips thinking/tool_use', () => {
    const msg = { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'A' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'B' }] }
    expect(assistantText(msg)).toBe('AB')
  })
  it('accepts a string content', () => {
    expect(assistantText({ content: 'plain' })).toBe('plain')
  })
})

describe('LineBuffer', () => {
  it('frames NDJSON across arbitrary chunk boundaries', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(lb.push('2}\n')).toEqual(['{"b":2}'])
    expect(lb.push('partial')).toEqual([])
    expect(lb.flush()).toBe('partial')
  })
  it('drops blank lines and strips CR', () => {
    const lb = new LineBuffer()
    expect(lb.push('a\r\n\r\nb\n')).toEqual(['a', 'b'])
  })
})

describe('TurnAggregator', () => {
  it('aggregates a full turn and resolves the outcome on result', () => {
    const agg = new TurnAggregator()
    for (const line of TURN_LINES) {
      expect(agg.done).toBe(false)
      agg.accept(parseLine(line))
    }
    expect(agg.done).toBe(true)
    const out = agg.outcome()
    expect(out).not.toBeNull()
    expect(out!.text).toBe('Hello world')
    expect(out!.isError).toBe(false)
    expect(out!.stopReason).toBe('end_turn')
    expect(out!.totalCostUsd).toBe(0.1)
    expect(out!.sessionId).toBe('s-1')
  })

  it('falls back to the last assistant snapshot when result text is empty', () => {
    const agg = new TurnAggregator()
    agg.accept(parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"snap"}]},"session_id":"s"}'))
    agg.accept(parseLine('{"type":"result","subtype":"success","is_error":false,"result":"","num_turns":1,"duration_ms":1,"total_cost_usd":0,"usage":{},"stop_reason":"end_turn","session_id":"s"}'))
    expect(agg.outcome()!.text).toBe('snap')
  })

  it('tracks session id from init before result', () => {
    const agg = new TurnAggregator()
    agg.accept(parseLine(L(2)))
    expect(agg.sessionId).toBe('s-1')
  })

  it('reports empty text for a tool-only / empty-result turn (no stale carry-over)', () => {
    const agg = new TurnAggregator()
    agg.accept(parseLine('{"type":"result","subtype":"success","is_error":false,"result":"","num_turns":1,"duration_ms":1,"total_cost_usd":0,"usage":{},"stop_reason":"end_turn","session_id":"s"}'))
    expect(agg.outcome()!.text).toBe('')
  })
})

describe('outbound builders', () => {
  it('builds a user message line', () => {
    expect(JSON.parse(buildUserMessage('hi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })
  })
  it('builds the remote-control enable request', () => {
    const m = JSON.parse(buildRemoteControlEnable('r9'))
    expect(m).toMatchObject({ type: 'control_request', request_id: 'r9', request: { subtype: 'remote_control', enabled: true } })
  })
  it('builds a can_use_tool allow that echoes the input as updatedInput, and a bare ack', () => {
    expect(JSON.parse(buildCanUseToolAllow('r1', { command: 'ls' })).response).toMatchObject({
      subtype: 'success',
      request_id: 'r1',
      response: { behavior: 'allow', updatedInput: { command: 'ls' } },
    })
    expect(JSON.parse(buildControlAck('r2')).response).toMatchObject({ subtype: 'success', request_id: 'r2' })
  })
})
