import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { notify } from './notify'

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
  // Ending at once, and just before its limit, which passes while nod waits on the output.
  for (const [ends, limit] of [
    [0, 10_000],
    [0.7, 1000],
  ] as const) {
    const home = tmp.make('nod-notify-')
    const mark = join(home, 'sent')
    const sent = `(sleep 2; touch ${JSON.stringify(mark)}) &`
    writeFileSync(join(home, 'notify'), `#!/bin/sh\nsleep ${ends}\n${sent}\n`)
    chmodSync(join(home, 'notify'), 0o755)
    const started = Date.now()
    await notify(home, event, limit)
    expect(Date.now() - started).toBeLessThan(ends * 1000 + 1500)
    const deadline = Date.now() + 4000
    while (!existsSync(mark) && Date.now() < deadline) await Bun.sleep(50)
    expect(existsSync(mark)).toBe(true)
  }
}, 15_000)
