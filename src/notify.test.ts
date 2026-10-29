import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, createReadStream, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { notify } from './notify'
import { runGroup } from './proc'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const event = { event: 'cancelled', task: { id: 1, brief: 'b', issue: null } } as const

// What a limit below leaves, on top of what its run takes alone, for other work on the machine: a
// notify that takes half a second alone took three and a half under load.
const LOAD_MS = 5000
// The limit given to a command that does not end of itself, long enough for what it starts to be
// running when it passes. Were it not, under load, a test would check less, not fail.
const LIMIT_MS = 1000

// A shell loop that runs until the test lets it go, so that the test, not the clock, says when what
// runs it ends. It also ends once the temp dirs are removed or this process is gone: a test that
// failed, or a run cut short before afterAll, leaves nothing running.
function hold(): { loop: string; release: () => void } {
  const file = join(tmp.make('nod-hold-'), 'held')
  writeFileSync(file, '')
  const held = `[ -e ${JSON.stringify(file)} ] && kill -0 ${process.pid} 2>/dev/null`
  return {
    loop: `while ${held}; do sleep 0.05; done`,
    release: () => rmSync(file, { force: true }),
  }
}

// A home whose <home>/notify is `body`, with `mode`.
function withNotify(body: string, mode: number): string {
  const home = tmp.make('nod-notify-')
  writeFileSync(join(home, 'notify'), body)
  chmodSync(join(home, 'notify'), mode)
  return home
}

test(
  'a notify script that cannot run is reported on stderr and throws nothing',
  async () => {
    // Two runs, each of which the load may push.
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
  },
  2 * LOAD_MS,
)

test(
  'a notify script past its time ends with what it started, which holds its stderr',
  async () => {
    // The script runs until the test lets it go, once notify has returned: notify returns only
    // because the limit ended it.
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const held = hold()
    try {
      await notify(withNotify(`#!/bin/sh\n${held.loop}\n`, 0o755), event, LIMIT_MS)
      expect(errors).toHaveBeenCalledTimes(1)
    } finally {
      held.release()
      errors.mockRestore()
    }
  },
  LIMIT_MS + LOAD_MS,
)

test(
  'a notify script that ends leaves what it put in the background running, unwaited',
  async () => {
    // What the script puts in the background holds its output and runs until the test lets it go,
    // once notify has returned: had notify waited for it, notify would not return. So no clock, and
    // the grace notify gives the output can change without this test changing.
    const home = tmp.make('nod-notify-')
    const sent = join(home, 'sent')
    const held = hold()
    const script = `#!/bin/sh\n(${held.loop}; touch ${JSON.stringify(sent)}) &\n`
    writeFileSync(join(home, 'notify'), script)
    chmodSync(join(home, 'notify'), 0o755)
    try {
      await notify(home, event)
      expect(existsSync(sent)).toBe(false)
    } finally {
      held.release()
    }
    // Let go, it goes on: notify left it running. Had notify ended it, this would wait out the test's
    // limit: a second for notify alone (the grace it gives the output included), and the load.
    while (!existsSync(sent)) await Bun.sleep(50)
  },
  1000 + LOAD_MS,
)

test(
  'a command past its time ends with what it started, which holds its output',
  async () => {
    // The subshell is the child of `sh` (`; :` keeps `sh` from becoming it) and holds the output
    // until the test lets it go, once the run has returned. Killing only `sh` would leave it holding
    // the output, and the run waiting out a grace longer than this test.
    const held = hold()
    try {
      const run = await runGroup(['sh', '-c', `(${held.loop}); :`], {
        env: process.env,
        timeoutMs: LIMIT_MS,
        graceMs: 2 * (LIMIT_MS + LOAD_MS),
      })
      expect(run.code).not.toBe(0)
    } finally {
      held.release()
    }
  },
  LIMIT_MS + LOAD_MS,
)

// A nod process of its own running `body` with runGroup, and a reader of the lines it prints.
function nodProcess(body: string) {
  const script = `import { runGroup } from ${JSON.stringify(join(import.meta.dir, 'proc.ts'))}\n${body}`
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

test(
  'a command that ended in time is not killed while its output is waited on',
  async () => {
    // `sh` ends within the limit (it takes milliseconds alone, so the limit is all load) and leaves
    // in the background what holds the output. The test lets that go once the limit has passed: a
    // timer set after runGroup's, for as long, fires after it. Killed by then, it would not mark that
    // it went on. The grace outlasts the limit, so the run waits for it. Not marked when let go, it
    // was held until then.
    const mark = join(tmp.make('nod-group-'), 'sent')
    const held = hold()
    const left = ['sh', '-c', `(${held.loop}; touch ${JSON.stringify(mark)}) &`]
    const run = runGroup(left, { env: process.env, timeoutMs: LOAD_MS, graceMs: 2 * LOAD_MS })
    let markedBefore: boolean | undefined
    setTimeout(() => {
      markedBefore = existsSync(mark)
      held.release()
    }, LOAD_MS)
    expect((await run).code).toBe(0)
    expect(markedBefore).toBe(false)
    expect(existsSync(mark)).toBe(true)
  },
  3 * LOAD_MS,
)
