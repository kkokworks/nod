// A worker's terminal: tmux attached to its session in a PTY the app runs, drawn by xterm.js. The
// app knows the task by the window, and ends the PTY when the window closes, which detaches tmux;
// the worker goes on. xterm.js is copied in by `bun run vendor` (package.json).
import { FitAddon } from './vendor/addon-fit.mjs'
import { Terminal } from './vendor/xterm.mjs'

const { invoke, Channel } = window.__TAURI__.core
const box = document.getElementById('terminal')
const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13 })
const fit = new FitAddon()
term.loadAddon(fit)
term.open(box)
fit.fit()

let ended = false
function end(message) {
  if (ended) return
  ended = true
  term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`)
}

const output = new Channel()
// An empty message once the PTY ends: tmux detached, or the session ended.
output.onmessage = (data) => {
  if (data.byteLength > 0) term.write(new Uint8Array(data))
  else end('[연결이 끝났습니다. 창을 닫아도 됩니다]')
}

// The PTY starts at the window's size. What is typed and each new size wait for it, and go one at a
// time, in order.
let queue = invoke('pty_open', { cols: term.cols, rows: term.rows, output }).catch((e) =>
  end(String(e)),
)
function send(command, args) {
  queue = queue.then(() => ended || invoke(command, args)).catch((e) => end(String(e)))
}
term.onData((data) => send('pty_write', { data }))
term.onResize((size) => send('pty_resize', size))
new ResizeObserver(() => fit.fit()).observe(box)
term.focus()
