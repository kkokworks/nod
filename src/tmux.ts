import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Longer than an account command (account.ts, 10s), which runs synchronously, so the process that
// keeps a worker's Claude Code running may not hear the session end until it is done.
const EXIT_TIMEOUT_MS = 15_000

// Names what nod keeps per home outside it: the tmux socket and the OS scheduler job.
export const homeId = (home: string): string => Bun.hash(home).toString(36)

// Workers run in tmux so they outlive nod's own processes and a person can attach to watch or step
// in. Each nod home gets its own tmux server (socket), and each task its own tmux session.
export class Terminals {
  private constructor(
    private readonly socket: string,
    private readonly dir: string,
  ) {}

  static of(home: string): Terminals {
    return new Terminals(`nod-${homeId(home)}`, join(home, 'work'))
  }

  // `argv` runs with `env` and nothing else of the environment but the TERM, TMUX and TMUX_PANE
  // tmux sets for the pane. tmux would start it with its server's environment, which is whatever
  // first started the server, a terminal's or an agent host's markers for its own pane among it.
  // tmux refuses a command over about 16KB (measured on 3.6a), less than a long brief or a
  // retrospective's history, so `argv` goes in a script that removes itself once sh has it open,
  // readable only by its owner since `env` may hold credentials (a proxy's, an API key).
  // ponytail: the OS limit on arguments (1MB on macOS) still applies.
  start(name: string, cwd: string, argv: string[], env: Record<string, string>): void {
    const vars = Object.entries(env).map(([key, value]) => quote(`${key}=${value}`))
    mkdirSync(this.dir, { recursive: true })
    rmSync(this.stopFile(name), { force: true })
    const script = join(this.dir, `.launch-${name}`)
    writeFileSync(
      script,
      `rm -f -- "$0"\nexec env -i TERM="$TERM" TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${[...vars, ...argv.map(quote)].join(' ')}\n`,
      { mode: 0o600 },
    )
    this.tmux(['new-session', '-d', '-s', name, '-x200', '-y50', '-c', cwd, '--', 'sh', script])
  }

  alive(name: string): boolean {
    return this.run(['has-session', '-t', `=${name}`]).exitCode === 0
  }

  // The sessions there are, in one call; none when the server is not running.
  sessions(): Set<string> {
    const list = this.run(['list-sessions', '-F', '#{session_name}'])
    if (list.exitCode !== 0) return new Set()
    return new Set(list.stdout.toString().split('\n').filter(Boolean))
  }

  // A value nod keeps on a session, gone with it; '' when unset.
  option(name: string, key: string): string {
    return this.tmux(['show-options', '-qv', '-t', `=${name}:`, `@${key}`]).trim()
  }

  setOption(name: string, key: string, value: string | null): void {
    const set = value === null ? ['-u', `@${key}`] : [`@${key}`, value]
    this.tmux(['set-option', '-q', '-t', `=${name}:`, ...set])
  }

  // Whether nod ended the session on purpose (kill, close), for what runs in it to tell from Claude
  // Code ending on its own.
  stopped(name: string): boolean {
    return existsSync(this.stopFile(name))
  }

  // Whether a person has the session open (nod attach).
  attached(name: string): boolean {
    const clients = this.run(['list-clients', '-t', `=${name}`])
    return clients.exitCode === 0 && clients.stdout.toString().trim() !== ''
  }

  // When a person was last at the session, in ms (tmux keeps seconds): their last attach, or the
  // last key they typed in it, which tmux counts as the session's activity (as lock-after-time
  // does); 0 once the session is gone.
  lastUsed(name: string): number {
    const times = '#{session_activity} #{session_last_attached}'
    const shown = this.run(['display-message', '-p', '-t', `=${name}:`, times])
    if (shown.exitCode !== 0) return 0
    const seconds = shown.stdout.toString().trim().split(' ').map(Number)
    return Math.max(0, ...seconds.map((s) => s * 1000 || 0))
  }

  // A bracketed paste keeps a multi-line message together; Enter then sends it. Control characters
  // but newline and tab go first: a message may carry text from elsewhere (what a watch printed),
  // and an escape in it (`ESC[201~`) could end the paste early and type the rest as keys.
  send(name: string, text: string): void {
    this.tmux(['load-buffer', '-b', name, '-'], text.replace(/[^\P{Cc}\n\t]/gu, ''))
    this.tmux(['paste-buffer', '-p', '-r', '-d', '-b', name, '-t', `=${name}:`])
    this.keys(name, 'Enter')
  }

  keys(name: string, ...keys: string[]): void {
    this.tmux(['send-keys', '-t', `=${name}:`, ...keys])
  }

  screen(name: string): string {
    return this.tmux(['capture-pane', '-p', '-t', `=${name}:`])
  }

  kill(name: string): void {
    if (!this.alive(name)) return
    writeFileSync(this.stopFile(name), '')
    this.tmux(['kill-session', '-t', `=${name}`])
  }

  // Also waits for the process in it to exit: Claude Code still writes its session files while it
  // shuts down, which would recreate a session folder deleted right after. Returns whether there
  // was a session to close.
  async close(name: string): Promise<boolean> {
    if (!this.alive(name)) return false
    const pid = this.panePid(name)
    this.kill(name)
    const deadline = Date.now() + EXIT_TIMEOUT_MS
    while (isRunning(pid)) {
      if (Date.now() > deadline) throw new Error(`${name} did not exit (pid ${pid})`)
      await Bun.sleep(100)
    }
    rmSync(this.stopFile(name), { force: true })
    return true
  }

  killServer(): void {
    this.run(['kill-server'])
  }

  attachCommand(name: string): string[] {
    return ['tmux', '-L', this.socket, 'attach', '-t', `=${name}`]
  }

  // The process the session started with (`argv` of start).
  panePid(name: string): number {
    return Number(this.tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']))
  }

  // The session's pane (TMUX_PANE inside it), or null without the session; a session of the same
  // name started again has another.
  pane(name: string): string | null {
    const shown = this.run(['display-message', '-p', '-t', `=${name}:`, '#{pane_id}'])
    return shown.exitCode === 0 ? shown.stdout.toString().trim() : null
  }

  private stopFile(name: string): string {
    return join(this.dir, `.stop-${name}`)
  }

  private tmux(args: string[], stdin?: string): string {
    const result = this.run(args, stdin)
    if (result.exitCode !== 0) {
      throw new Error(`tmux ${args[0]} failed: ${result.stderr.toString().trim()}`)
    }
    return result.stdout.toString()
  }

  private run(args: string[], stdin?: string): Bun.SyncSubprocess<'pipe', 'pipe'> {
    return Bun.spawnSync(['tmux', '-L', this.socket, ...args], {
      stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
      env: process.env,
    })
  }
}

// For sh: inside single quotes everything is literal.
export function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
