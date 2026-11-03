import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
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
const UNSHOWN = '[hidden], .gone, [style*="display: none"], details:not([open]) > :not(summary)'
Object.assign(Element.prototype, {
  checkVisibility(this: Element) {
    return this.closest(UNSHOWN) === null
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
const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))

beforeEach(async () => {
  registry.clear()
  CSS_CLASS.highlights = registry
  // As a browser has it: happy-dom has no popovers.
  Object.assign(HTMLElement.prototype, { showPopover() {} })
  // In view: happy-dom lays nothing out, and text of no width is behind an ellipsis.
  matchesAt(rect(10, 100, 50, 120))
  window.scrollTo(0, 0)
  view = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => view.render(<App first={PAGE} />))
})
afterEach(() => {
  act(() => view.unmount())
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  mock.restore()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined, Highlight: undefined })
})

// Asked as yes or no: a failing expect on an element prints all of happy-dom's tree for a long time.
const isOpen = () => document.querySelector('.find-bar') !== null
const focused = (el: Element | null) => document.activeElement === el
const box = () => document.querySelector<HTMLInputElement>('.find-bar input')
const count = () => document.querySelector('.find-count')?.textContent
const marked = () => [...(registry.get('nod-find') ?? [])].map(String)
const here = () => [...(registry.get('nod-find-current') ?? [])]
const hereIn = () => here()[0]?.startContainer.parentElement?.id
const byId = (id: string) => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`no ${id}`)
  return el
}

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
const escUp = () => key('keyup', { key: 'Escape', code: 'Escape' })

// A rectangle as the browser gives a range's or element's: happy-dom lays nothing out.
const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect
// Where every match is taken to be, as a whole and by its lines.
const matchesAt = (at: DOMRect, lines: () => DOMRect[] = () => []) => {
  spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => at)
  spyOn(Range.prototype, 'getClientRects').mockImplementation(
    () => lines() as unknown as DOMRectList,
  )
}
const boxAt = (id: string, at: DOMRect) =>
  spyOn(byId(id), 'getBoundingClientRect').mockImplementation(() => at)
// What the page finds asking for an open menu, which happy-dom has no way to tell.
function spyOnPopoverOpen(answer: () => Element | null) {
  const query = document.querySelector.bind(document)
  return spyOn(document, 'querySelector').mockImplementation(((selector: string) =>
    selector === ':popover-open' ? answer() : query(selector)) as typeof document.querySelector)
}
const overBoxes = () =>
  [...document.querySelectorAll<HTMLElement>('.find-marks .find-mark')].map((b) => [
    b.className,
    b.style.left,
    b.style.top,
    b.style.width,
    b.style.height,
  ])

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
  // Case counts for nothing outside the first plane of Unicode too, as Deseret's letters show.
  expect(at('𐐨', '𐐀')).toEqual([[0, '𐐨']])
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
        <style>{'.rule { word: 0 }'}</style>
        <script type="text/plain">{'word'}</script>
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

test('what an ellipsis or a clamp cuts off is not found, only what overflow can scroll to', async () => {
  await act(async () =>
    setPage(
      <>
        <div id="cut" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
          apple
        </div>
        <div id="clipped" style={{ overflowX: 'clip', overflowY: 'clip' }}>
          apple
        </div>
        <div id="scrolled" style={{ overflowX: 'auto', overflowY: 'auto' }}>
          apple
        </div>
        {/* A wide table in a todo's notes, in a list that cuts off its rounded corners. */}
        <div id="list" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
          <div id="table" style={{ overflowX: 'auto', overflowY: 'auto' }}>
            <p id="cell">apple</p>
          </div>
        </div>
      </>,
    ),
  )
  for (const id of ['cut', 'clipped', 'scrolled', 'list', 'table']) {
    boxAt(id, rect(0, 0, 100, 100))
  }
  const found = () =>
    findRanges('apple')
      .map((r) => r.startContainer.parentElement?.id)
      .filter(Boolean)
  // Across its right edge, then under its bottom edge, then in it.
  matchesAt(rect(100, 10, 140, 30))
  expect(found()).toEqual(['scrolled', 'cell'])
  matchesAt(rect(10, 100, 50, 120))
  expect(found()).toEqual(['scrolled', 'cell'])
  matchesAt(rect(80, 10, 120, 30))
  expect(found()).toEqual(['cut', 'clipped', 'scrolled', 'cell'])
  // The window scrolls, whatever its own style says.
  document.documentElement.style.overflowX = 'hidden'
  document.documentElement.style.overflowY = 'hidden'
  expect(found()).toEqual(['cut', 'clipped', 'scrolled', 'cell'])
  // No width at all, wherever it is: as WebKit gives text wholly behind an ellipsis.
  matchesAt(rect(50, 10, 50, 30))
  expect(found()).toEqual([])
})

test('what comes out from behind an ellipsis as a pane or the window changes is found, and back', async () => {
  await act(async () =>
    setPage(
      <div id="cut" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
        apple
      </div>,
    ),
  )
  const cut = boxAt('cut', rect(0, 0, 100, 100))
  matchesAt(rect(150, 10, 190, 30))
  await callFind()
  await type('apple')
  // The sidebar's alone.
  expect(count()).toBe('1 / 1')
  // Dragging a pane's edge changes nothing but the root's style.
  cut.mockImplementation(() => rect(0, 0, 300, 100))
  document.documentElement.style.setProperty('--side-w', '400px')
  await settle()
  await frame()
  expect(count()).toBe('1 / 2')
  // Scrolling moves nothing out of what cuts it off, so it does not search again.
  const marks = registry.get('nod-find')
  window.dispatchEvent(new Event('scroll'))
  await frame()
  expect(registry.get('nod-find') === marks).toBe(true)
  // Back again, by resizing the window.
  cut.mockImplementation(() => rect(0, 0, 100, 100))
  window.dispatchEvent(new Event('resize'))
  await frame()
  expect(count()).toBe('1 / 1')
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
  expect(isOpen()).toBe(false)
  await callFind()
  expect(isOpen()).toBe(true)
  expect(focused(box())).toBe(true)
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
  // On the box's button, Enter is the button's.
  key('keydown', { key: 'Enter', code: 'Enter' }, document.querySelector('.find-close'))
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
  await callFind()
  await type('apple')
  await composition('compositionstart')
  await composition('compositionend')
  enter()
  expect(count()).toBe('3 / 4')
  await composition('compositionstart')
  await composition('compositionend')
  esc()
  expect(isOpen()).toBe(false)
  // Clicking away ends it, and on coming back the input method may take an Esc with nothing composed.
  await callFind()
  await composition('compositionstart')
  await composition('compositionend')
  act(() => {
    box()?.blur()
    box()?.focus()
  })
  esc({ keyCode: 229 })
  expect(isOpen()).toBe(false)
})

test('Esc takes the marks off, closes the box and gives the keyboard back', async () => {
  const before = byId('before')
  before.focus()
  await callFind()
  await type('apple')
  expect(focused(box())).toBe(true)
  expect(marked()).toHaveLength(4)
  esc()
  await settle()
  expect(isOpen()).toBe(false)
  expect(registry.size).toBe(0)
  expect(focused(before)).toBe(true)
  // It opens empty.
  await callFind()
  expect(box()?.value).toBe('')
  expect(count()).toBe('')
})

test('the × does the same, and with no focus before it the keyboard is simply let go', async () => {
  await callFind()
  await type('apple')
  await act(async () => document.querySelector<HTMLElement>('.find-close')?.click())
  expect(isOpen()).toBe(false)
  expect(registry.size).toBe(0)
  expect(focused(document.body)).toBe(true)
})

test('a focus target gone from the page does not stop the box closing', async () => {
  byId('before').focus()
  await callFind()
  await act(async () => setPage(<p>an apple</p>))
  esc()
  expect(isOpen()).toBe(false)
  expect(focused(document.body)).toBe(true)
})

test('Esc from the page around the box closes it too, unless a field or a menu has the key', async () => {
  await act(async () =>
    setPage(
      <>
        <button type="button" id="before">
          a button
        </button>
        <button type="button" id="other">
          another
        </button>
        <textarea id="field" />
        <div className="xterm">
          <textarea id="term" />
        </div>
        <div id="menu" popover="auto">
          a menu
        </div>
      </>,
    ),
  )
  const before = byId('before')
  before.focus()
  await callFind()
  // A click on the page's text lets go of the box and of everything else.
  act(() => box()?.blur())
  esc()
  expect(isOpen()).toBe(false)
  expect(focused(before)).toBe(true)

  // Gone on to something else on the page: the keyboard stays there.
  await callFind()
  const other = byId('other')
  other.focus()
  esc()
  expect(isOpen()).toBe(false)
  expect(focused(other)).toBe(true)

  await callFind()
  byId('field').focus()
  esc()
  expect(isOpen()).toBe(true)
  byId('term').focus()
  esc()
  expect(isOpen()).toBe(true)

  // The menu goes first, then the box.
  other.focus()
  const open = spyOnPopoverOpen(() => byId('menu'))
  esc()
  expect(isOpen()).toBe(true)
  open.mockRestore()
  esc()
  expect(isOpen()).toBe(false)
})

test('Esc from the page closes the box in a WebKit with no popovers, which throws on their selector', async () => {
  Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
  spyOnPopoverOpen(() => {
    throw new DOMException('not a valid selector', 'SyntaxError')
  })
  await callFind()
  act(() => box()?.blur())
  esc()
  expect(isOpen()).toBe(false)
})

test('the Esc that finishes a syllable leaves the box open, and the next one closes it', async () => {
  await callFind()
  await composition('compositionstart')
  await type('app')
  esc({ keyCode: 229, isComposing: true })
  expect(isOpen()).toBe(true)
  await composition('compositionend')
  esc({ keyCode: 229 })
  escUp()
  expect(isOpen()).toBe(true)
  expect(box()?.value).toBe('app')
  // The next, however it comes.
  esc({ keyCode: 229 })
  expect(isOpen()).toBe(false)
})

test('the Esc that finishes a syllable leaves the box open however the keys let go', async () => {
  await callFind()
  // The last letter's key is still down when Esc comes, and lets go first.
  await composition('compositionstart')
  await composition('compositionend')
  esc({ keyCode: 229 })
  key('keyup', { key: 'ㅎ', code: 'KeyG' })
  escUp()
  expect(isOpen()).toBe(true)
  // Up, still composing, with its keydown not seen here: it is the input method's.
  await composition('compositionstart')
  escUp()
  expect(isOpen()).toBe(true)
  // Its keydown not seen, for the key that ended the syllable.
  await composition('compositionend')
  escUp()
  expect(isOpen()).toBe(true)
  escUp()
  expect(isOpen()).toBe(false)
})

test('Esc gets through however WebKit hands it over', async () => {
  // The input method took the key, with nothing being composed.
  await callFind()
  esc({ keyCode: 229 })
  expect(isOpen()).toBe(false)
  // Its keydown never reached the page, as in the capture window (docs/design.md).
  await callFind()
  escUp()
  expect(isOpen()).toBe(false)
  // A key up for any other key does not close it.
  await callFind()
  key('keyup', { key: 'a', code: 'KeyA' })
  expect(isOpen()).toBe(true)
  // From the box's other field too.
  document.querySelector<HTMLElement>('.find-close')?.focus()
  esc()
  expect(isOpen()).toBe(false)
})

test('⌘F with the box open selects its text and keeps what it found', async () => {
  await callFind()
  await type('apple')
  enter()
  const input = box()
  await act(async () => byId('before').focus())
  expect(focused(input)).toBe(false)
  await callFind()
  expect(box() === input).toBe(true)
  expect(focused(input)).toBe(true)
  expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 5])
  expect(count()).toBe('3 / 4')
})

test('⌘F with the box open from something else on the page: the keyboard goes back there', async () => {
  await act(async () =>
    setPage(
      <>
        <button type="button" id="before">
          a button
        </button>
        <textarea id="memo" />
      </>,
    ),
  )
  const before = byId('before')
  before.focus()
  await callFind()
  byId('memo').focus()
  await callFind()
  expect(focused(box())).toBe(true)
  esc()
  expect(isOpen()).toBe(false)
  expect(focused(byId('memo'))).toBe(true)
  // From nowhere, as after a click on the page's text, the place it first came from stays.
  before.focus()
  await callFind()
  act(() => box()?.blur())
  await callFind()
  esc()
  expect(isOpen()).toBe(false)
  expect(focused(before)).toBe(true)
})

test('a refresh keeps the box, its text and the current match, and marks what is new', async () => {
  await callFind()
  await type('apple')
  enter()
  expect(hereIn()).toBe('two')
  const input = box()
  const root = document.documentElement
  const reading = root.scrollTop
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
  expect(box() === input).toBe(true)
  expect(input?.value).toBe('apple')
  expect(focused(input)).toBe(true)
  // React keeps the node of the second paragraph, so its match stays current.
  expect(marked()).toHaveLength(6)
  expect(count()).toBe('4 / 6')
  expect(hereIn()).toBe('two')
  expect(here()[0]?.startOffset).toBe(4)
  // Nobody asked to go anywhere, so the page stays where it is being read.
  expect(root.scrollTop).toBe(reading)
})

test('the current match stays by where it is in its text, when one text holds several', async () => {
  await act(async () => setPage(<p id="both">apple and apple</p>))
  await callFind()
  await type('apple')
  enter()
  expect(here()[0]?.startOffset).toBe(10)
  await act(async () =>
    setPage(
      <>
        <p id="both">apple and apple</p>
        <p>another apple</p>
      </>,
    ),
  )
  await settle()
  expect(count()).toBe('3 / 4')
  expect(here()[0]?.startOffset).toBe(10)
})

test('a refresh that only changes the words in a text node is seen too', async () => {
  const words = (word: string) => <p id="words">the word {word}</p>
  await act(async () => setPage(words('pear')))
  const asIs = byId('words').firstChild
  await callFind()
  await type('apple')
  expect(count()).toBe('1 / 1')
  await act(async () => setPage(words('apple')))
  await settle()
  // React has changed the text of a node, and made none.
  expect(byId('words').firstChild === asIs).toBe(true)
  expect(count()).toBe('1 / 2')
  expect(marked()).toEqual(['apple', 'apple'])
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
  await act(async () => byId('fold').setAttribute('open', ''))
  await settle()
  // The sidebar's match, the only one there was, stays current.
  expect(count()).toBe('1 / 2')
  enter()
  expect(hereIn()).toBe('inside')
})

test('what a change of class, style or hidden hides or shows is seen', async () => {
  await callFind()
  await type('apple')
  expect(marked()).toHaveLength(4)
  const one = byId('one')
  for (const [name, value] of [
    ['hidden', ''],
    ['class', 'gone'],
    ['style', 'display: none'],
  ] as const) {
    act(() => one.setAttribute(name, value))
    await settle()
    expect(marked()).toHaveLength(3)
    act(() => one.removeAttribute(name))
    await settle()
    expect(marked()).toHaveLength(4)
  }
})

test('the box’s own count and the terminal changing do not search again', async () => {
  await act(async () => setPage(<div className="xterm">rows</div>))
  await callFind()
  await type('apple')
  let marks = registry.get('nod-find')
  document.querySelector('.xterm')?.setAttribute('class', 'xterm focus')
  await settle()
  expect(registry.get('nod-find') === marks).toBe(true)
  // Going on changes the box's count, and that is all.
  enter()
  marks = registry.get('nod-find')
  await settle()
  expect(registry.get('nod-find') === marks).toBe(true)
})

test('the box’s own words are not found', async () => {
  await callFind()
  await type('pear')
  expect(count()).toBe('No match')
  expect(findRanges('No match')).toEqual([])
  expect(findRanges('×')).toEqual([])
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
  matchesAt(rect(10, 100, 50, 120), () => [rect(10, 20, 50, 40)])
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
  expect(isOpen()).toBe(false)
})

test('text a highlight cannot paint gets boxes over it, and none is left when the box closes', async () => {
  matchesAt(rect(10, 100, 50, 120), () => [rect(10, 20, 50, 40)])
  await act(async () =>
    setPage(
      <>
        <button type="button">apple in a button</button>
        <div style={{ display: 'flex' }}>apple in a flex box</div>
        <div style={{ display: 'grid' }}>apple in a grid box</div>
        <div id="clamped">apple in a clamped box</div>
        <div>
          apple beside a block<p>a block</p>
        </div>
        <p>
          apple in a paragraph <b>with a bold word</b> and <a href="/x">the next page</a>
        </p>
      </>,
    ),
  )
  // happy-dom drops this value from a style, so it is given as a browser computes it.
  const computed = getComputedStyle
  const clamped = byId('clamped')
  spyOn(globalThis, 'getComputedStyle').mockImplementation((el) =>
    el === clamped ? ({ display: '-webkit-box' } as CSSStyleDeclaration) : computed(el),
  )
  await callFind()
  await type('apple')
  // The sidebar's link and the paragraph are painted by the highlight, so they are left out.
  expect(marked()).toHaveLength(7)
  expect(count()).toBe('2 / 7')
  const current = ['find-mark current', '10px', '20px', '40px', '20px']
  const other = ['find-mark', '10px', '20px', '40px', '20px']
  expect(overBoxes()).toEqual([current, other, other, other, other])
  enter()
  expect(overBoxes()).toEqual([other, current, other, other, other])
  // On the paragraph, its mark is the highlight and no box is current.
  enter({ shiftKey: true })
  enter({ shiftKey: true })
  expect(here()[0]?.startContainer.parentElement?.tagName).toBe('A')
  enter({ shiftKey: true })
  expect(here()[0]?.startContainer.parentElement?.tagName).toBe('P')
  expect(overBoxes()).toEqual([other, other, other, other, other])
  esc()
  expect(document.querySelector('.find-marks') === null).toBe(true)
})

test('a box over text stays within the window and what clips the text, and follows the page', async () => {
  let line = rect(150, 20, 300, 40)
  matchesAt(rect(150, 80, 160, 90), () => [line])
  await act(async () =>
    setPage(
      <div id="clip" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
        <div id="scroller" style={{ overflowX: 'auto', overflowY: 'auto' }}>
          <button type="button">apple cut off</button>
        </div>
      </div>,
    ),
  )
  const clipped = boxAt('clip', rect(100, 0, 200, 100))
  boxAt('scroller', rect(0, 0, 100000, 100000))
  await callFind()
  await type('apple')
  expect(overBoxes()).toEqual([['find-mark current', '150px', '20px', '50px', '20px']])
  // Scrolled out of what clips it: no box. A box inside the page sends no scroll up to the window.
  line = rect(250, 20, 300, 40)
  act(() => byId('scroller').dispatchEvent(new Event('scroll')))
  await frame()
  expect(overBoxes()).toEqual([])
  // Back, and resizing the window draws too.
  line = rect(110, 20, 130, 40)
  window.dispatchEvent(new Event('resize'))
  await frame()
  expect(overBoxes()).toEqual([['find-mark current', '110px', '20px', '20px', '20px']])
  // Dragging a pane's edge changes nothing but the root's style.
  line = rect(120, 20, 140, 40)
  document.documentElement.style.setProperty('--side-w', '300px')
  await settle()
  await frame()
  expect(overBoxes()).toEqual([['find-mark current', '120px', '20px', '20px', '20px']])
  // Outside the window.
  clipped.mockImplementation(() => rect(0, 0, 100000, 100000))
  line = rect(50, innerHeight + 10, 80, innerHeight + 30)
  window.dispatchEvent(new Event('scroll'))
  await frame()
  expect(overBoxes()).toEqual([])
  // In the document's place, with the window scrolled down it.
  line = rect(50, 10, 80, 30)
  window.scrollTo(40, 500)
  window.dispatchEvent(new Event('scroll'))
  await frame()
  expect(overBoxes()).toEqual([['find-mark current', '90px', '510px', '30px', '20px']])
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

test('a match under the find box at the top of the window comes out from under it', async () => {
  const root = document.documentElement
  root.scrollTop = 1000
  matchesAt(rect(10, 30, 50, 40))
  await callFind()
  await type('apple')
  expect(root.scrollTop).toBe(1000 + 35 - innerHeight / 2)
  // Just below it stays where it is.
  root.scrollTop = 1000
  matchesAt(rect(10, 70, 50, 80))
  await type('one')
  expect(root.scrollTop).toBe(1000)
})

test('going to a match scrolls what scrolls around it, as far as a sticky or fixed box', async () => {
  const root = document.documentElement
  await act(async () =>
    setPage(
      <>
        <div id="cut" style={{ overflowX: 'hidden', overflowY: 'hidden' }}>
          <div id="scroller" style={{ overflowX: 'auto', overflowY: 'auto' }}>
            <p id="plain">apple in a paragraph</p>
          </div>
        </div>
        <div id="sticky" style={{ position: 'sticky', overflowY: 'auto' }}>
          <p>apple in a sticky pane</p>
        </div>
        <div id="fixed" style={{ position: 'fixed', overflowY: 'scroll' }}>
          <p>apple in a fixed pane</p>
        </div>
      </>,
    ),
  )
  matchesAt(rect(2000, 1000, 2040, 1020))
  // The match is half in it, and would be brought all in if this box were scrolled.
  boxAt('cut', rect(0, 0, 2010, 1010))
  boxAt('scroller', rect(0, 100, 500, 300))
  boxAt('sticky', rect(0, 100, 500, 300))
  boxAt('fixed', rect(0, 100, 500, 300))
  await callFind()
  await type('apple')
  expect(hereIn()).toBe('plain')
  // To the middle of the box around it, and of the window, each way.
  const scroller = byId('scroller')
  expect([scroller.scrollTop, scroller.scrollLeft]).toEqual([810, 1770])
  expect(root.scrollTop).toBe(1010 - innerHeight / 2)
  expect(root.scrollLeft).toBe(2020 - innerWidth / 2)
  // What cuts off an ellipsis is never scrolled.
  const cut = byId('cut')
  expect([cut.scrollTop, cut.scrollLeft]).toEqual([0, 0])

  // Enter goes there too. Past a sticky or fixed box the window stays, and with it the page being
  // read.
  for (const id of ['sticky', 'fixed']) {
    root.scrollTop = 0
    root.scrollLeft = 0
    enter()
    expect(byId(id).scrollTop).toBe(810)
    expect([root.scrollTop, root.scrollLeft]).toEqual([0, 0])
  }
})

test('the app’s menu sends the event the page takes, and the help lists the key', () => {
  const main = readFileSync(new URL('../../desktop/src-tauri/src/main.rs', import.meta.url), 'utf8')
  expect(main).toContain(`new Event('${FIND_EVENT}')`)
  expect(main).toContain('"찾기…", true, Some("CmdOrCtrl+F")')
  expect(KEYS.find.show).toEqual(['⌘F'])
  expect(KEYS.find.bind).toEqual([])
})
