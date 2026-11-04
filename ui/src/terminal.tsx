import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

// How long a box whose connection closed waits to attach again (the UI server restarted, say): as
// long as the page waits to reload.
export const RETRY_MS = 5000

// The worker's terminal while its session is alive. The server renders the screen as it was a
// moment ago (`screen`); the browser then attaches to the session through the UI server
// (terminal.server.ts), and the box shows it live and takes keys until the page leaves it or the
// session ends. Until the first bytes come, and while it is not attached, the screen as it was
// shows, which the page reloads every few seconds.
export function Screen({ id, screen }: { id: number; screen: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState(false)
  // A page out of sight lets go: a hidden app window or a tab behind others. Attached, it holds off
  // what waits for a person to leave a worker (gc, the tick, landing, an account's restart).
  const shown = useSyncExternalStore(
    onVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  )
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each attempt attaches anew
  useEffect(() => {
    if (!shown || box.current === null) return
    const leave = new AbortController()
    const again = () => {
      const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS)
      leave.signal.addEventListener('abort', () => clearTimeout(timer))
    }
    attach(id, box.current, setLive, leave.signal, again).catch(() => {
      setLive(false)
      again()
    })
    return () => leave.abort()
  }, [id, shown, attempt])
  return (
    <div className="window">
      <div className="window-bar">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="window-title">task-{id}</span>
        <span className="live">live</span>
      </div>
      <div className="term-box">
        <div ref={box} className="term" />
        <pre className="screen" hidden={live}>
          {screen}
        </pre>
      </div>
    </div>
  )
}

// The worker's terminal as the person sees it in a terminal app: drawn with WebGL, with Unicode 11
// widths (attach), a macOS monospace font, and a common dark theme for the colours a program does
// not set itself. The colours it does set show as they are: no minimum contrast lightens them.
export const TERMINAL = {
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  fontSize: 14,
  fontFamily:
    '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
  fontWeight: '300',
  fontWeightBold: '500',
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  drawBoldTextInBrightColors: true,
  theme: {
    background: '#282c34',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#282c34',
    selectionBackground: '#5a7898',
    selectionForeground: '#ffffff',
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
  },
} satisfies ITerminalOptions

function onVisibility(changed: () => void): () => void {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

// Loaded here, not with the page: xterm.js needs a browser, and pages without a live worker never
// use it.
// `closed`: the connection went other than by `leave`.
async function attach(
  id: number,
  box: HTMLElement,
  setLive: (live: boolean) => void,
  leave: AbortSignal,
  closed: () => void,
): Promise<void> {
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebglAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-unicode11'),
    import('@xterm/addon-webgl'),
  ])
  if (leave.aborted) return
  const term = new Terminal(TERMINAL)
  // Gone with the attempt, also one that fails below and is tried again: not one more in the box.
  leave.addEventListener('abort', () => term.dispose())
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open(box)
  holdSyllables(term)
  // Drawn with WebGL; where WebGL cannot run, or loses its context, the DOM renderer xterm.js starts
  // with draws instead.
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    // No WebGL here: the DOM renderer stays.
  }
  // Around the cells too, in the padding.
  box.style.background = TERMINAL.theme.background
  fit.fit()
  // The terminal is made before the socket, so it has the first screen tmux draws on attaching.
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal/${id}?cols=${term.cols}&rows=${term.rows}`,
  )
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    setLive(true)
    term.write(new Uint8Array(e.data))
  }
  ws.onclose = () => {
    setLive(false)
    if (!leave.aborted) closed()
  }
  const send = (m: unknown[]) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  term.onData((text) => send(['in', text]))
  term.onResize(({ cols, rows }) => send(['size', cols, rows]))
  // The wheel scrolls the page. In tmux's alternate screen xterm.js would send it as ↑ and ↓,
  // which the worker's Claude Code takes as going through its history.
  term.attachCustomWheelEventHandler(() => false)
  const resized = new ResizeObserver(() => fit.fit())
  resized.observe(box)
  leave.addEventListener('abort', () => {
    resized.disconnect()
    ws.close()
  })
}

// The syllable or jamo the Korean input method may still rewrite: the last one it wrote.
const OPEN = /[ㄱ-ㆎ가-힣]$/
// How an input method writes the field. A composition's own kinds are writes like any if no
// composition says they are its own (`composing`, isComposing).
const WRITES =
  /^(insert(Text|ReplacementText|LineBreak|Paragraph|CompositionText|FromComposition)|delete)/
const LINE_BREAK = /^insert(LineBreak|Paragraph)/
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'])
const ARROWS: Record<string, string> = {
  ArrowLeft: 'D',
  ArrowUp: 'A',
  ArrowRight: 'C',
  ArrowDown: 'B',
}

// 두벌식 Korean in the app's WKWebView comes with no composition events (docs/design.md): for each
// key the input method writes xterm.js's field, rewriting the syllable it is building (ㄹ, 리, 립,
// then 리 and 뷰 for ㅠ), and the key's keydown comes with keyCode 229. xterm.js sent every write,
// so the worker got ㄹ리립리뷰. Here the page takes those writes: the last syllable shows at the
// cursor and waits, what is before it goes, and the one waiting goes before any key the input method
// lets by (Enter, an arrow, Space, a shortcut), a paste, a right click, a composition, or the field
// losing the keyboard. A composition, as Chrome sends for the same keys, stays xterm.js's, but for
// the key that ends one in WebKit, which writes the field before that key's keydown (`ending`).
// ponytail: text with no key (dictation, the character viewer) that ends in Hangul waits for a key
// too, and an input method rewriting a syllable already sent sends it again.
function holdSyllables(term: Terminal): void {
  const { element: root, textarea: field } = term
  const view = root?.querySelector<HTMLElement>('.composition-view')
  const screen = root?.querySelector('.xterm-screen')
  if (!root || !field || !view || !screen) return
  let held = ''
  // Where it starts in the field.
  let at = 0
  let composing = false
  // Until xterm.js has sent what a composition made, a moment after it ends, and what goes after that.
  let ending = false
  let after = ''
  // xterm.js sends a capital or a Space from its keypress and lets the character go in the field: the
  // input that follows is its own, which it drops.
  let pressed = false
  Object.assign(view.style, {
    fontFamily: TERMINAL.fontFamily,
    fontSize: `${TERMINAL.fontSize}px`,
    fontWeight: TERMINAL.fontWeight,
    background: TERMINAL.theme.background,
    color: TERMINAL.theme.foreground,
  })
  // In xterm.js's view of a composition, over the cell at the cursor.
  const draw = () => {
    view.textContent = held
    view.classList.toggle('active', held !== '')
    if (held === '') return
    const { width, height } = screen.getBoundingClientRect()
    const { cursorX, cursorY } = term.buffer.active
    view.style.left = `${(Math.min(cursorX, term.cols - 1) * width) / term.cols}px`
    view.style.top = `${(cursorY * height) / term.rows}px`
    view.style.height = view.style.lineHeight = `${height / term.rows}px`
  }
  term.onRender(() => {
    if (held !== '') draw()
  })
  const send = (text: string) => {
    if (text !== '') term.input(text.replace(/\r?\n/g, '\r'))
  }
  const flush = () => {
    if (held === '') return
    const text = held
    held = ''
    draw()
    send(text)
  }
  root.addEventListener(
    'input',
    (e) => {
      if (!(e instanceof InputEvent) || composing || e.isComposing) return
      if (!WRITES.test(e.inputType)) return
      if (ending) {
        // xterm.js is to send all that is in the field, and would send this now as well. A line break
        // would go as ⌃J, not as the Enter it is.
        e.stopImmediatePropagation()
        if (LINE_BREAK.test(e.inputType)) {
          field.value = field.value.replace(/\n$/, '')
          after = '\r'
        }
        return
      }
      if (pressed) {
        pressed = false
        return
      }
      e.stopImmediatePropagation()
      let tail: string
      if (held !== '') tail = field.value.slice(at)
      else {
        // New text at the end, where the input method writes, or a key it took with no text.
        const erases = e.inputType === 'deleteContentBackward' ? '\x7f' : ''
        tail = e.data || (LINE_BREAK.test(e.inputType) ? '\n' : erases)
        at = Math.max(0, field.value.length - tail.length)
      }
      held = OPEN.exec(tail)?.[0] ?? ''
      const done = tail.slice(0, tail.length - held.length)
      at += done.length
      draw()
      send(done)
    },
    true,
  )
  term.attachCustomKeyEventHandler((e) => {
    pressed = e.type === 'keypress'
    if (e.type !== 'keydown' || composing) return true
    if (ending) {
      // The arrow that ended the composition in WebKit, whose 229 xterm.js takes for nothing to send.
      // It has moved the caret, and the field is read from its end.
      const arrow = ARROWS[e.key]
      if (!arrow || e.keyCode !== 229 || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)
        return true
      field.setSelectionRange(field.value.length, field.value.length)
      after = `\x1b${term.modes.applicationCursorKeysMode ? 'O' : '['}${arrow}`
      return false
    }
    // The input method's: what it does comes as a write, and xterm.js would send that again.
    if (e.keyCode === 229) return false
    if (!MODIFIERS.has(e.key)) flush()
    return true
  })
  root.addEventListener('paste', flush, true)
  // xterm.js writes the field for a right click, under what is being built.
  root.addEventListener('contextmenu', flush, true)
  field.addEventListener('blur', flush)
  // Before xterm.js shows the composition in the same view.
  root.addEventListener(
    'compositionstart',
    () => {
      flush()
      composing = true
    },
    true,
  )
  // After xterm.js's own, so this moment ends after its send.
  field.addEventListener('compositionend', () => {
    composing = false
    ending = true
    setTimeout(() => {
      ending = false
      send(after)
      after = ''
    })
  })
}
