/**
 * Daemon <-> proxy IPC framing + message contract (claudemux#10, daemon refactor).
 *
 * The standing daemon owns the single Feishu connection; each Claude Code
 * session loads a thin stdio proxy that talks to the daemon over a unix socket.
 * This module is the wire format for that socket: a 4-byte big-endian length
 * prefix followed by a UTF-8 JSON payload, plus the typed message union both
 * sides exchange. It is transport-agnostic (any duplex byte stream) and has no
 * Feishu / MCP dependency, so it is unit-testable in isolation.
 */

/** Proxy -> daemon. */
export type ProxyToDaemon =
  /** First message after connect: identify the session behind this proxy. */
  | {
      t: 'register'
      sessionId: string
      pid: number
      proxyVersion: string
      role: 'dispatcher' | 'session'
      /**
       * Source-specific identity the proxy self-reports so a coordinator can
       * locate this session by something readable (e.g. a teammate name)
       * instead of reverse-engineering it from `pid`. The channel core treats
       * these as opaque string pairs and never interprets a key; an orchestrator
       * such as claudemux populates well-known keys (`cwd`, `teammate_name`).
       * Optional and additive: an older proxy omits it, an older daemon ignores it.
       */
      metadata?: Record<string, string>
    }
  /** Forward an MCP tool call (reply / react / edit_message) for the daemon to run. */
  | { t: 'tool'; id: number; name: string; args: Record<string, unknown> }
  /**
   * Delivery acknowledgement: the proxy has written the channel notification to
   * its MCP transport. Only on this ACK may the daemon mark the inbound row
   * `delivered` (the end-to-end guarantee — see claudemux#10 handoff spec).
   */
  | { t: 'ack'; eventId: string }

/** Daemon -> proxy. */
export type DaemonToProxy =
  /** Greeting on connect: lets the proxy detect a version/generation it must upgrade past. */
  | { t: 'hello'; daemonVersion: string; generation: number }
  /** A gated inbound event to push to Claude as a `<channel>` block. */
  | { t: 'deliver'; eventId: string; content: string; meta: Record<string, string> }
  /** Result of a forwarded tool call, keyed by the proxy's `tool.id`. */
  | { t: 'tool_result'; id: number; ok: true; result: unknown }
  | { t: 'tool_result'; id: number; ok: false; error: string }

export type IpcMessage = ProxyToDaemon | DaemonToProxy

/** Width of the length prefix, in bytes (uint32 big-endian). */
export const FRAME_HEADER_BYTES = 4

/**
 * A single frame cannot exceed this. The channel payload is small (a markdown
 * string + flat string meta), so 8 MiB is far above any legitimate message and
 * just bounds a hostile/garbage length prefix instead of allocating wildly.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Encode one message as a length-prefixed JSON frame. */
export function encodeFrame(message: IpcMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`ipc frame too large: ${payload.length} > ${MAX_FRAME_BYTES}`)
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/**
 * Reassembles frames from a byte stream that arrives in arbitrary chunks.
 * `push()` appends bytes and returns every complete message now available;
 * partial frames are buffered until the rest arrives. Throws on a frame that
 * claims to exceed `MAX_FRAME_BYTES` (corrupt/hostile stream) so the caller can
 * drop the connection rather than buffer unboundedly.
 */
export class FrameDecoder<T extends IpcMessage = IpcMessage> {
  #buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): T[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const out: T[] = []
    while (this.#buffer.length >= FRAME_HEADER_BYTES) {
      const len = this.#buffer.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`ipc frame length ${len} exceeds MAX_FRAME_BYTES ${MAX_FRAME_BYTES}`)
      }
      const total = FRAME_HEADER_BYTES + len
      if (this.#buffer.length < total) break // wait for the rest of this frame
      const payload = this.#buffer.subarray(FRAME_HEADER_BYTES, total)
      // The stream carries one direction, so the caller parameterizes T.
      out.push(JSON.parse(payload.toString('utf8')) as T)
      this.#buffer = this.#buffer.subarray(total)
    }
    return out
  }

  /** Bytes held pending a complete frame — for tests / leak assertions. */
  get pending(): number {
    return this.#buffer.length
  }
}
