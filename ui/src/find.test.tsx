import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { type Dispatch, type ReactNode, type SetStateAction, useState } from 'react'

// The box over a page drawn by React, in a DOM. A test double stands in for the highlight API, and
// `checkVisibility` is what a browser's says for these pages: docs/design.md has the real WebKit's.
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

class Marks extends Set<Range> {
  priority = 0
}
const registry = new Map<string, Marks>()
Object.assign(globalThis, { Highlight: Marks })
// happy-dom makes a new CSS object each time it is asked for one.
const CSS_CLASS = Object.getPrototypeOf(CSS)
CSS_CLASS.highlights = registry
Object.assign(Element.prototype, {
  checkVisibility(this: Element) {
    return this.closest('[hidden], details:not([open]) > :not(summary)') === null
  },
})
// As a browser computes them; happy-dom leaves them empty.
const inline = document.createElement('style')
inline.textContent = 'a, b { display: inline }'
document.head.append(inline)

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { FIND_EVENT, FindBar, findRanges, MOST, pattern, scrollBy, spots, stepped } = await import(
  './find'
)
const { bindKeys, ignoreOnPage, KEYS } = await import('./keys')

let setPage: Dispatch<SetStateAction<ReactNode>> = () => {}
function App({ first }: { first: ReactNode }) {
  const [page, set] = useState<ReactNode>(first)
  setPage = set
  return (
    <div className="app">
      <aside className="sidebar">
        <a href="/x">apple in the sidebar</a>
      </aside>
      <main className="main">{page}</main>
      <FindBar />
    </div>
  )
}

const PAGE = (
  <>
    <button type="button" id="before">
      a button
    </button>
    <p id="one">One apple</p>
    <p id="two">Two APPLES and an apple</p>
  </>
)

let view: ReturnType<typeof createRoot>
const settle = () => act(() => new Promise((done) => setTimeout(done, 5)))

beforeEach(async () => {
  registry.clear()
  window.scrollTo(0, 0)
  view = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => view.render(<App first={PAGE} />))
})
afterEach(() => {
  act(() => view.unmount())
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined, Highlight: undefined })
})

const bar = () => document.querySelector('.find-bar')
const box = () => document.querySelector<HTMLInputElement>('.find-bar input')
const count = () => document.querySelector('.find-count')?.textContent
const marked = () => [...(registry.get('nod-find') ?? [])].map(String)
const here = () => [...(registry.get('nod-find-current') ?? [])]
const hereIn = () => here()[0]?.startContainer.parentElement?.id

const callFind = () => act(() => window.dispatchEvent(new Event(FIND_EVENT)))
// As typing does: React sees the change only through the element's own setter and an input event.
function put(value: string) {
  const input = box()
  if (input === null) throw new Error('no box')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const type = (value: string) => act(() => put(value))
const composition = (name: 'compositionstart' | 'compositionend') =>
  act(() => box()?.dispatchEvent(new CompositionEvent(name, { bubbles: true })))
// keyCode is 229 for a key the input method took.
function key(
  name: 'keydown' | 'keyup',
  init: KeyboardEventInit & { keyCode?: number },
  on: Element | null = document.activeElement,
) {
  const event = new KeyboardEvent(name, { bubbles: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode ?? 0 })
  act(() => on?.dispatchEvent(event))
}
const enter = (init: KeyboardEventInit & { keyCode?: number } = {}) =>
  key('keydown', { key: 'Enter', code: 'Enter', ...init })
const esc = (init: KeyboardEventInit & { keyCode?: number } = {}) =>
  key('keydown', { key: 'Escape', code: 'Escape', ...init })

test('a query is matched as written, whatever its case or the spaces the page has', () => {
  const at = (text: string, query: string) => {
    const wanted = pattern(query)
    if (wanted === null) return null
    return [...text.matchAll(wanted)].map((m) => [m.index, m[0]])
  }
  expect(at('Apple apple APPLE', 'aPPle')).toEqual([
    [0, 'Apple'],
    [6, 'apple'],
    [12, 'APPLE'],
  ])
  expect(at('aaaa', 'aa')).toEqual([
    [0, 'aa'],
    [2, 'aa'],
  ])
  // What a regular expression would take for its own.
  expect(at('a.c abc (x)* a/b [y] ^$\\', 'a.c')).toEqual([[0, 'a.c']])
  for (const special of ['(x)*', 'a/b', '[y]', '^$\\', '{2}', '-', '|', '?', '+']) {
    expect(at(`<${special}>`, special)).toEqual([[1, special]])
  }
  // A line break or several spaces read as one in the page.
  expect(at('one\n  two', 'one two')).toEqual([[0, 'one\n  two']])
  // Hangul, whichever way the page or the query has it.
  const nfd = '한글'.normalize('NFD')
  expect(at(`a ${nfd} b`, '한글')).toEqual([[2, nfd]])
  expect(at('a 한글 b', nfd)).toEqual([[2, '한글']])
  expect(at('한글 찾기', '글 찾')).toEqual([[1, '글 찾']])
  // No letter is cut in two when a pair of UTF-16 units makes it.
  expect(at('😀😀', '😀')).toEqual([
    [0, '😀'],
    [2, '😀'],
  ])
  for (const blank of ['', ' ', ' \n\t']) expect(pattern(blank)).toBeNull()
})

test('a match over several text nodes starts and ends where its letters are', () => {
  const parts = [{ data: 'One ' }, { data: '' }, { data: 'bold' }, { data: ' word, bold' }]
  const [one, , bold, rest] = parts
  const wanted = (query: string) => {
    const re = pattern(query)
    if (re === null) throw new Error(query)
    return spots(parts, re)
  }
  expect(wanted('e bold w')).toEqual([{ from: [one, 2], to: [rest, 2] }] as never)
  // At a seam: it starts in the later node and ends in the earlier one.
  expect(wanted('bold')).toEqual([
    { from: [bold, 0], to: [bold, 4] },
    { from: [rest, 7], to: [rest, 11] },
  ] as never)
  expect(wanted('One ')).toEqual([{ from: [one, 0], to: [one, 4] }] as never)
  expect(wanted('nothing')).toEqual([])
})

test('the page is searched as it reads: what shows, and not across a line', async () => {
  await act(async () =>
    setPage(
      <>
        <p>
          3 <b>bo</b>ld tasks
        </p>
        <p>ends here</p>
        <p>starts there</p>
        <p>
          left
          <br />
          right
        </p>
        <p hidden>hidden word</p>
        <details>
          <summary>summary word</summary>
          <p>folded word</p>
        </details>
        <div className="xterm">screen word</div>
        <textarea defaultValue="field word" />
        <select>
          <option>option word</option>
        </select>
      </>,
    ),
  )
  const found = (query: string) => findRanges(query).map(String)
  expect(found('3 bold tasks')).toEqual(['3 bold tasks'])
  expect(found('here starts')).toEqual([])
  expect(found('hereStarts')).toEqual([])
  expect(found('leftright')).toEqual([])
  expect(found('word')).toEqual(['word'])
  expect(findRanges('word')[0]?.startContainer.parentElement?.tagName).toBe('SUMMARY')
})

test('it stops at the most it marks, and says so', async () => {
  await act(async () => setPage(<p>{'x '.repeat(MOST + 50)}</p>))
  await callFind()
  await type('x')
  expect(marked()).toHaveLength(MOST)
  expect(count()).toBe(`1 / ${MOST}+`)
})

test('the box opens only for the app’s event, not for ⌘F itself', async () => {
  key('keydown', { key: 'f', code: 'KeyF', metaKey: true }, document.body)
  await settle()
  expect(bar()).toBeNull()
  await callFind()
  expect(bar()).not.toBeNull()
  expect(document.activeElement).toBe(box())
})

test('typing marks every match and the first on the page is current, without touching the DOM', async () => {
  const drawn = document.querySelector('.main')?.innerHTML
  await callFind()
  await type('apple')
  expect(marked()).toEqual(['apple', 'apple', 'APPLE', 'apple'])
  expect(count()).toBe('2 / 4')
  expect(hereIn()).toBe('one')
  expect(registry.get('nod-find-current')?.priority).toBeGreaterThan(
    registry.get('nod-find')?.priority ?? 0,
  )
  expect(document.querySelector('.main')?.innerHTML).toBe(drawn)

  await type('pear')
  expect(marked()).toEqual([])
  expect(here()).toEqual([])
  expect(count()).toBe('No match')

  // Back to no query: no count at all.
  await type('')
  expect(count()).toBe('')
})

test('Enter goes on, Shift+Enter back, and each comes around at the end', async () => {
  expect([stepped(0, 3, 1), stepped(2, 3, 1), stepped(0, 3, -1), stepped(1, 3, -1)]).toEqual([
    1, 0, 2, 0,
  ])
  await callFind()
  await type('apple')
  expect(count()).toBe('2 / 4')
  enter()
  expect(count()).toBe('3 / 4')
  expect(hereIn()).toBe('two')
  enter()
  expect(count()).toBe('4 / 4')
  enter()
  expect(count()).toBe('1 / 4')
  expect(here()[0]?.startContainer.parentElement?.tagName).toBe('A')
  enter({ shiftKey: true })
  expect(count()).toBe('4 / 4')
  enter({ shiftKey: true })
  expect(count()).toBe('3 / 4')
  // Enter with nothing found does nothing.
  await type('pear')
  enter()
  expect(count()).toBe('No match')
})

test('nothing is looked for while a syllable is being composed', async () => {
  await callFind()
  await composition('compositionstart')
  await type('ap')
  await type('app')
  expect(marked()).toEqual([])
  expect(count()).toBe('')
  // A refresh mid-way leaves what is being composed alone.
  await act(async () => setPage(<p>an apple</p>))
  await settle()
  expect(box()?.value).toBe('app')
  expect(marked()).toEqual([])
  // As WebKit does it: the composition ends, then the text's last input event comes.
  await composition('compositionend')
  expect(marked()).toEqual(['app', 'app'])
  await type('app')
  expect(count()).toBe('2 / 2')
})

test('the Enter that finishes a syllable goes nowhere, and the next one does', async () => {
  await callFind()
  await type('apple')
  expect(count()).toBe('2 / 4')
  // Mid-composition, as the page sees it in WebKit: composing, and the input method took the key.
  await composition('compositionstart')
  enter({ keyCode: 229, isComposing: true })
  expect(count()).toBe('2 / 4')
  // WebKit ends the composition before the keydown of the key that ended it.
  await composition('compositionend')
  enter({ keyCode: 229 })
  key('keyup', { key: 'Enter', code: 'Enter' })
  expect(count()).toBe('2 / 4')
  enter()
  expect(count()).toBe('3 / 4')
  // The input method can take it with nothing composed too.
  enter({ keyCode: 229 })
  expect(count()).toBe('3 / 4')
})

test('a syllable ended by something other than a key costs no later key anything', async () => {
  // Clicking away from the box ends a composition with no key to go with it.
  await callFind()
  await type('apple')
  await composition('compositionstart')
  await composition('compositionend')
  enter()
  expect(count()).toBe('3 / 4')
  await composition('compositionstart')
  await composition('compositionend')
  esc()
  expect(bar()).toBeNull()
})

test('Esc takes the marks off, closes the box and gives the keyboard back', async () => {
  const before = document.querySelector<HTMLElement>('#before')
  before?.focus()
  await callFind()
  await type('apple')
  expect(document.activeElement).toBe(box())
  expect(marked()).toHaveLength(4)
  esc()
  await settle()
  expect(bar()).toBeNull()
  expect(registry.size).toBe(0)
  expect(document.activeElement).toBe(before)
  // It opens empty.
  await callFind()
  expect(box()?.value).toBe('')
  expect(count()).toBe('')
})

test('the × does the same, and with no focus before it the keyboard is simply let go', async () => {
  await callFind()
  await type('apple')
  await act(async () => document.querySelector<HTMLElement>('.find-close')?.click())
  expect(bar()).toBeNull()
  expect(registry.size).toBe(0)
  expect(document.activeElement).toBe(document.body)
})

test('a focus target gone from the page does not stop the box closing', async () => {
  document.querySelector<HTMLElement>('#before')?.focus()
  await callFind()
  await act(async () => setPage(<p>an apple</p>))
  esc()
  expect(bar()).toBeNull()
  expect(document.activeElement).toBe(document.body)
})

test('the Esc that finishes a syllable leaves the box open, and the next one closes it', async () => {
  await callFind()
  await composition('compositionstart')
  await type('app')
  esc({ isComposing: true })
  expect(bar()).not.toBeNull()
  await composition('compositionend')
  esc({ keyCode: 229 })
  key('keyup', { key: 'Escape', code: 'Escape' })
  expect(bar()).not.toBeNull()
  expect(box()?.value).toBe('app')
  esc()
  expect(bar()).toBeNull()
})

test('Esc gets through however WebKit hands it over', async () => {
  // The input method took the key, with nothing being composed.
  await callFind()
  esc({ keyCode: 229 })
  expect(bar()).toBeNull()
  // Its keydown never reached the page, as in the capture window (docs/design.md).
  await callFind()
  key('keyup', { key: 'Escape', code: 'Escape' })
  expect(bar()).toBeNull()
  // A key up for any other key does not close it.
  await callFind()
  key('keyup', { key: 'a', code: 'KeyA' })
  expect(bar()).not.toBeNull()
  // From the box's other field too.
  document.querySelector<HTMLElement>('.find-close')?.focus()
  esc()
  expect(bar()).toBeNull()
})

test('⌘F with the box open selects its text and keeps what it found', async () => {
  await callFind()
  await type('apple')
  enter()
  const input = box()
  await act(async () => document.querySelector<HTMLElement>('#before')?.focus())
  expect(document.activeElement).not.toBe(input)
  await callFind()
  expect(box()).toBe(input)
  expect(document.activeElement).toBe(input)
  expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 5])
  expect(count()).toBe('3 / 4')
})

test('a refresh keeps the box, its text and the current match, and marks what is new', async () => {
  const scrolled = spyOn(Range.prototype, 'getBoundingClientRect')
  await callFind()
  await type('apple')
  enter()
  expect(hereIn()).toBe('two')
  const input = box()
  const before = scrolled.mock.calls.length
  await act(async () =>
    setPage(
      <>
        <button type="button" id="before">
          a button
        </button>
        <p id="one">One apple and one more apple</p>
        <p id="two">Two APPLES and an apple</p>
        <p id="new">A new apple</p>
      </>,
    ),
  )
  await settle()
  expect(box()).toBe(input)
  expect(input?.value).toBe('apple')
  expect(document.activeElement).toBe(input)
  // React keeps the node of the second paragraph, so its match stays current.
  expect(marked()).toHaveLength(6)
  expect(count()).toBe('4 / 6')
  expect(hereIn()).toBe('two')
  expect(here()[0]?.startOffset).toBe(4)
  // Nobody asked to go anywhere, so the page stays where it is being read.
  expect(scrolled.mock.calls.length).toBe(before)
  scrolled.mockRestore()
})

test('the current match going away, as when a link moves on, starts over on what is there', async () => {
  await callFind()
  await type('apple')
  enter()
  await act(async () => setPage(<p id="other">Another page, another apple</p>))
  await settle()
  expect(box()?.value).toBe('apple')
  expect(marked()).toEqual(['apple', 'apple'])
  expect(count()).toBe('2 / 2')
  expect(hereIn()).toBe('other')
  // Opening a fold shows what it held.
  await act(async () =>
    setPage(
      <details id="fold">
        <summary>fold</summary>
        <p id="inside">folded apple</p>
      </details>,
    ),
  )
  await settle()
  expect(count()).toBe('1 / 1')
  await act(async () => document.querySelector('#fold')?.setAttribute('open', ''))
  await settle()
  // The sidebar's match, the only one there was, stays current.
  expect(count()).toBe('1 / 2')
  enter()
  expect(hereIn()).toBe('inside')
})

test('the box’s own count and the terminal changing do not search again', async () => {
  await act(async () => setPage(<div className="xterm">rows</div>))
  await callFind()
  await type('apple')
  const before = registry.get('nod-find')
  document.querySelector('.xterm')?.setAttribute('class', 'xterm focus')
  await settle()
  expect(registry.get('nod-find')).toBe(before)
  // Its own marks stay until there is something new to mark.
  enter()
  await settle()
  expect(count()).toBe('1 / 1')
})

test('the page’s one-letter keys stay out of what is typed in the box', async () => {
  let helped = 0
  const unbind = bindKeys(window, { help: () => helped++ }, ignoreOnPage)
  const help = { key: '?', code: 'Slash', shiftKey: true }
  key('keydown', help, document.body)
  expect(helped).toBe(1)
  await callFind()
  key('keydown', help)
  expect(helped).toBe(1)
  unbind()
})

test('with no highlight API every match gets boxes, and it goes from match to match', async () => {
  Reflect.deleteProperty(CSS_CLASS, 'highlights')
  const inView = spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() =>
    rect(10, 100, 50, 120),
  )
  const lines = spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => [rect(10, 20, 50, 40)] as unknown as DOMRectList,
  )
  try {
    await callFind()
    await type('apple')
    enter()
    expect(count()).toBe('3 / 4')
    expect(overBoxes().map(([name]) => name)).toEqual([
      'find-mark',
      'find-mark',
      'find-mark current',
      'find-mark',
    ])
    esc()
    expect(bar()).toBeNull()
  } finally {
    lines.mockRestore()
    inView.mockRestore()
    CSS_CLASS.highlights = registry
  }
})

// A rectangle as the browser gives a range's or element's: happy-dom lays nothing out.
const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
const overBoxes = () =>
  [...document.querySelectorAll<HTMLElement>('.find-marks .find-mark')].map((b) => [
    b.className,
    b.style.left,
    b.style.top,
    b.style.width,
    b.style.height,
  ])

test('text a highlight cannot paint gets boxes over it, and none is left when the box closes', async () => {
  const inView = spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() =>
    rect(10, 100, 50, 120),
  )
  const lines = spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => [rect(10, 20, 50, 40)] as unknown as DOMRectList,
  )
  try {
    await act(async () =>
      setPage(
        <>
          <button type="button">apple in a button</button>
          <div style={{ display: 'flex' }}>apple in a flex box</div>
          <div>
            apple beside a block<p>a block</p>
          </div>
          <p>
            apple in a paragraph <b>with a bold word</b> and <a href="/x">the next page</a>
          </p>
        </>,
      ),
    )
    await callFind()
    await type('apple')
    // The sidebar's link and the paragraph are painted by the highlight, so they are left out.
    expect(marked()).toHaveLength(5)
    expect(count()).toBe('2 / 5')
    const here = ['find-mark current', '10px', '20px', '40px', '20px']
    const other = ['find-mark', '10px', '20px', '40px', '20px']
    expect(overBoxes()).toEqual([here, other, other])
    enter()
    expect(overBoxes()).toEqual([other, here, other])
    // The fourth is the paragraph: its mark is the highlight, and no box is current.
    enter()
    enter()
    expect(hereIn()).toBe('')
    expect(overBoxes()).toEqual([other, other, other])
    esc()
    expect(document.querySelector('.find-marks')).toBeNull()
  } finally {
    lines.mockRestore()
    inView.mockRestore()
  }
})

test('a box over text stays within the window and what clips the text, and follows scrolling', async () => {
  let line = rect(150, 20, 300, 40)
  const inView = spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() =>
    rect(10, 100, 50, 120),
  )
  const lines = spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => [line] as unknown as DOMRectList,
  )
  try {
    await act(async () =>
      setPage(
        <div id="clip" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
          <button type="button">apple cut off</button>
        </div>,
      ),
    )
    const clip = document.querySelector('#clip')
    if (clip === null) throw new Error('no clip')
    const clipped = spyOn(clip, 'getBoundingClientRect').mockImplementation(() =>
      rect(100, 0, 200, 100),
    )
    await callFind()
    await type('apple')
    expect(overBoxes()).toEqual([['find-mark current', '150px', '20px', '50px', '20px']])
    // Scrolled out of what clips it: no box.
    line = rect(250, 20, 300, 40)
    window.dispatchEvent(new Event('scroll'))
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    expect(overBoxes()).toEqual([])
    // Back, and resizing the window draws too.
    line = rect(110, 20, 130, 40)
    window.dispatchEvent(new Event('resize'))
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    expect(overBoxes()).toEqual([['find-mark current', '110px', '20px', '20px', '20px']])
    // Outside the window.
    clipped.mockImplementation(() => rect(0, 0, 100000, 100000))
    line = rect(50, innerHeight + 10, 80, innerHeight + 30)
    window.dispatchEvent(new Event('scroll'))
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
    expect(overBoxes()).toEqual([])
  } finally {
    lines.mockRestore()
    inView.mockRestore()
  }
})

test('a box scrolls only if the match is out of its view, and to its middle', () => {
  // In view.
  expect(scrollBy(100, 110, 0, 500, 0)).toBe(0)
  // Above, or under the find box at the top of the window.
  expect(scrollBy(-50, -40, 0, 500, 0)).toBe(-295)
  expect(scrollBy(30, 40, 0, 500, 60)).toBe(-215)
  // Below.
  expect(scrollBy(800, 810, 0, 500, 0)).toBe(555)
  // A box not at the top of the window.
  expect(scrollBy(150, 160, 100, 200, 0)).toBe(0)
  expect(scrollBy(190, 210, 100, 200, 0)).toBe(50)
  expect(scrollBy(90, 100, 100, 200, 0)).toBe(-55)
})

test('the app’s menu sends the event the page takes, and the help lists the key', () => {
  const main = readFileSync(new URL('../../desktop/src-tauri/src/main.rs', import.meta.url), 'utf8')
  expect(main).toContain(`new Event('${FIND_EVENT}')`)
  expect(main).toContain('"찾기…", true, Some("CmdOrCtrl+F")')
  expect(KEYS.find.show).toEqual(['⌘F'])
  expect(KEYS.find.bind).toEqual([])
})
