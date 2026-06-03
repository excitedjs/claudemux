#!/usr/bin/env node
/**
 * A fake `claude -p --output-format stream-json --input-format stream-json`
 * binary for broker end-to-end tests. It speaks just enough of the wire
 * protocol to exercise the broker without a real Claude install:
 *
 *  - emits a `system/init` envelope on startup (so the broker reaches `ready`);
 *  - for each `user` message on stdin, emits a `system/status` working signal,
 *    an `assistant` snapshot, and a terminal `result/success` that echoes the
 *    prompt;
 *  - answers a `remote_control` control request with a synthetic session URL;
 *  - stays alive until stdin closes (persistent multi-turn session).
 *
 * Flags are ignored — the broker passes the real stream-json flag set, which
 * this fixture does not need to interpret.
 */

import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const SESSION_ID = process.env.FAKE_CLAUDE_SESSION_ID || '11111111-2222-3333-4444-555555555555'

if (process.env.FAKE_CLAUDE_CAPTURE_FILE) {
  const captureKeys = (process.env.FAKE_CLAUDE_CAPTURE_ENV_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
  const shouldCapture = captureKeys.length > 0
    ? (key) => captureKeys.includes(key)
    : (key) => /CHANNEL|CLAUDEMUX_TEAMMATE_NAME/.test(key)
  writeFileSync(
    process.env.FAKE_CLAUDE_CAPTURE_FILE,
    `${JSON.stringify({
      argv: process.argv.slice(2),
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => shouldCapture(key)),
      ),
    })}\n`,
    'utf8',
  )
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

// Real `claude --input-format stream-json` does NOT emit `init` at startup — it
// emits it with the first turn, once a user message arrives on stdin. This
// fixture matches that so a broker that waits for `init` before sending would
// deadlock here too.
let initialized = false
function ensureInit() {
  if (initialized) return
  initialized = true
  emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    cwd: process.cwd(),
    model: 'fake-model',
    tools: ['Bash'],
    mcp_servers: [],
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    apiKeySource: 'none',
    claude_code_version: 'fake',
    uuid: 'u-init',
  })
}

// Simulate an RC / channel inbound turn: emit a full turn with NO user message
// on stdin, after a delay. Exercises the broker's spontaneous-turn path.
const spontaneousMs = Number(process.env.FAKE_CLAUDE_SPONTANEOUS_MS || '0')
if (spontaneousMs > 0) {
  setTimeout(() => {
    ensureInit()
    emit({ type: 'system', subtype: 'status', status: { status: 'working' }, session_id: SESSION_ID, uuid: 'u-sp-st' })
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'spontaneous reply' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: SESSION_ID, uuid: 'u-sp-a' })
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'spontaneous reply', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], session_id: SESSION_ID, uuid: 'u-sp-r' })
  }, spontaneousMs)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'control_request' && msg.request?.subtype === 'remote_control') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { session_url: 'https://example.invalid/session/fake' } } })
    return
  }
  if (msg.type === 'user') {
    ensureInit()
    const content = msg.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : ''
    emit({ type: 'system', subtype: 'status', status: { status: 'requesting' }, session_id: SESSION_ID, uuid: 'u-st' })
    if (text === '__EMPTY__') {
      // A tool-only / empty-result turn: no assistant text, empty result.
      emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: '', stop_reason: 'end_turn', total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], session_id: SESSION_ID, uuid: 'u-r0' })
      return
    }
    const reply = `echo: ${text}`
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }, parent_tool_use_id: null, session_id: SESSION_ID, uuid: 'u-a' })
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: reply, stop_reason: 'end_turn', total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 }, modelUsage: {}, permission_denials: [], session_id: SESSION_ID, uuid: 'u-r' })
  }
})
rl.on('close', () => process.exit(0))
