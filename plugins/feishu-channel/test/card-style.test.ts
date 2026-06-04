import { describe, expect, test } from 'vitest'

import { styleReplyCard, styleReplyCards } from '../src/card-style'
import type { RenderedCard } from '@excitedjs/feishu-transport'

/** Build a minimal rendered card from body elements (+ optional H1 header). */
function mk(elements: unknown[], headerTitle?: string): RenderedCard {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { update_multi: true },
    body: { elements },
  }
  if (headerTitle !== undefined) {
    card.header = { title: { tag: 'plain_text', content: headerTitle } }
  }
  return card as unknown as RenderedCard
}

const md = (content: string) => ({ tag: 'markdown', content })
/** A reply card's first body element, read structurally for assertions. */
type Body = Array<{
  tag: string
  expanded?: boolean
  elements?: Array<{ tag: string; content?: string }>
}>
const body = (card: RenderedCard): Body => card.body.elements as unknown as Body
const isWrapped = (card: RenderedCard): boolean => body(card).some((e) => e.tag === 'collapsible_panel')
const template = (card: RenderedCard): string | undefined =>
  (card.header as { template?: string } | undefined)?.template

describe('styleReplyCards — short replies stay plain', () => {
  test('a one-liner is returned untouched: no panel, no header', () => {
    const [card] = styleReplyCards([mk([md('收到，已处理。')])])
    expect(isWrapped(card!)).toBe(false)
    expect(card!.header).toBeUndefined()
    expect(body(card!)).toEqual([{ tag: 'markdown', content: '收到，已处理。' }])
  })

  test('a short reply with an H1 keeps a bare, untinted header — still light', () => {
    const [card] = styleReplyCards([mk([md('已完成。')], '状态')])
    expect(isWrapped(card!)).toBe(false)
    expect(template(card!)).toBeUndefined()
  })

  test('the empty always-emit card is never wrapped', () => {
    const [card] = styleReplyCards([mk([md('')])])
    expect(isWrapped(card!)).toBe(false)
    expect(body(card!)).toEqual([{ tag: 'markdown', content: '' }])
  })
})

describe('styleReplyCards — large replies get the frame', () => {
  test('four leaf elements cross the threshold and wrap in one expanded panel', () => {
    const [card] = styleReplyCards([mk([md('a'), md('b'), md('c'), md('d')])])
    expect(isWrapped(card!)).toBe(true)
    const panel = body(card!)[0]!
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.expanded).toBe(true)
    expect(panel.elements).toHaveLength(4)
  })

  test('a single large paragraph (over the byte threshold) is wrapped', () => {
    const [card] = styleReplyCards([mk([md('文'.repeat(400))])])
    expect(isWrapped(card!)).toBe(true)
  })

  test('a styled reply with an H1 tints the header banner', () => {
    const [card] = styleReplyCards([mk([md('a'), md('b'), md('c'), md('d')], '巡检结果')])
    expect(isWrapped(card!)).toBe(true)
    expect(template(card!)).toBe('blue')
  })

  test('a multi-card reply wraps every card', () => {
    const cards = styleReplyCards([mk([md('a')], 'T'), mk([md('b')])])
    expect(cards.every((c) => isWrapped(c))).toBe(true)
  })

  test('a styled card keeps schema 2.0 and update_multi', () => {
    const [card] = styleReplyCards([mk([md('a'), md('b'), md('c'), md('d')])])
    expect(card!.schema).toBe('2.0')
    expect((card!.config as { update_multi: boolean }).update_multi).toBe(true)
  })

  test('content is verbatim — the panel does not renumber the body into steps', () => {
    const [card] = styleReplyCards([mk([md('one'), md('two'), md('three'), md('four')])])
    const panel = body(card!)[0]!
    expect((panel.elements as Array<{ content?: string }>).map((e) => e.content)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })
})

describe('styleReplyCards — tables cannot live in a panel', () => {
  const table = { tag: 'table', columns: [], rows: [] }

  test('a large reply containing a table stays at top level but tints the header', () => {
    const [card] = styleReplyCards([mk([md('p1'), md('p2'), table, md('p3')], '汇总')])
    expect(isWrapped(card!)).toBe(false)
    expect(body(card!).map((e) => e.tag)).toEqual(['markdown', 'markdown', 'table', 'markdown'])
    expect(template(card!)).toBe('blue')
  })
})

describe('styleReplyCard — single-card (edit path)', () => {
  test('wraps a large single card and leaves a short one plain', () => {
    expect(isWrapped(styleReplyCard(mk([md('a'), md('b'), md('c'), md('d')])))).toBe(true)
    expect(isWrapped(styleReplyCard(mk([md('短')])))).toBe(false)
  })
})
