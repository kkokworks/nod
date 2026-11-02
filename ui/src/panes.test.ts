import { expect, test } from 'bun:test'
import { clamp, moved, PANES, stored } from './panes'

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

const storage = (value: string | null | Error) => ({
  getItem: (key: string) => {
    if (value instanceof Error) throw value
    return key.endsWith('side') ? value : null
  },
})

test('a stored width comes back within its pane’s bounds, and anything else is the default', () => {
  expect(stored('side', storage('340'))).toBe(340)
  expect(stored('term', storage('340'))).toBeNull()
  expect(stored('side', storage('50'))).toBe(PANES.side.min)
  expect(stored('side', storage('9'.repeat(400)))).toBe(PANES.side.max)
  for (const bad of [null, '', ' 340', '340px', '-340', '3.5e2', 'NaN', 'Infinity']) {
    expect(stored('side', storage(bad))).toBeNull()
  }
  // A private window or blocked site data throws on reading.
  expect(stored('side', storage(new DOMException('denied', 'SecurityError')))).toBeNull()
  // No storage at all, as on the server.
  expect(stored('side')).toBeNull()
})
