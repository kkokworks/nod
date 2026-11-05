import { afterAll, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { testTmux } from '../test/tmux'
import { tmuxTest } from '../test/tmux-server'
import { Tmux } from './tmux'

// What nod reads of tmux itself. What nod does with its workers' terminals is tested without tmux
// (worker.test.ts, on test/fake-terminals.ts).
const tmp = tempDirs()
testTmux(tmp)
const home = tmp.make('nod-tmux-home-')
const tmux = Tmux.of(home)
// Also when a test fails before it ends its server.
afterAll(() => {
  tmux.killServer()
  tmp.removeAll()
})

test('a tmux that hangs fails a start before those it keeps from the ledger give up', () => {
  const bin = tmp.make('nod-hung-tmux-')
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexec sleep 60\n')
  chmodSync(join(bin, 'tmux'), 0o755)
  const { PATH } = process.env
  process.env.PATH = `${bin}:${PATH}`
  const began = Date.now()
  try {
    expect(() => tmux.start('hung', home, ['/bin/sleep', '30'], {})).toThrow(
      'tmux new-session failed: no answer in 4000ms',
    )
  } finally {
    process.env.PATH = PATH
  }
  expect(Date.now() - began).toBeLessThan(5000)
}, 15_000)

tmuxTest(
  'the sessions come in one call with the values nod keeps on each, unset ones empty and the last one whole',
  () => {
    tmux.start('kept', home, ['/bin/sleep', '30'], {})
    tmux.start('bare', home, ['/bin/sleep', '30'], {})
    tmux.setOption('kept', 'nod_restarting', '1')
    tmux.setOption('kept', 'nod_restart', 'the account is now /a b')

    expect(tmux.sessionOptions('nod_restarting', 'nod_restart')).toEqual(
      new Map([
        ['bare', ['', '']],
        ['kept', ['1', 'the account is now /a b']],
      ]),
    )
    expect(tmux.sessionOptions('nod_restart').get('kept')).toEqual(['the account is now /a b'])
    tmux.killServer()
    expect(tmux.sessionOptions('nod_restart')).toEqual(new Map())
  },
)
