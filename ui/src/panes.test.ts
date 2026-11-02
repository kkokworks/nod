import { expect, test } from 'bun:test'
import { clamp, moved, PANES, SHOW_STORED } from './panes'

test('a width stays between the narrowest and the widest, and the narrowest wins', () => {
  expect(clamp(300, 200, 420)).toBe(300)
  expect(clamp(120, 200, 420)).toBe(200)
  expect(clamp(900, 200, 420)).toBe(420)
  expect(clamp(300.6, 200, 420)).toBe(301)
  expect(clamp(300, 200, 150)).toBe(200)
})

test('dragging the edge widens the pane on its side and stops at the narrowest and the widest', () => {
  const { side, term } = PANES
  // The sidebar is at the left: right widens it, as far as its widest.
  expect(moved('side', 280, 40, 1400)).toBe(320)
  expect(moved('side', 280, -200, 1400)).toBe(side.min)
  expect(moved('side', 280, 500, 1400)).toBe(side.max)
  // The terminal is at the right: left widens it, as far as the page beside it keeps its narrowest.
  expect(moved('term', 500, -40, 1200)).toBe(540)
  expect(moved('term', 500, 400, 1200)).toBe(term.min)
  expect(moved('term', 500, -2000, 1200)).toBe(1200 - term.rest)
  // A box too small for both: the pane keeps its narrowest.
  expect(moved('term', 500, -100, 500)).toBe(term.min)
})

// The head's script, run as the page runs it, with this storage and a root element to set widths on.
function showStored(get: (key: string) => string | null): Record<string, string> {
  const set: Record<string, string> = {}
  const root = { style: { setProperty: (name: string, value: string) => (set[name] = value) } }
  new Function('localStorage', 'document', SHOW_STORED)({ getItem: get }, { documentElement: root })
  return set
}

test('the stored widths come back within their panes’ bounds, and anything else is the default', () => {
  const stored: Record<string, string> = {
    'nod-pane-width-side': '340',
    'nod-pane-width-term': '50',
  }
  expect(showStored((key) => stored[key] ?? null)).toEqual({
    '--side-w': '340px',
    '--term-w': '360px',
  })
  expect(showStored((key) => (key.endsWith('side') ? '9'.repeat(400) : null))).toEqual({
    '--side-w': `${PANES.side.max}px`,
  })
  for (const bad of [null, '', ' 340', '340px', '-340', '3.5e2', '340.5', 'NaN', 'Infinity']) {
    expect(showStored(() => bad)).toEqual({})
  }
  // A private window or blocked site data throws on reading.
  expect(
    showStored(() => {
      throw new DOMException('denied', 'SecurityError')
    }),
  ).toEqual({})
})
