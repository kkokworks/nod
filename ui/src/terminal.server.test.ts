import { afterAll, expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { sessionName } from '../../src/place'
import { homeId, Terminals } from '../../src/tmux'
import { socketsParent, tempDirs } from '../../test/tmp'
import { testTmux } from '../../test/tmux'
import { tmuxTest } from '../../test/tmux-server'
import { NO_SESSION, serveTerminals } from './terminal.server'

const tmp = tempDirs()
testTmux(tmp)
const home = tmp.make('nod-ui-term-')
const terminals = Terminals.of(home)
// On a Unix socket: a worker's sandbox opens no TCP port.
const listening = join(tmp.make('nod-ui-', socketsParent()), 's')
const server = createServer()
serveTerminals(server, terminals)
await new Promise<void>((done) => server.listen(listening, done))
afterAll(() => {
  server.close()
  terminals.killServer()
  tmp.removeAll()
})

const PAGE = { Origin: 'http://127.0.0.1:4800', Host: '127.0.0.1:4800' }

type Frame = { op: number; data: Buffer }
type Peer = {
  status: string
  next: () => Promise<Frame>
  // Resolves once what the server sent so far, as text, has `text`; rejects if it closes first.
  until: (text: string) => Promise<void>
  send: (m: unknown[]) => void
  end: () => void
}

// A browser's side of the WebSocket: the handshake with `headers`, then frames.
function upgrade(target: string, headers: Record<string, string>): Promise<Peer> {
  const socket = connect(listening)
  let buf = Buffer.alloc(0)
  let shown = Buffer.alloc(0)
  let closed = false
  const frames: Frame[] = []
  const waiting: (() => void)[] = []
  const wake = () => {
    for (const w of waiting.splice(0)) w()
  }
  const wait = async (ready: () => boolean): Promise<void> => {
    while (!ready()) {
      if (closed) throw new Error(`closed first; it showed ${JSON.stringify(shown.toString())}`)
      await new Promise<void>((w) => waiting.push(w))
    }
  }
  return new Promise((resolve, reject) => {
    let status: string | null = null
    const peer: Peer = {
      get status() {
        return status ?? ''
      },
      next: async () => {
        await wait(() => frames.length > 0)
        return frames.shift() as Frame
      },
      until: (text) => wait(() => shown.toString().includes(text)),
      send: (m) => socket.write(masked(JSON.stringify(m))),
      end: () => socket.destroy(),
    }
    socket.on('error', reject)
    // Closed with no answer, as the server refuses: the status is ''.
    socket.on('close', () => {
      closed = true
      wake()
      resolve(peer)
    })
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (status === null) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        status = buf.subarray(0, buf.indexOf('\r\n')).toString()
        buf = buf.subarray(end + 4)
        resolve(peer)
      }
      for (let f = frame(buf); f !== null; f = frame(buf)) {
        buf = buf.subarray(f.size)
        frames.push(f)
        if (f.op === 2) shown = Buffer.concat([shown, f.data])
      }
      wake()
    })
    const lines = Object.entries({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg==',
      ...headers,
    }).map(([name, value]) => `${name}: ${value}\r\n`)
    socket.write(`GET ${target} HTTP/1.1\r\n${lines.join('')}\r\n`)
  })
}

// One whole frame from the server, which masks none, or null until all of it is here.
function frame(buf: Buffer): (Frame & { size: number }) | null {
  const short = (buf[1] ?? 0) & 0x7f
  const at = short === 126 ? 4 : short === 127 ? 10 : 2
  if (buf.length < at) return null
  const length =
    short === 126 ? buf.readUInt16BE(2) : short === 127 ? Number(buf.readBigUInt64BE(2)) : short
  if (buf.length < at + length) return null
  return { op: (buf[0] ?? 0) & 0x0f, data: buf.subarray(at, at + length), size: at + length }
}

// A text frame, masked as a client's must be.
function masked(text: string): Buffer {
  const body = Buffer.from(text)
  const mask = [1, 2, 3, 4]
  const head =
    body.length < 126
      ? [0x81, 0x80 | body.length]
      : [0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]
  return Buffer.from([...head, ...mask, ...body.map((b, i) => b ^ (mask[i % 4] ?? 0))])
}

test("only the UI's own page attaches to a worker's terminal: another site, a name that only leads here, and no origin are refused", async () => {
  const refused: Record<string, string>[] = [
    { Origin: 'https://evil.example', Host: '127.0.0.1:4800' },
    { Origin: 'http://127.0.0.1:4801', Host: '127.0.0.1:4800' },
    // A site whose own name leads to this computer (DNS rebinding) is of its own origin.
    { Origin: 'http://evil.example:4800', Host: 'evil.example:4800' },
    { Origin: 'null', Host: '127.0.0.1:4800' },
    { Host: '127.0.0.1:4800' },
  ]
  for (const headers of refused) {
    const peer = await upgrade('/terminal/1?cols=80&rows=24', headers)
    expect({ headers, status: peer.status }).toEqual({ headers, status: '' })
  }
  expect((await upgrade('/terminal/1?cols=0&rows=24', PAGE)).status).toBe('')
  // The page's own is let in, and told when the task has no session to show.
  for (const host of ['127.0.0.1:4800', 'localhost:4800', '[::1]:4800']) {
    const peer = await upgrade('/terminal/1?cols=80&rows=24', {
      Origin: `http://${host}`,
      Host: host,
    })
    expect(peer.status).toStartWith('HTTP/1.1 101')
    const close = await peer.next()
    expect([close.op, close.data.readUInt16BE(0)]).toEqual([8, NO_SESSION])
    peer.end()
  }
})

// What the server runs to attach, caught before it runs: the sandbox opens no pseudo-terminal.
test("the server attaches as nod attach does, telling tmux the page's terminal takes RGB colour, outside any tmux and in UTF-8", async () => {
  const alive = spyOn(Terminals.prototype, 'alive').mockReturnValue(true)
  let ran: { argv: string[]; env: Record<string, string | undefined> } | undefined
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((
    argv: string[],
    options: { env: Record<string, string | undefined> },
  ) => {
    ran = { argv, env: options.env }
    throw new Error('no pty here')
  }) as never)
  const before = { TMUX: process.env.TMUX, LC_ALL: process.env.LC_ALL }
  process.env.TMUX = '/tmp/outer,1,0'
  process.env.LC_ALL = 'C'
  try {
    const peer = await upgrade('/terminal/7?cols=80&rows=24', PAGE)
    const close = await peer.next()
    expect([close.op, close.data.readUInt16BE(0)]).toEqual([8, 1011])
    peer.end()
  } finally {
    alive.mockRestore()
    spawn.mockRestore()
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  expect(ran?.argv).toEqual([
    'tmux',
    '-L',
    `nod-${homeId(home)}`,
    '-T',
    'RGB',
    'attach',
    '-t',
    `=${sessionName(7)}`,
  ])
  expect(ran?.env).toMatchObject({ TERM: 'xterm-256color', LC_CTYPE: 'UTF-8' })
  expect(ran?.env.TMUX).toBeUndefined()
  expect(ran?.env.LC_ALL).toBeUndefined()
})

// tmux on this home's socket.
const tmux = (...args: string[]) =>
  Bun.spawn(['tmux', '-L', `nod-${homeId(home)}`, ...args], { env: process.env }).exited
// The size of the terminals attached to a session, as tmux has them. The window's own follows by
// tmux's rules: a row less with the status line, none of it with a manual window-size.
const sizes = (name: string): string =>
  Bun.spawnSync(
    [
      'tmux',
      '-L',
      `nod-${homeId(home)}`,
      'list-clients',
      '-t',
      `=${name}`,
      '-F',
      '#{client_width}x#{client_height}',
    ],
    { env: process.env },
  )
    .stdout.toString()
    .trim()

tmuxTest(
  "a page attached to a worker's terminal shows it, types into it and sizes it, counts as a person there, and leaving types nothing more",
  async () => {
    const name = sessionName(2)
    const typed = join(home, 'typed')
    // A worker that keeps each byte it is given before it shows it.
    const recorder = join(home, 'recorder.js')
    writeFileSync(
      recorder,
      `const { appendFileSync } = require('node:fs')
process.stdin.setRawMode(true)
process.stdout.write('ready ')
process.stdin.on('data', (d) => { appendFileSync(${JSON.stringify(typed)}, d); process.stdout.write(d) })
`,
    )
    writeFileSync(typed, '')
    terminals.start(name, home, [process.execPath, recorder], { HOME: home })
    // With no locale that says UTF-8, as launchd starts the server, and an LC_ALL that tmux reads
    // first: tmux would then draw Korean as underscores.
    const locale = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
    }
    for (const key of Object.keys(locale)) delete process.env[key]
    process.env.LC_ALL = 'C'
    try {
      const page = await upgrade('/terminal/2?cols=90&rows=20', PAGE)
      expect(page.status).toStartWith('HTTP/1.1 101')
      await page.until('ready')
      // As a person in a terminal is: gc and the tick leave the session alone.
      expect(terminals.attached(name)).toBe(true)
      expect(sizes(name)).toBe('90x20')
      // So tmux passes the worker's RGB colours on as they are.
      const features = Bun.spawnSync(
        [
          'tmux',
          '-L',
          `nod-${homeId(home)}`,
          'list-clients',
          '-t',
          `=${name}`,
          '-F',
          '#{client_termfeatures}',
        ],
        { env: process.env },
      )
      expect(features.stdout.toString().trim().split(',')).toContain('RGB')

      await tmux('set-hook', '-g', 'client-resized', 'wait-for -S resized')
      page.send(['size', 100, 30])
      await tmux('wait-for', 'resized')
      expect(sizes(name)).toBe('100x30')

      page.send(['in', 'ab한'])
      await page.until('한')
      expect(readFileSync(typed, 'utf8')).toBe('ab한')

      // The page goes as a closed tab does. Then a key sent past it shows whether leaving typed any.
      await tmux('set-hook', '-g', 'client-detached', 'wait-for -S left')
      page.end()
      await tmux('wait-for', 'left')
      expect(terminals.attached(name)).toBe(false)
      await tmux('send-keys', '-t', `=${name}:`, '-l', 'Z')
      const again = await upgrade('/terminal/2?cols=90&rows=20', PAGE)
      await again.until('Z')
      expect(readFileSync(typed, 'utf8')).toBe('ab한Z')
      again.end()
      expect(terminals.alive(name)).toBe(true)
    } finally {
      for (const [key, value] of Object.entries(locale)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
  20_000,
)
