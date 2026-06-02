/**
 * Claude-engine identifier helpers — the random suffix `tm spawn` mints for an
 * auto-generated teammate name. Centralised so a future change to the alphabet
 * or length is a one-site edit.
 */

import { randomBytes } from 'node:crypto'

/** `tm`'s `rand_suffix`: 4 chars drawn from `[a-z0-9]`. */
export function randSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}
