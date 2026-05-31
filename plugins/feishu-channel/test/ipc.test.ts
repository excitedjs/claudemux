import { describe, expect, test } from 'vitest'

import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  MAX_FRAME_BYTES,
  encodeFrame,
  type IpcMessage,
} from '../src/ipc'

const SAMPLES: IpcMessage[] = [
  { t: 'register', sessionId: 's-1', pid: 4242, proxyVersion: '0.2.1' },
  { t: 'tool', id: 7, name: 'reply', args: { chat_id: 'oc_x', text: 'hi <@ou_a>' } },
  { t: 'ack', eventId: 'evt_123' },
  { t: 'hello', daemonVersion: '0.2.1', generation: 3 },
  { t: 'deliver', eventId: 'evt_123', content: '# title\n- a', meta: { message_id: 'om_1' } },
  { t: 'tool_result', id: 7, ok: true, result: { messageIds: ['om_9'] } },
  { t: 'tool_result', id: 7, ok: false, error: 'boom' },
]

describe('ipc framing', () => {
  test('round-trips every message shape', () => {
    const d = new FrameDecoder()
    for (const msg of SAMPLES) {
      expect(d.push(encodeFrame(msg))).toEqual([msg])
    }
    expect(d.pending).toBe(0)
  })

  test('reassembles a frame split across arbitrary chunk boundaries', () => {
    const msg: IpcMessage = SAMPLES[4]!
    const frame = encodeFrame(msg)
    const d = new FrameDecoder()
    // feed one byte at a time; nothing emits until the final byte completes it
    for (let i = 0; i < frame.length - 1; i++) {
      expect(d.push(frame.subarray(i, i + 1))).toEqual([])
      expect(d.pending).toBeGreaterThan(0)
    }
    expect(d.push(frame.subarray(frame.length - 1))).toEqual([msg])
    expect(d.pending).toBe(0)
  })

  test('emits multiple whole frames delivered in one chunk', () => {
    const blob = Buffer.concat(SAMPLES.map(encodeFrame))
    const d = new FrameDecoder()
    expect(d.push(blob)).toEqual(SAMPLES)
    expect(d.pending).toBe(0)
  })

  test('holds a trailing partial frame until completed', () => {
    const a = encodeFrame(SAMPLES[2]!)
    const b = encodeFrame(SAMPLES[3]!)
    const d = new FrameDecoder()
    // first whole frame + the header-only prefix of the second
    expect(d.push(Buffer.concat([a, b.subarray(0, FRAME_HEADER_BYTES)]))).toEqual([SAMPLES[2]])
    expect(d.pending).toBe(FRAME_HEADER_BYTES)
    expect(d.push(b.subarray(FRAME_HEADER_BYTES))).toEqual([SAMPLES[3]])
  })

  test('rejects a frame whose declared length exceeds the cap', () => {
    const hostile = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
    hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    const d = new FrameDecoder()
    expect(() => d.push(hostile)).toThrow(/exceeds MAX_FRAME_BYTES/)
  })
})
