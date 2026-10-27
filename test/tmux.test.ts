import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { socketsParent, tempDirs } from './tmp'
import { endFinishedRuns } from './tmux'
import { tmuxTest } from './tmux-server'

const tmp = tempDirs()
const runs: Run[] = []
afterAll(() => {
  for (const r of runs) {
    r.proc.kill('SIGKILL')
    Bun.spawnSync(['tmux', '-S', r.socket, 'kill-server'])
  }
  tmp.removeAll()
})

type Run = { proc: Bun.Subprocess; dir: string; socket: string }

// A test run as worker.test.ts begins one, making its dirs in `parent` (its TMPDIR, and where it
// keeps sockets), with a tmux server in its dir. Returns once the server is up. The names are
// short: a socket's path must fit in 104 bytes (macOS), and the temp dir there takes half.
async function begin(parent: string): Promise<Run> {
  const script = `
import { tempDirs } from ${JSON.stringify(resolve(import.meta.dir, 'tmp.ts'))}
import { testTmux } from ${JSON.stringify(resolve(import.meta.dir, 'tmux.ts'))}
const dir = testTmux(tempDirs())
const up = Bun.spawnSync(['tmux', '-L', 'r', 'new-session', '-d', 'sleep 600'], { env: process.env })
// tmux exits 0 even when it cannot make the socket (a sandbox), saying so on stderr.
if (up.exitCode !== 0 || up.stderr.length > 0) throw new Error(up.stderr.toString())
console.log(dir)
await new Promise(() => {})
`
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, TMPDIR: parent, NOD_SOCKETS: parent },
    stdout: 'pipe',
    stderr: 'inherit',
  })
  let out = ''
  for await (const chunk of proc.stdout) {
    out += Buffer.from(chunk).toString()
    if (out.includes('\n')) break
  }
  const dir = out.trim()
  if (dir === '') throw new Error(`the run ended first: ${await proc.exited}`)
  const run = { proc, dir, socket: join(dir, `tmux-${process.getuid?.()}`, 'r') }
  runs.push(run)
  return run
}

const serves = (socket: string): boolean =>
  Bun.spawnSync(['tmux', '-S', socket, 'has-session']).exitCode === 0

tmuxTest(
  'a test run ends the tmux servers a run cut off left behind, and leaves those of a run still going',
  async () => {
    const parent = tmp.make('nod-r-', socketsParent())
    const cut = await begin(parent)
    cut.proc.kill('SIGKILL')
    await cut.proc.exited
    // Cut off before its afterAll: its server stays.
    expect(serves(cut.socket)).toBe(true)

    const next = await begin(parent)
    expect(serves(cut.socket)).toBe(false)
    expect(existsSync(cut.dir)).toBe(false)

    // `next` is still going when another run begins.
    const other = await begin(parent)
    expect(serves(next.socket)).toBe(true)
    expect(existsSync(next.dir)).toBe(true)
    expect(serves(other.socket)).toBe(true)
  },
)

test("a run's dir is over once the run that made it is gone, or, with no owner yet or from before runs named theirs, a day on", () => {
  const parent = tmp.make('nod-runs-')
  const dir = (name: string, owner?: string): string => {
    const made = join(parent, name)
    mkdirSync(made)
    if (owner !== undefined) writeFileSync(join(made, 'owner'), owner)
    return made
  }
  const gone = String(Bun.spawnSync(['true']).pid)
  const over = dir('nod-tmux-over', gone)
  const going = dir('nod-tmux-going', String(process.pid))
  const older = dir('nod-tmux-older')
  // As a run sees the dir of one that is writing its owner just then.
  const writing = dir('nod-tmux-writing', '')
  const notTmux = dir('nod-worker-over', gone)

  endFinishedRuns(parent)
  expect([over, going, older, writing, notTmux].map((d) => existsSync(d))).toEqual([
    false,
    true,
    true,
    true,
    true,
  ])

  endFinishedRuns(parent, Date.now() + 86_400_000 + 60_000)
  expect([going, older, writing].map((d) => existsSync(d))).toEqual([true, false, false])
})

test("a test run keeps its sockets in the folder nod names only inside a worker's sandbox, and outside it, as nod's check runs, in the temp dir", () => {
  const sockets = tmp.make('nod-sockets-')
  expect(socketsParent({ SANDBOX_RUNTIME: '1', NOD_SOCKETS: sockets })).toBe(sockets)
  // The worker writes that folder, and the check runs outside its sandbox.
  expect(socketsParent({ NOD_SOCKETS: sockets })).toBe(tmpdir())
  // A worker nod started before it named one.
  expect(socketsParent({ SANDBOX_RUNTIME: '1' })).toBe(tmpdir())
  // A sandbox that does not let the tests make their dirs there, as a missing folder does not.
  expect(socketsParent({ SANDBOX_RUNTIME: '1', NOD_SOCKETS: join(sockets, 'gone') })).toBe(tmpdir())
})
