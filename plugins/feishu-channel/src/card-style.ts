/**
 * Size-adaptive styling for reply cards.
 *
 * `@excitedjs/feishu-transport` renders a markdown reply into one or more
 * plain v2 cards (a flat list of `markdown` / `hr` / `table` body elements
 * with at most a plain-text header title). This module re-styles that output
 * in the channel's own send path so the visual treatment is owned here,
 * without changing the shared renderer:
 *
 *   - A SHORT reply (a single card whose body is under both the leaf-element
 *     and content-byte thresholds) is left exactly as the renderer produced
 *     it — a one-liner must not pick up a heavy frame.
 *   - A LARGE reply (enough content to benefit, or split across more than one
 *     card) has each card's body wrapped in one expanded `collapsible_panel`
 *     (blue border) so it reads as a single foldable surface, and the card
 *     that carries the H1 header gets its banner tinted.
 *
 * A `tag: table` element cannot live inside a `collapsible_panel` — Feishu
 * rejects the card at create time. So a table-bearing body is left at top
 * level (tables stay valid and in source order); the header is still tinted.
 *
 * Styling runs on the already-validated renderer output. The transport keeps
 * each card a few hundred bytes under the 30 KB request cap and under the
 * per-card element cap, and the panel wrapper adds only a small fixed
 * envelope (one container, no new leaf elements), so a styled card stays
 * within those margins. `config.update_multi: true` is preserved on every
 * styled card so the channel's later patch-in-place edit still works.
 */

import type { RenderedCard } from '@excitedjs/feishu-transport'

/**
 * A single-card reply qualifies for the frame once its body crosses either
 * threshold; a reply split across more than one card always qualifies.
 */
const STYLE_MIN_LEAF_ELEMENTS = 4
const STYLE_MIN_BYTES = 600

const STYLED_HEADER_TEMPLATE = 'blue'
const PANEL_BORDER_COLOR = 'blue'
/** Generic title on the reply panel — short, content-agnostic. */
const COLLAPSIBLE_PANEL_TITLE = '**回复详情**'

interface MarkdownEl {
  tag: 'markdown'
  content: string
}
interface HrEl {
  tag: 'hr'
}
interface TableEl {
  tag: 'table'
  [k: string]: unknown
}
/** A leaf body element the renderer emits (table carries extra fields). */
type LeafEl = MarkdownEl | HrEl | TableEl

interface CollapsiblePanelEl {
  tag: 'collapsible_panel'
  expanded: boolean
  header: {
    title: { tag: 'markdown'; content: string }
    vertical_align: 'center'
  }
  border: { color: string; corner_radius: string }
  elements: LeafEl[]
}

/** Re-style a rendered reply (one or more cards) in place of the plain output. */
export function styleReplyCards(cards: RenderedCard[]): RenderedCard[] {
  if (!shouldStyle(cards)) return cards
  return cards.map((card) => toStyledCard(card))
}

/** Re-style a single rendered card (the edit path renders exactly one). */
export function styleReplyCard(card: RenderedCard): RenderedCard {
  return styleReplyCards([card])[0] as RenderedCard
}

/**
 * Decide whether a packed reply is large enough to warrant the collapsible
 * frame. A multi-card reply always qualifies (it is by definition long). A
 * single-card reply qualifies once its body crosses either threshold. The
 * empty always-emit-something card (one empty markdown element) never does.
 */
function shouldStyle(cards: RenderedCard[]): boolean {
  if (cards.length > 1) return true
  const card = cards[0]
  if (!card) return false
  const els = card.body.elements as unknown as LeafEl[]
  if (els.length === 0) return false
  if (els.length === 1 && els[0]?.tag === 'markdown' && !(els[0] as MarkdownEl).content.trim()) {
    return false
  }
  if (countLeafElements(els) >= STYLE_MIN_LEAF_ELEMENTS) return true
  return bodyContentBytes(els) >= STYLE_MIN_BYTES
}

/**
 * Wrap one packed card's body in a single `collapsible_panel` and tint the
 * header banner. An empty body is returned unchanged (a panel with no
 * children renders as an empty box); a card already carrying a panel is
 * returned unchanged. A table-bearing body is left at top level — a table
 * cannot live inside a panel — with the header still tinted.
 */
function toStyledCard(card: RenderedCard): RenderedCard {
  const els = card.body.elements as unknown as LeafEl[]
  if (els.length === 0) return card
  if (els.length === 1 && (els[0] as { tag: string }).tag === 'collapsible_panel') return card

  const hasTable = els.some((el) => el.tag === 'table')
  const bodyElements: Array<LeafEl | CollapsiblePanelEl> = hasTable
    ? els
    : [
        {
          tag: 'collapsible_panel',
          expanded: true,
          header: {
            title: { tag: 'markdown', content: COLLAPSIBLE_PANEL_TITLE },
            vertical_align: 'center',
          },
          border: { color: PANEL_BORDER_COLOR, corner_radius: '5px' },
          elements: els,
        },
      ]

  const styled: Record<string, unknown> = {
    schema: '2.0',
    config: { update_multi: true },
    body: { elements: bodyElements },
  }
  if (card.header) {
    styled.header = { ...card.header, template: STYLED_HEADER_TEMPLATE }
  }
  return styled as unknown as RenderedCard
}

/**
 * Count the leaf body elements Feishu tallies against the per-card element
 * cap, descending into a `collapsible_panel`'s children (the wrapper itself
 * does not shield its children from the count).
 */
function countLeafElements(elements: Array<LeafEl | CollapsiblePanelEl>): number {
  let n = 0
  for (const el of elements) {
    if (el.tag === 'collapsible_panel') n += countLeafElements(el.elements)
    else n += 1
  }
  return n
}

/** UTF-8 byte length of the textual content carried by a set of leaf elements. */
function bodyContentBytes(elements: LeafEl[]): number {
  let n = 0
  for (const el of elements) {
    if (el.tag === 'markdown') n += Buffer.byteLength(el.content, 'utf8')
    else if (el.tag === 'table') n += Buffer.byteLength(JSON.stringify(el), 'utf8')
  }
  return n
}
