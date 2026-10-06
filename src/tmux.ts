const EXIT_TIMEOUT_MS = 10_000

// Names what nod keeps per home outside it: the tmux socket and the OS scheduler job.
export const homeId = (home: string): string => Bun.hash(home).toString(36)

// Workers run in tmux so they outlive nod's own processes and a person can attach to watch or step
// in. Each nod home gets its own tmux server (socket), and each task its own tmux session.
export class Terminals {
  private constructor(private readonly socket: string) {}

  static of(home: string): Terminals {
    return new Terminals(`nod-${homeId(home)}`)
  }

  // tmux starts commands with its server's environment, so pass what the worker needs in `env`.
  start(name: string, cwd: string, argv: string[], env: Record<string, string>): void {
    const vars = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
    this.tmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      cwd,
      ...vars,
      '--',
      ...argv,
    ])
  }

  alive(name: string): boolean {
    return this.run(['has-session', '-t', `=${name}`]).exitCode === 0
  }

  // A bracketed paste keeps a multi-line message together; Enter then sends it.
  send(name: string, text: string): void {
    this.tmux(['load-buffer', '-b', name, '-'], text)
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
    if (this.alive(name)) this.tmux(['kill-session', '-t', `=${name}`])
  }

  // Also waits for the process in it to exit: Claude Code still writes its session files while it
  // shuts down, which would recreate a session folder deleted right after.
  async close(name: string): Promise<void> {
    if (!this.alive(name)) return
    const pid = Number(this.tmux(['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']))
    this.kill(name)
    const deadline = Date.now() + EXIT_TIMEOUT_MS
    while (isRunning(pid)) {
      if (Date.now() > deadline) throw new Error(`${name} did not exit (pid ${pid})`)
      await Bun.sleep(100)
    }
  }

  killServer(): void {
    this.run(['kill-server'])
  }

  attachCommand(name: string): string[] {
    return ['tmux', '-L', this.socket, 'attach', '-t', `=${name}`]
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

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
