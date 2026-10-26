import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { running } from '../src/worker'

// A test run keeps its tmux sockets in a temp dir of its own (TMUX_TMPDIR), so its servers leave
// nothing in the shared tmux dir and never meet nod's own. The servers are daemons: a run cut off
// before its afterAll (a timeout, Claude Code restarting, a person stopping it) leaves them, and the
// fake agents and `nod run` in them, for good (once 29 servers and 670MB for two days). So a run
// first ends the servers of runs that are over, and only those: workers run `bun test` side by side.
const PREFIX = 'nod-tmux-'
// The pid of the run that made the dir.
const OWNER = 'owner'
// A dir with no owner is a run's from before runs left one, or one whose run is still writing it,
// over once this old: a run takes minutes.
const UNOWNED_MS = 86_400_000
// A server that does not answer (stopped, say) must not hold up every later run.
const KILL_TIMEOUT_MS = 10_000

// Sets TMUX_TMPDIR to a new dir `tmp` removes, once the dirs of runs that are over are gone.
export function testTmux(tmp: { make: (prefix: string) => string }): string {
  endFinishedRuns()
  const dir = tmp.make(PREFIX)
  writeFileSync(join(dir, OWNER), String(process.pid))
  process.env.TMUX_TMPDIR = dir
  // tmux exits 0 even when it cannot make a socket (inside a sandbox), so the tests that need a
  // server would only time out; this says why, once.
  const env = process.env
  const tried = Bun.spawnSync(['tmux', '-L', 'try', 'new-session', '-d', 'true'], { env })
  if (tried.stderr.length > 0) console.error(`tmux cannot run here: ${tried.stderr.toString()}`)
  Bun.spawnSync(['tmux', '-L', 'try', 'kill-server'], { env })
  return dir
}

// `parent`: where runs make their dirs (tmp.make).
export function endFinishedRuns(parent = tmpdir(), now = Date.now()): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(PREFIX)) continue
    const dir = join(parent, name)
    try {
      if (!over(dir, now)) continue
      // A server this process cannot reach (from inside a sandbox) keeps its dir: without the
      // socket nothing could reach it again.
      if (sockets(dir).every(stop)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // Gone meanwhile, with the afterAll of its run.
    }
  }
}

function over(dir: string, now: number): boolean {
  const owner = join(dir, OWNER)
  const pid = existsSync(owner) ? Number(readFileSync(owner, 'utf8')) : 0
  if (!(pid > 0)) return now - statSync(dir).mtimeMs > UNOWNED_MS
  return !running(pid)
}

// tmux keeps a user's sockets in tmux-<uid>.
const sockets = (dir: string): string[] =>
  readdirSync(dir)
    .filter((d) => d.startsWith('tmux-'))
    .flatMap((d) => readdirSync(join(dir, d)).map((s) => join(dir, d, s)))

// Whether no server runs on `socket` once this is done. tmux says `no server running` for a socket
// its server left, and ENOENT once the socket is gone too.
function stop(socket: string): boolean {
  const kill = Bun.spawnSync(['tmux', '-S', socket, 'kill-server'], {
    stderr: 'pipe',
    timeout: KILL_TIMEOUT_MS,
  })
  return (
    kill.exitCode === 0 ||
    /no server running|No such file or directory/.test(kill.stderr.toString())
  )
}
