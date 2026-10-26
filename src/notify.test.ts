import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, createReadStream, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { notify, runGroup } from './notify'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const event = { event: 'cancelled', task: { id: 1, brief: 'b', issue: null } } as const

// A home whose <home>/notify is `body`, with `mode`.
function withNotify(body: string, mode: number): string {
  const home = tmp.make('nod-notify-')
  writeFileSync(join(home, 'notify'), body)
  chmodSync(join(home, 'notify'), mode)
  return home
}

test('a notify script that cannot run is reported on stderr and throws nothing', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await notify(withNotify('#!/bin/sh\nexit 0\n', 0o644), event) // not executable
    await notify(withNotify('exit 0\n', 0o755), event) // no #! line
    expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('EACCES'),
      expect.stringContaining('ENOEXEC'),
    ])
  } finally {
    errors.mockRestore()
  }
})

test('a notify script past its time ends with what it started, which holds its stderr', async () => {
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const started = Date.now()
    // A limit long enough for `sleep` to be running when it passes.
    await notify(withNotify('#!/bin/sh\nsleep 5\n', 0o755), event, 1000)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})

test('a notify script that ends leaves what it put in the background running, unwaited', async () => {
  const home = tmp.make('nod-notify-')
  const mark = join(home, 'sent')
  writeFileSync(join(home, 'notify'), `#!/bin/sh\n(sleep 2; touch ${JSON.stringify(mark)}) &\n`)
  chmodSync(join(home, 'notify'), 0o755)
  const started = Date.now()
  await notify(home, event)
  expect(Date.now() - started).toBeLessThan(1500)
  const deadline = Date.now() + 4000
  while (!existsSync(mark) && Date.now() < deadline) await Bun.sleep(50)
  expect(existsSync(mark)).toBe(true)
})

test('a command past its time ends with what it started, which holds its output', async () => {
  // `sleep` is the child of `sh` (`; :` keeps `sh` from becoming it) and holds the output. Killing
  // only `sh` would leave it running, and the run waiting out the grace for the output to close.
  // A limit long enough for `sleep` to be running when it passes.
  const started = Date.now()
  const run = await runGroup(['sh', '-c', 'sleep 30; :'], {
    env: process.env,
    timeoutMs: 1000,
    graceMs: 5000,
  })
  expect(run.code).not.toBe(0)
  expect(Date.now() - started).toBeLessThan(5000)
}, 15_000)

// A nod process of its own running `body` with runGroup, and a reader of the lines it prints.
function nodProcess(body: string) {
  const script = `import { runGroup } from ${JSON.stringify(join(import.meta.dir, 'notify.ts'))}\n${body}`
  const proc = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'inherit' })
  const reader = proc.stdout.getReader()
  let buffer = ''
  const line = async (): Promise<string> => {
    while (!buffer.includes('\n')) {
      const r = await reader.read()
      if (r.done) return buffer
      buffer += Buffer.from(r.value).toString()
    }
    const end = buffer.indexOf('\n')
    const next = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    return next
  }
  return { proc, line }
}

test('a signal that ends nod goes first to the commands it runs, with what they started', async () => {
  // `sh` and its child `sleep` hold the fifo open until they end: the read ends only then. `sh`
  // marks that the signal itself reached it, which SIGKILL would not let it do (git's lock). The
  // signal goes once `sh` has said, through the fifo, that `sleep` is started.
  const dir = tmp.make('nod-group-')
  const fifo = join(dir, 'held')
  const mark = join(dir, 'got')
  Bun.spawnSync(['mkfifo', fifo])
  const script = `{ trap 'echo got > "${mark}"; exit' HUP; sleep 30 & echo; wait; } > "${fifo}"`
  const { proc, line } = nodProcess(
    `void runGroup(${JSON.stringify(['sh', '-c', script])}, { env: process.env })\nconsole.log('up')`,
  )
  const held = createReadStream(fifo)[Symbol.asyncIterator]()
  await Promise.all([held.next(), line()])
  proc.kill('SIGHUP')
  while (!(await held.next()).done);
  expect(existsSync(mark)).toBe(true)
  await proc.exited
  // With no handler of its own, the process ends on the signal as before.
  expect(proc.signalCode).toBe('SIGHUP')
}, 10_000)

test('a nod process with a handler of its own for the signal leaves its commands to it', async () => {
  const go = join(tmp.make('nod-group-'), 'go')
  const cmd = ['sh', '-c', `while [ ! -e ${JSON.stringify(go)} ]; do sleep 0.05; done`]
  const { proc, line } = nodProcess(`
process.on('SIGINT', () => console.log('got'))
const run = runGroup(${JSON.stringify(cmd)}, { env: process.env })
console.log('up')
console.log((await run).code)
`)
  expect(await line()).toBe('up')
  proc.kill('SIGINT')
  // Its handler runs before runGroup's, in the same emit.
  expect(await line()).toBe('got')
  writeFileSync(go, '')
  expect(await line()).toBe('0')
  expect(await proc.exited).toBe(0)
}, 10_000)

test('a command that ended in time is not killed while its output is waited on', async () => {
  // The limit passes during the wait once `sh` has ended within it (it takes milliseconds, and the
  // limit leaves seconds for a slow start): the wait is longer than the limit and ends only when
  // what was left in the background, holding the output, has done its work.
  const mark = join(tmp.make('nod-group-'), 'sent')
  const left = ['sh', '-c', `(sleep 4; touch ${JSON.stringify(mark)}) &`]
  const run = await runGroup(left, { env: process.env, timeoutMs: 3000, graceMs: 10_000 })
  expect(run.code).toBe(0)
  expect(existsSync(mark)).toBe(true)
}, 15_000)
