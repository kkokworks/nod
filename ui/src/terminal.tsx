import { useEffect, useRef, useState } from 'react'

// The worker's terminal while its session is alive. The server renders the screen as it was a
// moment ago (`screen`); the browser then attaches to the session through the UI server
// (terminal.server.ts), and the box shows it live and takes keys until the page leaves it, moves to
// another task or the session ends. Until the first bytes come, and if they never do, the screen
// as it was shows, which the page reloads every few seconds.
export function Screen({ id, screen }: { id: number; screen: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState(false)
  useEffect(() => {
    const leave = new AbortController()
    if (box.current !== null) {
      attach(id, box.current, setLive, leave.signal).catch(() => setLive(false))
    }
    return () => leave.abort()
  }, [id])
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

// Loaded here, not with the page: xterm.js needs a browser, and pages without a live worker never
// use it.
async function attach(
  id: number,
  box: HTMLElement,
  setLive: (live: boolean) => void,
  leave: AbortSignal,
): Promise<void> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ])
  if (leave.aborted) return
  const colors = getComputedStyle(box)
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
    theme: {
      background: colors.getPropertyValue('--term-bg').trim(),
      foreground: colors.getPropertyValue('--term-fg').trim(),
    },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(box)
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
  // ponytail: no reattaching after the UI server restarts; the screen as it was shows until the
  // page is opened again.
  ws.onclose = () => setLive(false)
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
    term.dispose()
  })
}
