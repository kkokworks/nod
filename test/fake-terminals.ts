import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pasted, running, type Terminals } from '../src/tmux'

// Stands in for tmux (Tmux in src/tmux.ts) without a pseudo-terminal, which a worker's sandbox does
// not open (`openpty: Operation not permitted`), so the tests of what nod does with its workers run
// there too. A session's process runs on its own, in a process group of its own as in tmux, with a
// FIFO for its keyboard and a file for its screen. What tmux keeps of a session (its process, its
// options, a person attached) is in files under the home: `nod run` and the hooks of the Claude Code
// in it read and change them from processes of their own, which fake-terminals-preload.ts gives
// these terminals. What tmux itself does (its command size, its environment, its paste, its
// clients) is tested on tmux (test/tmux-server.ts).
// ponytail: the screen is everything printed since the last clear, not a 200x50 grid; nod and the
// fake agent only look for words on it.

// The keys nod sends (Terminals.keys), as a terminal sends them.
const KEYS: Record<string, string> = { Enter: '\r', Escape: '\x1b', Down: '\x1b[B' }
const ESC = '\x1b'
const ROWS = 50
// As Tmux.close.
const EXIT_TIMEOUT_MS = 15_000
// ponytail: BUN_OPTIONS takes no quotes (Bun 1.3.14 ignores a quoted path), so a repo whose path has
// a space fails every session with `Module not found`; quote it once Bun reads quotes.
const PRELOAD = resolve(import.meta.dir, 'fake-terminals-preload.ts')
// The test run whose sessions these are: a session ends once it is gone (fake-terminals-preload.ts).
export const OWNER = 'NOD_FAKE_TERMINALS_OWNER'

// What `file` holds; null once it is gone, also when another process removes it as this reads it.
function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Writes `file` whole: processes of their own read what a session keeps at any time, and one that
// read it half written would take the session for gone (an empty pid) or the option for unset.
function put(file: string, value: string): void {
  const part = `${file}.${process.pid}`
  writeFileSync(part, value)
  renameSync(part, file)
}

export class FakeTerminals implements Terminals {
  private constructor(private readonly dir: string) {}

  static of(home: string): FakeTerminals {
    return new FakeTerminals(join(home, 'fake-terminals'))
  }

  // As Tmux.start: `argv` runs in `cwd` with `env` and only the TERM, TMUX and TMUX_PANE a pane has,
  // and what makes its Bun processes use these terminals. The session is there before its process
  // starts, as tmux makes it first.
  start(name: string, cwd: string, argv: string[], env: Record<string, string>): void {
    if (this.alive(name)) throw new Error(`duplicate session: ${name}`)
    const at = this.at(name)
    rmSync(at, { recursive: true, force: true })
    rmSync(this.stopFile(name), { force: true })
    mkdirSync(join(at, 'options'), { recursive: true })
    const keyboard = join(at, 'in')
    const made = Bun.spawnSync(['mkfifo', keyboard], { stderr: 'pipe' })
    if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString().trim()}`)
    const pane = `%${crypto.randomUUID()}`
    put(join(at, 'created'), String(Date.now()))
    put(join(at, 'pane'), pane)
    const all = {
      ...env,
      TERM: 'tmux-256color',
      TMUX: this.dir,
      TMUX_PANE: pane,
      BUN_OPTIONS: `--preload ${PRELOAD}`,
      [OWNER]: process.env[OWNER] || String(process.pid),
    }
    // Its keyboard is open to read and write from the start, so keys typed before it reads wait for
    // it, and it never reads an end. Detached, as proc.ts runs a command: a session and process group
    // of its own, so it outlives whatever started it and closes as a whole, as a tmux pane does.
    const keys = openSync(keyboard, constants.O_RDWR)
    const screen = openSync(join(at, 'screen'), 'a')
    // A session that did not start is not there, nor does it count as starting (alive).
    try {
      const proc = Bun.spawn(argv, {
        cwd,
        env: all,
        stdio: [keys, screen, screen],
        detached: true,
      })
      proc.unref()
      put(join(at, 'pid'), String(proc.pid))
    } catch (error) {
      rmSync(at, { recursive: true, force: true })
      throw error
    } finally {
      closeSync(keys)
      closeSync(screen)
    }
  }

  alive(name: string): boolean {
    if (!existsSync(join(this.at(name), 'pane'))) return false
    const pid = this.pid(name)
    return pid === null || running(pid)
  }

  sessions(): Set<string> {
    if (!existsSync(this.dir)) return new Set()
    return new Set(readdirSync(this.dir).filter((n) => !n.startsWith('.') && this.alive(n)))
  }

  sessionOptions(...keys: string[]): Map<string, string[]> {
    return new Map([...this.sessions()].map((n) => [n, keys.map((k) => this.option(n, k))]))
  }

  option(name: string, key: string): string {
    return read(join(this.live(name), 'options', key)) ?? ''
  }

  setOption(name: string, key: string, value: string | null): void {
    const file = join(this.live(name), 'options', key)
    if (value === null) rmSync(file, { force: true })
    else put(file, value)
  }

  stopped(name: string): boolean {
    return existsSync(this.stopFile(name))
  }

  attached(name: string): boolean {
    return this.alive(name) && existsSync(join(this.at(name), 'attached'))
  }

  // As tmux has it, in seconds: when the session began, or a person last attached to it.
  lastUsed(name: string): number {
    if (!this.alive(name)) return 0
    const times = ['created', 'last-attached'].map((f) => Number(read(join(this.at(name), f))))
    return Math.floor(Math.max(...times) / 1000) * 1000
  }

  send(name: string, text: string): void {
    this.type(name, `${pasted(text)}${KEYS.Enter}`)
  }

  keys(name: string, ...keys: string[]): void {
    this.type(
      name,
      keys
        .map((k) => {
          const sent = KEYS[k]
          if (sent === undefined) throw new Error(`the fake terminals have no key ${k}`)
          return sent
        })
        .join(''),
    )
  }

  screen(name: string): string {
    const raw = readFileSync(join(this.live(name), 'screen'), 'utf8')
    const shown = raw.split(`${ESC}[2J`).at(-1) ?? ''
    const text = shown
      .replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '')
    return text.split('\n').slice(-ROWS).join('\n')
  }

  // As tmux kill-session: marks it stopped, hangs up its process group, and the session is gone.
  kill(name: string): void {
    if (!this.alive(name)) return
    writeFileSync(this.stopFile(name), '')
    this.hangUp(name, 'SIGHUP')
    rmSync(this.at(name), { recursive: true, force: true })
  }

  async close(name: string): Promise<boolean> {
    if (!this.alive(name)) return false
    const pid = this.panePid(name)
    this.kill(name)
    const deadline = Date.now() + EXIT_TIMEOUT_MS
    while (running(pid)) {
      if (Date.now() > deadline) throw new Error(`${name} did not exit (pid ${pid})`)
      await Bun.sleep(100)
    }
    rmSync(this.stopFile(name), { force: true })
    return true
  }

  attachCommand(): string[] {
    throw new Error('the fake terminals take no client: a test attaches with attach()')
  }

  panePid(name: string): number {
    const pid = this.pid(name)
    if (pid === null || !this.alive(name)) throw new Error(`can't find session: ${name}`)
    return pid
  }

  pane(name: string): string | null {
    return this.alive(name) ? read(join(this.at(name), 'pane')) : null
  }

  // As a person does with nod attach, and as they leave.
  attach(name: string): void {
    writeFileSync(join(this.live(name), 'attached'), '')
    put(join(this.at(name), 'last-attached'), String(Date.now()))
  }

  detach(name: string): void {
    rmSync(join(this.at(name), 'attached'), { force: true })
  }

  // As tmux kill-server: ends every session at once, as a test run does once it is over.
  killAll(): void {
    if (!existsSync(this.dir)) return
    // Only the live ones: the pid of one that ended may be another process's by now.
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('.') && this.alive(name)) this.hangUp(name, 'SIGKILL')
    }
    rmSync(this.dir, { recursive: true, force: true })
  }

  private hangUp(name: string, signal: NodeJS.Signals): void {
    const pid = this.pid(name)
    if (pid === null) return
    try {
      process.kill(-pid, signal)
    } catch (error) {
      // Gone already, unless it is there with no group of its own: then it would outlive its session.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH' && running(pid)) throw error
    }
  }

  private type(name: string, keys: string): void {
    // Opens only while something reads it (ENXIO otherwise): a session whose process is gone takes no
    // keys, as tmux refuses them.
    const fd = openSync(join(this.live(name), 'in'), constants.O_WRONLY | constants.O_NONBLOCK)
    try {
      let left = Buffer.from(keys)
      while (left.length > 0) {
        try {
          left = left.subarray(writeSync(fd, left))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
          Bun.sleepSync(5)
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  private pid(name: string): number | null {
    const pid = read(join(this.at(name), 'pid'))
    return pid === null ? null : Number(pid)
  }

  // The session's folder, which must be live, as tmux refuses a session it does not have.
  private live(name: string): string {
    if (!this.alive(name)) throw new Error(`can't find session: ${name}`)
    return this.at(name)
  }

  private at(name: string): string {
    return join(this.dir, name)
  }

  private stopFile(name: string): string {
    return join(this.dir, `.stop-${name}`)
  }
}
