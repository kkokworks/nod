import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
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

test('a command that ended in time is not killed while its output is waited on', async () => {
  // The limit passes during the wait, however slow the start: the wait is longer than the limit
  // and ends only when what was left in the background, holding the output, has done its work.
  const mark = join(tmp.make('nod-group-'), 'sent')
  const left = ['sh', '-c', `(sleep 3; touch ${JSON.stringify(mark)}) &`]
  const run = await runGroup(left, { env: process.env, timeoutMs: 1500, graceMs: 10_000 })
  expect(run.code).toBe(0)
  expect(existsSync(mark)).toBe(true)
}, 15_000)
