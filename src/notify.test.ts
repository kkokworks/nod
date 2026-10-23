import { afterAll, expect, spyOn, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
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
    await notify(withNotify('#!/bin/sh\nsleep 5\n', 0o755), event, 200)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(errors).toHaveBeenCalledTimes(1)
  } finally {
    errors.mockRestore()
  }
})
