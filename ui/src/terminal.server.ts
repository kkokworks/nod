// The worker's terminal on its task page, live. The page opens a WebSocket at /terminal/<task>, and
// the server attaches to the worker's tmux session in a pseudo-terminal of its own, as `nod attach`
// does in a person's terminal: tmux draws the screen, and the attach counts as a person there, so
// gc and the tick leave the session alone while the page shows it. Vite serves the pages, so this
// takes its HTTP server's upgrades, the dev server's and the built one's alike (vite.config.ts).
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
// Bun's own: Bun serves any import of ws with it.
import { type RawData, type WebSocket, WebSocketServer } from 'ws'
import { nodHome } from '../../src/ledger'
import { Terminals } from '../../src/tmux'
import { sessionName } from '../../src/worker'

const PATH = /^\/terminal\/(\d+)$/
// The most cells a side asks for: more than a screen shows, and no pty is asked for a silly size.
const MAX_CELLS = 1000
// The close code when there is no session to attach to; the page then shows the screen it has.
export const NO_SESSION = 4404
// What the page's terminal (xterm.js) can do that tmux does not take from xterm-256color: the
// colours a program gives as RGB, which tmux would otherwise bring to the nearest of 256.
export const FEATURES = 'RGB'

export function serveTerminals(http: Server, terminals = Terminals.of(nodHome())): void {
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = PATH.exec(url.pathname)?.[1]
    // Another's, as Vite's own for hot reload.
    if (id === undefined) return
    const cols = cells(url.searchParams.get('cols'))
    const rows = cells(url.searchParams.get('rows'))
    // Refused by closing: Bun's node:http sends nothing written to an upgrade's socket (measured
    // on 1.3.14), so there is no status line to give.
    if (!fromThisPage(req.headers.origin, req.headers.host) || cols === null || rows === null) {
      return socket.destroy()
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      attach(ws, terminals, sessionName(Number(id)), cols, rows),
    )
  })
}

// Whether the upgrade comes from the UI's own page. A browser names the page's origin in every
// WebSocket handshake but lets any site open one, and the server functions' CSRF check does not
// see it, so another site open in the same browser could otherwise type into a worker in auto
// mode. The host must be this computer: a site whose own name leads here (DNS rebinding) has an
// origin that matches its host.
export function fromThisPage(origin: string | undefined, host: string | undefined): boolean {
  const url = origin === undefined ? null : URL.parse(origin)
  return url !== null && url.protocol === 'http:' && url.host === host && LOOPBACK.has(url.hostname)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function cells(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_CELLS ? n : null
}

// The page sends what is typed as ['in', text] and its size as ['size', cols, rows], and gets the
// terminal's bytes back. When the page goes, so does the attach (tmux detach); the worker goes on.
function attach(ws: WebSocket, terminals: Terminals, name: string, cols: number, rows: number) {
  if (!terminals.alive(name)) return ws.close(NO_SESSION, 'no live session')
  // tmux will not attach from inside one of its panes, where `bun run dev` may run, and takes a
  // terminal whose locale does not say UTF-8 for one that cannot show it, Korean coming out as
  // underscores; launchd starts the server with no locale. It reads LC_ALL before LC_CTYPE.
  const { TMUX: _, LC_ALL: __, ...env } = process.env
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(terminals.attachCommand(name, FEATURES), {
      env: { ...env, TERM: 'xterm-256color', LC_CTYPE: 'UTF-8' },
      terminal: {
        cols,
        rows,
        data: (_, bytes) => {
          if (ws.readyState === ws.OPEN) ws.send(bytes)
        },
      },
    })
  } catch (error) {
    return ws.close(1011, String(error).slice(0, 120))
  }
  ws.on('message', (data: RawData) => {
    const [m, term] = [parse(data), proc.terminal]
    // Closed when tmux has left just before: what comes after has nowhere to go.
    if (m === null || term === undefined || term.closed) return
    if (m[0] === 'in' && typeof m[1] === 'string') term.write(m[1])
    const [c, r] = [cells(m[1]), cells(m[2])]
    if (m[0] === 'size' && c !== null && r !== null) term.resize(c, r)
  })
  // tmux's client leaves on SIGTERM and types nothing into the pane. The pty closes only after it
  // has: what closing it may write would otherwise reach the client as keys, and the worker.
  ws.on('close', () => proc.kill())
  void proc.exited.then(() => {
    proc.terminal?.close()
    ws.close(1000, 'detached')
  })
}

function parse(data: RawData): unknown[] | null {
  try {
    const m: unknown = JSON.parse(String(data))
    return Array.isArray(m) ? m : null
  } catch {
    return null
  }
}
