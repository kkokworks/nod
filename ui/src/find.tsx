import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'

// What the app sends the page for ⌘F (its 찾기… menu item, main.rs): the box opens, or if it is open
// its text is selected. A browser never sends it, so there ⌘F stays the browser's own.
export const FIND_EVENT = 'nod-find'

// The marks, as styles.css names them. CSS Custom Highlight ranges put no element in the text React
// draws, so a refresh has nothing of ours to trip on, and the page's DOM stays as it was.
const MARKS = 'nod-find'
const CURRENT = 'nod-find-current'

// Not searched: this box and its marks, the terminal (xterm draws on a canvas), and what a field
// holds, whose text is no text node and which a highlight cannot mark.
const UNSEARCHED = '.find-bar, .find-marks, .xterm, select, textarea'

// ponytail: stops at this many. Each change to the DOM goes over every live range: 200 changes took
// about 35 ms with 5000 ranges and up to 230 ms with 20000 (docs/design.md). Past it the count says
// `5000+` and the rest are not reached.
export const MOST = 5000

// The box covers about this much of the top of the window, so a match under it counts as out of view.
const UNDER_BOX = 60

const literal = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

// A letter that also comes apart (Hangul in a macOS file name is NFD) matches both ways, spaces match
// however the page breaks or collapses them, and case does not count. Null for nothing to look for.
export function pattern(query: string): RegExp | null {
  if (query.trim() === '') return null
  const letter = (c: string) => {
    const apart = c.normalize('NFD')
    return apart === c ? literal(c) : `(?:${literal(c)}|${literal(apart)})`
  }
  const words = query.normalize('NFC').split(/\s+/)
  return new RegExp(words.map((w) => [...w].map(letter).join('')).join('\\s+'), 'giu')
}

type Part = { data: string }
export type Spot<T extends Part> = { from: [T, number]; to: [T, number] }

// Where an offset into the parts' joined text falls. At the seam of two parts it is the start of the
// later one, or the end of the earlier one for the end of a match.
function place<T extends Part>(parts: T[], offset: number, isEnd: boolean): [T, number] {
  let left = offset
  for (const part of parts) {
    if (left < part.data.length || (isEnd && left === part.data.length)) return [part, left]
    left -= part.data.length
  }
  throw new Error(`offset ${offset} is past the text`)
}

// Each match in a stretch of text that reads as one but is split over parts (text nodes).
export function spots<T extends Part>(parts: T[], query: RegExp): Spot<T>[] {
  return [
    ...parts
      .map((p) => p.data)
      .join('')
      .matchAll(query),
  ].map((m) => ({
    from: place(parts, m.index, false),
    to: place(parts, m.index + m[0].length, true),
  }))
}

// The box around the element's text: an inline element's text runs on into what is beside it.
function blockOf(el: Element): Element {
  let at = el
  while (at.parentElement !== null && getComputedStyle(at).display === 'inline') {
    at = at.parentElement
  }
  return at
}

// The visible text under root in the stretches it reads in: a match may cross into a bold word, or
// from `{n}` into ` tasks`, but not from one line of a list to the next.
function stretches(root: Element): Text[][] {
  const all: Text[][] = []
  let stretch: Text[] = []
  let block: Element | null = null
  const end = () => {
    if (stretch.length > 0) all.push(stretch)
    stretch = []
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT
      if (node.matches(UNSEARCHED)) return NodeFilter.FILTER_REJECT
      return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (!(node instanceof Text)) {
      end()
      continue
    }
    // Not shown: display: none, and what a closed <details> holds. The option is the old name for
    // visibility: hidden, which WebKit has had as long as the method.
    const parent = node.parentElement
    if (parent === null || parent.checkVisibility?.({ checkVisibilityCSS: true }) === false) {
      continue
    }
    const around = blockOf(parent)
    if (around !== block) end()
    block = around
    stretch.push(node)
  }
  end()
  return all
}

export function findRanges(query: string): Range[] {
  const wanted = pattern(query)
  const ranges: Range[] = []
  if (wanted === null) return ranges
  for (const stretch of stretches(document.body)) {
    for (const { from, to } of spots(stretch, wanted)) {
      if (ranges.length === MOST) return ranges
      const range = document.createRange()
      range.setStart(...from)
      range.setEnd(...to)
      ranges.push(range)
    }
  }
  return ranges
}

export const stepped = (index: number, total: number, by: 1 | -1): number =>
  (index + by + total) % total

// WebKit paints a highlight with the style of the box around the text, and text with no element of
// its own in a box has none: bare text in a button, a flex or grid box, or beside blocks. So does
// any text without the API (WebKit before Safari 17.2). These get boxes drawn over them, boxesOver.
function isBare(range: Range): boolean {
  const el = range.startContainer.parentElement
  if (el === null) return false
  return (
    !('highlights' in CSS) ||
    el.tagName === 'BUTTON' ||
    /flex|grid/.test(getComputedStyle(el).display) ||
    [...el.children].some((c) => !/^(inline|contents|none)/.test(getComputedStyle(c).display))
  )
}

// The boxes over a match, for its lines, where they show: in the window and in the boxes around it
// that cut off what overflows, as a highlight would be. In the document's coordinates, so that they
// scroll with it (marks in the page itself move with it, only a sticky sidebar's wait for a redraw).
function boxesOver(range: Range, current: boolean): HTMLElement[] {
  const lines = [...range.getClientRects()].filter(
    (l) => l.right > 0 && l.left < innerWidth && l.bottom > 0 && l.top < innerHeight,
  )
  if (lines.length === 0) return []
  const around: DOMRect[] = []
  for (let el = range.startContainer.parentElement; el !== null; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el)
    const clips = /auto|scroll|hidden|clip/.test(`${overflowX} ${overflowY}`)
    if (clips && el !== document.scrollingElement) around.push(el.getBoundingClientRect())
  }
  const boxes: HTMLElement[] = []
  for (const line of lines) {
    const left = Math.max(line.left, 0, ...around.map((b) => b.left))
    const top = Math.max(line.top, 0, ...around.map((b) => b.top))
    const right = Math.min(line.right, innerWidth, ...around.map((b) => b.right))
    const bottom = Math.min(line.bottom, innerHeight, ...around.map((b) => b.bottom))
    if (right <= left || bottom <= top) continue
    const box = document.createElement('div')
    box.className = current ? 'find-mark current' : 'find-mark'
    box.style.cssText = `left:${left + scrollX}px;top:${top + scrollY}px;width:${right - left}px;height:${bottom - top}px`
    boxes.push(box)
  }
  return boxes
}

function paint(ranges: Range[], index: number): void {
  if (!('highlights' in CSS)) return
  const marks = new Highlight()
  for (const range of ranges) marks.add(range)
  const current = new Highlight()
  const here = ranges[index]
  if (here !== undefined) current.add(here)
  current.priority = 1
  CSS.highlights.set(MARKS, marks)
  CSS.highlights.set(CURRENT, current)
}

function unpaint(): void {
  if (!('highlights' in CSS)) return
  CSS.highlights.delete(MARKS)
  CSS.highlights.delete(CURRENT)
}

// How far to scroll a box along one axis for the match to stand in its middle; 0 if it is in view.
export function scrollBy(
  from: number,
  to: number,
  start: number,
  end: number,
  gap: number,
): number {
  return from < start + gap || to > end ? (from + to) / 2 - (start + end) / 2 : 0
}

// Scrolls every box around the range that scrolls: scrollIntoView takes elements, and the element
// around a match can be taller than the window. Only auto and scroll: script can also scroll
// overflow: hidden, which would shift a line of the sidebar cut off with an ellipsis for good. Past
// a sticky or fixed box (the sidebar) nothing scrolling moves the match, so it stops there.
function reveal(range: Range): void {
  const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll'
  const root = document.scrollingElement
  for (let el = range.startContainer.parentElement; el !== null; el = el.parentElement) {
    const isRoot = el === root
    const { overflowX, overflowY, position } = getComputedStyle(el)
    const box = isRoot
      ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
      : el.getBoundingClientRect()
    const at = range.getBoundingClientRect()
    if (isRoot || scrolls(overflowY)) {
      el.scrollTop += scrollBy(at.top, at.bottom, box.top, box.bottom, isRoot ? UNDER_BOX : 0)
    }
    if (isRoot || scrolls(overflowX)) {
      el.scrollLeft += scrollBy(at.left, at.right, box.left, box.right, 0)
    }
    if (position === 'sticky' || position === 'fixed') return
  }
}

// A match in the page proper goes before one in the sidebar, which comes first in the document.
function firstInPage(ranges: Range[]): number {
  const main = document.querySelector('.main')
  return Math.max(
    0,
    ranges.findIndex((r) => main?.contains(r.startContainer)),
  )
}

type Found = { query: string; ranges: Range[]; index: number }

// One opening of the box: what it found and which is current, kept and marked as the page changes.
function finder(changed: (found: Found) => void, marks: RefObject<HTMLElement | null>) {
  let found: Found = { query: '', ranges: [], index: 0 }
  let bare: Range[] = []
  const draw = () => {
    const here = found.ranges[found.index]
    marks.current?.replaceChildren(...bare.flatMap((r) => boxesOver(r, r === here)))
  }
  let frame = 0
  const drawSoon = () => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      draw()
    })
  }
  const show = (next: Found, scroll: boolean) => {
    if (next.ranges !== found.ranges) bare = next.ranges.filter(isBare)
    found = next
    paint(next.ranges, next.index)
    changed(next)
    const here = next.ranges[next.index]
    if (scroll && here !== undefined) reveal(here)
    draw()
  }
  // The refreshes draw the page anew (__root.tsx) and a link moves to another: the same match stays
  // current if it is still there, else it starts over as on a new search, in both cases where the
  // person is reading. The box's own count and the terminal's screen change too often to matter.
  const observer = new MutationObserver((records) => {
    const onPage = records.some((r) => {
      const el = r.target instanceof Element ? r.target : r.target.parentElement
      return el?.closest(UNSEARCHED) == null
    })
    if (!onPage || pattern(found.query) === null) return
    const was = found.ranges[found.index]
    const ranges = findRanges(found.query)
    const same = ranges.findIndex(
      (r) => r.startContainer === was?.startContainer && r.startOffset === was?.startOffset,
    )
    show({ query: found.query, ranges, index: same >= 0 ? same : firstInPage(ranges) }, false)
  })
  return {
    search(query: string) {
      if (query === found.query) return
      const ranges = findRanges(query)
      show({ query, ranges, index: firstInPage(ranges) }, true)
    },
    step(by: 1 | -1) {
      const total = found.ranges.length
      if (total > 0) show({ ...found, index: stepped(found.index, total, by) }, true)
    },
    // For an effect: looks at the page until the cleanup, which takes the marks off.
    watch() {
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'open', 'style'],
      })
      window.addEventListener('scroll', drawSoon, { capture: true, passive: true })
      window.addEventListener('resize', drawSoon)
      return () => {
        observer.disconnect()
        window.removeEventListener('scroll', drawSoon, { capture: true })
        window.removeEventListener('resize', drawSoon)
        cancelAnimationFrame(frame)
        frame = 0
        unpaint()
      }
    },
  }
}

const countOf = ({ query, ranges, index }: Found): string => {
  if (pattern(query) === null) return ''
  if (ranges.length === 0) return 'No match'
  return `${index + 1} / ${ranges.length}${ranges.length === MOST ? '+' : ''}`
}

function Box({ input, close }: { input: RefObject<HTMLInputElement | null>; close: () => void }) {
  const [found, setFound] = useState<Found>({ query: '', ranges: [], index: 0 })
  const marks = useRef<HTMLDivElement>(null)
  const [find] = useState(() => finder(setFound, marks))
  // Only finished text is looked for, and the Enter or Esc that finishes a syllable does nothing
  // else. WebKit ends a composition before that key's keydown, which then has keyCode 229 for "the
  // input method took it", as capture.js has it. For Esc that alone does not say a syllable ended (an
  // input method may take it with nothing composed, docs/design.md), so `ended` says so until the
  // keyup of that key.
  const composing = useRef(false)
  const ended = useRef(false)
  useEffect(() => {
    input.current?.focus()
    return find.watch()
  }, [find, input])
  const isEscape = (e: KeyboardEvent) => e.key === 'Escape' || e.code === 'Escape'
  return (
    <>
      <div className="find-marks" ref={marks} />
      <search
        className="find-bar"
        onKeyDown={(e) => {
          if (composing.current || e.nativeEvent.isComposing) return
          const tookIt = e.keyCode === 229
          if (isEscape(e)) {
            if (tookIt && ended.current) return
            e.preventDefault()
            close()
          } else if (e.key === 'Enter' && e.target === input.current && !tookIt) {
            e.preventDefault()
            find.step(e.shiftKey ? -1 : 1)
          }
        }}
        onKeyUp={(e) => {
          const wasEnded = ended.current
          ended.current = false
          // A keydown handled by the input method did not get to the capture window's page as
          // Escape (docs/design.md, the desktop app, 6); its keyup does not go by the input method.
          if (isEscape(e) && !wasEnded && !composing.current) close()
        }}
      >
        <input
          ref={input}
          aria-label="Find on this page"
          placeholder="Find on this page"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            if (!composing.current) find.search(e.target.value)
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(e) => {
            composing.current = false
            ended.current = true
            find.search(e.currentTarget.value)
          }}
        />
        <span className="find-count" role="status">
          {countOf(found)}
        </span>
        <button type="button" className="find-close" aria-label="Close find" onClick={close}>
          ×
        </button>
      </search>
    </>
  )
}

// The find box of the desktop app, drawn beside the page and so kept as the page refreshes or moves.
// Closing it takes the marks off and gives the keyboard back to where it was.
export function FindBar() {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const before = useRef<Element | null>(null)
  useEffect(() => {
    const called = () => {
      if (input.current === null) {
        before.current = document.activeElement
        setOpen(true)
        return
      }
      input.current.focus()
      input.current.select()
    }
    window.addEventListener(FIND_EVENT, called)
    return () => window.removeEventListener(FIND_EVENT, called)
  }, [])
  if (!open) return null
  return (
    <Box
      input={input}
      close={() => {
        setOpen(false)
        // Not scrolling back to it: the person stays at what they found.
        if (before.current instanceof HTMLElement) before.current.focus({ preventScroll: true })
      }}
    />
  )
}
