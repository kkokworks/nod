import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// A worker's live screen (terminal.tsx) in a DOM, its socket connected to nothing: what reaches the
// worker is what xterm.js and the page make of the events in xterm.js's field. The events are those
// WebKit and Chrome send for 두벌식 Korean (docs/design.md).
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

class Socket {
  static readonly OPEN = 1
  static made: Socket[] = []
  readyState = Socket.OPEN
  binaryType = 'blob'
  sent: [string, unknown][] = []
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {
    Socket.made.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
  }
}
const bunSocket = globalThis.WebSocket
Object.assign(globalThis, { WebSocket: Socket })
// What the screen imports as it attaches, loaded here first.
const imports = () =>
  Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-webgl'),
  ])
await imports()
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Screen } = await import('./terminal')

let view: ReturnType<typeof createRoot>
let socket: Socket
beforeEach(async () => {
  Socket.made.length = 0
  view = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => view.render(<Screen id={1} screen="" />))
  // Asked after the screen's, these come in after its own, and it attaches as they do.
  await act(imports)
  const [made] = Socket.made
  if (made === undefined) throw new Error('the screen did not attach')
  socket = made
})
afterEach(() => {
  act(() => view.unmount())
  document.body.replaceChildren()
})
afterAll(async () => {
  Object.assign(globalThis, { WebSocket: bunSocket })
  await GlobalRegistrator.unregister()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined })
})

function field(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  if (el === null) throw new Error('no field')
  return el
}
// Where the syllable being built is drawn, at the cursor.
const preedit = () => {
  const el = document.querySelector<HTMLElement>('.composition-view')
  return el?.classList.contains('active') ? el.textContent : ''
}
// What the worker got.
const typed = () =>
  socket.sent
    .filter(([kind]) => kind === 'in')
    .map(([, text]) => text)
    .join('')
// xterm.js sends what a composition made a moment after it ends; events are a moment apart.
const tick = () => new Promise((done) => setTimeout(done, 0))

// keyCode 229 is a key the input method took. happy-dom leaves keyCode and charCode 0.
function key(
  type: 'keydown' | 'keypress' | 'keyup',
  init: KeyboardEventInit & { keyCode: number },
) {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  if (type === 'keypress') Object.defineProperty(event, 'charCode', { value: init.keyCode })
  field().dispatchEvent(event)
  return event
}
// The field as the input method leaves it, and its input event: a person's is composed.
function write(value: string, data: string | null, inputType = 'insertText', isComposing = false) {
  field().value = value
  const event = new InputEvent('input', { data, inputType, bubbles: true, composed: true })
  Object.defineProperty(event, 'isComposing', { value: isComposing })
  field().dispatchEvent(event)
}
// As a browser does: a key that types a character has a keypress if its keydown was let be, and
// then the character goes in the field if that was let be too. xterm.js sends a capital or a Space
// from the keypress and lets it be (its `cancel` does nothing unless forced).
const press = (init: KeyboardEventInit & { key: string; keyCode: number }) => {
  const down = key('keydown', init)
  const types = init.key.length === 1 && !init.ctrlKey && !init.metaKey && init.keyCode !== 229
  if (types && !down.defaultPrevented) {
    const pressed = key('keypress', { ...init, keyCode: init.key.charCodeAt(0) })
    if (!pressed.defaultPrevented) write(field().value + init.key, init.key)
  }
  key('keyup', init)
}
// happy-dom's CompositionEvent is a plain Event, with no data.
function compose(type: string, data = '') {
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  field().dispatchEvent(event)
}

// 리뷰, key by key, as the app's WKWebView sent it (docs/design.md): no composition events; for each
// key the input method writes the field first, rewriting the syllable it builds, and the key's
// keydown comes after with keyCode 229. ㅠ takes the ㅂ of 립 into 뷰. `rewrites` marks a write over
// the syllable being built. Which inputType WebKit gives such a write was not recorded.
const RIBYU = [
  { key: 'ㄹ', code: 'KeyF', writes: [{ value: 'ㄹ', data: 'ㄹ', rewrites: false }] },
  { key: 'ㅣ', code: 'KeyL', writes: [{ value: '리', data: '리', rewrites: true }] },
  { key: 'ㅂ', code: 'KeyQ', writes: [{ value: '립', data: '립', rewrites: true }] },
  {
    key: 'ㅠ',
    code: 'KeyB',
    writes: [
      { value: '리', data: '리', rewrites: true },
      { value: '리뷰', data: '뷰', rewrites: false },
    ],
  },
]

// One key as the app's input method takes it, after what the field held.
async function byApp(
  { key: k, code, writes }: (typeof RIBYU)[number],
  { before = '', keyFirst = false, rewrite = 'insertText' } = {},
) {
  if (keyFirst) key('keydown', { key: k, code, keyCode: 229 })
  for (const w of writes) write(before + w.value, w.data, w.rewrites ? rewrite : 'insertText')
  if (!keyFirst) key('keydown', { key: k, code, keyCode: 229 })
  key('keyup', { key: k, code, keyCode: 229 })
  await tick()
}
// A syllable built key by key, each write rewriting the one before: 한 is ㅎ, 하, 한.
async function build(...stages: string[]) {
  const before = field().value
  for (const [i, stage] of stages.entries()) {
    await byApp(
      { key: 'ㅎ', code: 'KeyG', writes: [{ value: stage, data: stage, rewrites: i > 0 }] },
      { before },
    )
  }
}

for (const keyFirst of [false, true]) {
  for (const rewrite of ['insertText', 'insertReplacementText']) {
    test(`Korean typed in the app reaches the worker once, each syllable when it is done (${keyFirst ? 'keydown' : 'input'} first, rewrites as ${rewrite})`, async () => {
      for (const k of RIBYU) await byApp(k, { keyFirst, rewrite })
      // 리 is done; 뷰 may still take a final consonant, so it shows at the cursor and waits.
      expect(typed()).toBe('리')
      expect(preedit()).toBe('뷰')
      // As the app sends the Enter that follows the last syllable: the input method lets it by.
      press({ key: 'Enter', code: 'Enter', keyCode: 13 })
      await tick()
      expect(typed()).toBe('리뷰\r')
      expect(preedit()).toBe('')
    })
  }
}

test('Korean composed with composition events, as Chrome sends them, reaches the worker once', async () => {
  const update = (value: string, data: string) => {
    compose('compositionupdate', data)
    write(value, data, 'insertCompositionText', true)
  }
  key('keydown', { key: 'ㄹ', code: 'KeyF', keyCode: 229 })
  compose('compositionstart')
  update('ㄹ', 'ㄹ')
  key('keyup', { key: 'ㄹ', code: 'KeyF', keyCode: 229 })
  await tick()
  for (const [k, code, syllable] of [
    ['ㅣ', 'KeyL', '리'],
    ['ㅂ', 'KeyQ', '립'],
  ] as const) {
    press({ key: k, code, keyCode: 229, isComposing: true })
    update(syllable, syllable)
    await tick()
  }
  // ㅠ ends 리 and starts 뷰.
  key('keydown', { key: 'ㅠ', code: 'KeyB', keyCode: 229, isComposing: true })
  update('리', '리')
  compose('compositionend', '리')
  compose('compositionstart')
  update('리뷰', '뷰')
  key('keyup', { key: 'ㅠ', code: 'KeyB', keyCode: 229 })
  await tick()
  expect(typed()).toBe('리')
  // xterm.js's own view of the composition.
  expect(preedit()).toBe('뷰')
  // Chrome ends the composition with the Enter, then sends the Enter again as itself.
  key('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true })
  compose('compositionend', '뷰')
  press({ key: 'Enter', code: 'Enter', keyCode: 13 })
  await tick()
  expect(typed()).toBe('리뷰\r')
})

test('a Space that ends a composition reaches the worker once, after the syllable', async () => {
  key('keydown', { key: 'ㅎ', code: 'KeyG', keyCode: 229 })
  compose('compositionstart')
  compose('compositionupdate', 'ㅎ')
  write('ㅎ', 'ㅎ', 'insertCompositionText', true)
  await tick()
  // The Space ends the composition, then the input method writes it as text.
  key('keydown', { key: ' ', code: 'Space', keyCode: 229, isComposing: true })
  compose('compositionend', 'ㅎ')
  write('ㅎ ', ' ')
  key('keyup', { key: ' ', code: 'Space', keyCode: 32 })
  await tick()
  expect(typed()).toBe('ㅎ ')
})

test('the syllable being built shows at the cursor', async () => {
  const { searchParams } = new URL(socket.url)
  const cols = Number(searchParams.get('cols'))
  const rows = Number(searchParams.get('rows'))
  const screen = document.querySelector('.xterm-screen')
  if (screen === null) throw new Error('no screen')
  // Cells 10px by 20px: happy-dom lays nothing out.
  spyOn(screen, 'getBoundingClientRect').mockReturnValue({
    width: cols * 10,
    height: rows * 20,
  } as DOMRect)
  act(() => socket.onmessage?.({ data: new TextEncoder().encode('\n> ').buffer }))
  await tick()
  await build('ㅎ')
  const at = document.querySelector<HTMLElement>('.composition-view')
  expect([at?.style.left, at?.style.top, at?.style.height]).toEqual(['20px', '20px', '20px'])
  expect(at?.style.background).toMatch(/#282c34|rgb\(40, 44, 52\)/)
  // The worker draws after it: the syllable goes where the cursor is now.
  act(() => socket.onmessage?.({ data: new TextEncoder().encode('>> ').buffer }))
  await tick()
  await new Promise((done) => requestAnimationFrame(done))
  expect(at?.style.left).toBe('50px')
  await byApp({ key: 'ㅏ', code: 'KeyK', writes: [{ value: '하', data: '하', rewrites: true }] })
  expect(preedit()).toBe('하')
  expect(typed()).toBe('')
})

test('a key the input method takes from a syllable sends nothing, and the Backspace after it erases', async () => {
  for (const k of RIBYU.slice(0, 3)) await byApp(k)
  expect(preedit()).toBe('립')
  // Backspace takes the syllable apart: 립, 리, ㄹ, nothing.
  for (const stage of ['리', 'ㄹ']) {
    write(stage, stage)
    press({ key: 'Backspace', code: 'Backspace', keyCode: 229 })
    await tick()
    expect(preedit()).toBe(stage)
  }
  write('', null, 'deleteContentBackward')
  press({ key: 'Backspace', code: 'Backspace', keyCode: 229 })
  await tick()
  expect(preedit()).toBe('')
  expect(typed()).toBe('')
  // With nothing being built, the input method lets Backspace by.
  press({ key: 'Backspace', code: 'Backspace', keyCode: 8 })
  expect(typed()).toBe('\x7f')
})

test('a key the input method lets by sends the syllable first, then itself', async () => {
  await build('ㅎ', '하', '한')
  press({ key: ' ', code: 'Space', keyCode: 32 })
  await build('ㄱ', '그', '글')
  press({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
  await build('ㄷ')
  press({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true })
  await build('ㅁ')
  press({ key: 'Tab', code: 'Tab', keyCode: 9 })
  await build('ㅂ')
  press({ key: 'Escape', code: 'Escape', keyCode: 27 })
  expect(typed()).toBe('한 글\x1b[Dㄷ\x03ㅁ\tㅂ\x1b')
})

test('a Space, a stop or a line break the input method writes itself ends the syllable with it', async () => {
  await build('ㅎ', '하', '한')
  await byApp({ key: ' ', code: 'Space', writes: [{ value: '한 ', data: ' ', rewrites: false }] })
  await build('ㄱ', '그', '글')
  await byApp({
    key: '.',
    code: 'Period',
    writes: [{ value: '한 글.', data: '.', rewrites: false }],
  })
  await build('ㅇ')
  write('한 글.ㅇ\n', null, 'insertLineBreak')
  key('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 })
  await tick()
  expect(typed()).toBe('한 글.ㅇ\r')
  expect(preedit()).toBe('')
})

test('Korean typed while a Space is still held down goes on as ever', async () => {
  await build('ㅎ', '하', '한')
  // The Space's keypress and its input, xterm.js's, with its key not yet up.
  const space = { key: ' ', code: 'Space', keyCode: 32 }
  key('keydown', space)
  key('keypress', space)
  write('한 ', ' ')
  // The next key's write comes first: 'ㅋ' is the whole of a syllable that the next ㅋ would not rewrite.
  write('한 ㅋ', 'ㅋ')
  key('keyup', space)
  expect(preedit()).toBe('ㅋ')
  write('한 ㅋㅋ', 'ㅋ')
  key('keydown', { key: 'ㅋ', code: 'KeyZ', keyCode: 229 })
  expect(typed()).toBe('한 ㅋ')
  expect(preedit()).toBe('ㅋ')
})

test('Shift for a doubled consonant keeps the syllable open for it', async () => {
  await build('ㄱ', '가')
  key('keydown', { key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true })
  await byApp({ key: 'ㅆ', code: 'KeyT', writes: [{ value: '갔', data: '갔', rewrites: true }] })
  key('keyup', { key: 'Shift', code: 'ShiftLeft', keyCode: 16 })
  expect(typed()).toBe('')
  expect(preedit()).toBe('갔')
  press({ key: 'Enter', code: 'Enter', keyCode: 13 })
  expect(typed()).toBe('갔\r')
})

test('a paste, a composition or leaving the field sends the syllable first', async () => {
  await build('ㅎ', '하')
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'x\ny' } })
  field().dispatchEvent(paste)
  expect(typed()).toBe('하x\ry')
  await build('ㄴ')
  compose('compositionstart')
  expect(typed()).toBe('하x\ryㄴ')
  compose('compositionupdate', 'あ')
  write('ㄴあ', 'あ', 'insertCompositionText', true)
  compose('compositionend', 'あ')
  await tick()
  expect(typed()).toBe('하x\ryㄴあ')
  await build('ㄷ')
  act(() => field().blur())
  expect(typed()).toBe('하x\ryㄴあㄷ')
  expect(preedit()).toBe('')
})

test('letters, digits, keys and text with no key reach the worker as before', async () => {
  press({ key: 'a', code: 'KeyA', keyCode: 65 })
  // xterm.js sends these from the keypress, and the input that follows is its to drop.
  press({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true })
  press({ key: ' ', code: 'Space', keyCode: 32 })
  press({ key: '1', code: 'Digit1', keyCode: 49 })
  press({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 })
  press({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true })
  press({ key: 'Backspace', code: 'Backspace', keyCode: 8 })
  press({ key: 'Enter', code: 'Enter', keyCode: 13 })
  // As the character viewer or an emoji picker sends one.
  write('😀', '😀')
  expect(typed()).toBe('aA 1\x1b[A\x03\x7f\r😀')
  expect(preedit()).toBe('')
})
