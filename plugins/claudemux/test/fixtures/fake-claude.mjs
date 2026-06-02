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

const SESSION_ID = process.env.FAKE_CLAUDE_SESSION_ID || '11111111-2222-3333-4444-555555555555'

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

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
    const content = msg.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : ''
    const reply = `echo: ${text}`
    emit({ type: 'system', subtype: 'status', status: { status: 'requesting' }, session_id: SESSION_ID, uuid: 'u-st' })
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } }, parent_tool_use_id: null, session_id: SESSION_ID, uuid: 'u-a' })
    emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: reply, stop_reason: 'end_turn', total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 }, modelUsage: {}, permission_denials: [], session_id: SESSION_ID, uuid: 'u-r' })
  }
})
rl.on('close', () => process.exit(0))
