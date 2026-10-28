import type { ITerminalOptions } from '@xterm/xterm'
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
