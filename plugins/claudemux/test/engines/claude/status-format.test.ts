import { describe, expect, it } from 'vitest'

import {
  formatClaudeSpawnStdout,
  formatClaudeSpawnTmResult,
  formatClaudeStatusPane,
  waitForRemoteControlUrl,
} from '../../../src/engines/claude/claude-engine'
import type { BrokerResponse } from '../../../src/engines/claude/stream-json/wire'

function statusResponse(remoteControlUrl: string | null): BrokerResponse {
  return {
    ok: true,
    kind: 'status',
    status: {
      sessionId: 'sid-1',
      model: 'opus',
      state: 'idle',
      remoteControlUrl,
      lastText: null,
    },
  }
}

describe('Claude stream-json status formatting', () => {
  it('prints known broker fields even when no latest reply exists', () => {
    const out = formatClaudeStatusPane({
      name: 'alpha',
      cwd: '/tmp/alpha',
      status: {
        sessionId: 'sid-1',
        model: null,
        state: 'idle',
        remoteControlUrl: null,
        lastText: null,
      },
    })

    expect(out).toContain('name: alpha\n')
    expect(out).toContain('state: idle\n')
    expect(out).toContain('session id: sid-1\n')
    expect(out).toContain('model: (unknown)\n')
    expect(out).toContain('latest reply:\n(no latest reply)\n')
  })

  it('surfaces the Remote Control URL in status and spawn output', () => {
    const url = 'https://example.invalid/session/fake'
    const status = formatClaudeStatusPane({
      name: 'alpha',
      cwd: '/tmp/alpha',
      status: {
        sessionId: 'sid-1',
        model: 'opus',
        state: 'idle',
        remoteControlUrl: url,
        lastText: 'done',
      },
    })

    expect(status).toContain(`remote control: ${url}\n`)
    expect(formatClaudeSpawnStdout('alpha', url)).toBe(`spawned alpha\nremote control: ${url}\n`)
  })

  it('waits for the broker to publish the Remote Control URL', async () => {
    const url = 'https://example.invalid/session/fake'
    const seenRequests: string[] = []
    const replies = [statusResponse(null), statusResponse(url)]

    const found = await waitForRemoteControlUrl('alpha', {
      request: async (name) => {
        seenRequests.push(name)
        return replies.shift() ?? statusResponse(null)
      },
      sleep: async () => {},
      now: () => 0,
      waitMs: 100,
      pollMs: 1,
    })

    expect(found).toBe(url)
    expect(seenRequests).toEqual(['alpha', 'alpha'])
  })

  it('returns null when the Remote Control URL wait times out', async () => {
    let now = 0
    let requestCount = 0

    const found = await waitForRemoteControlUrl('alpha', {
      request: async () => {
        requestCount += 1
        return statusResponse(null)
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      waitMs: 2,
      pollMs: 1,
    })

    expect(found).toBeNull()
    expect(requestCount).toBe(2)
    expect(now).toBe(2)
  })

  it('keeps the Remote Control URL on stdout when spawn has no first prompt', () => {
    const url = 'https://example.invalid/session/fake'

    expect(formatClaudeSpawnTmResult({
      name: 'alpha',
      remoteControlUrl: url,
      firstTurnTmResult: undefined,
    })).toEqual({
      code: 0,
      stdout: `spawned alpha\nremote control: ${url}\n`,
      stderr: '',
    })
  })

  it('keeps first-turn stdout pure and appends the Remote Control URL to stderr', () => {
    const url = 'https://example.invalid/session/fake'

    expect(formatClaudeSpawnTmResult({
      name: 'alpha',
      remoteControlUrl: url,
      firstTurnTmResult: { code: 0, stdout: 'assistant reply\n', stderr: 'ctx: in=1 out=2\n' },
    })).toEqual({
      code: 0,
      stdout: 'assistant reply\n',
      stderr: `ctx: in=1 out=2\nremote control: ${url}\n`,
    })
  })

  it('keeps spawn successful when no Remote Control URL is available', () => {
    expect(formatClaudeSpawnTmResult({
      name: 'alpha',
      remoteControlUrl: null,
      firstTurnTmResult: undefined,
    })).toEqual({
      code: 0,
      stdout: 'spawned alpha\n',
      stderr: '',
    })

    expect(formatClaudeSpawnTmResult({
      name: 'alpha',
      remoteControlUrl: null,
      firstTurnTmResult: { code: 0, stdout: 'assistant reply\n', stderr: '' },
    })).toEqual({
      code: 0,
      stdout: 'assistant reply\n',
      stderr: '',
    })
  })
})
