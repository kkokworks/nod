import { afterAll, expect } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { testTmux } from '../test/tmux'
import { tmuxTest } from '../test/tmux-server'
import { Tmux } from './tmux'

// What nod reads of tmux itself. What nod does with its workers' terminals is tested without tmux
// (worker.test.ts, on test/fake-terminals.ts).
const tmp = tempDirs()
testTmux(tmp)
afterAll(tmp.removeAll)

tmuxTest(
  'the sessions come in one call with the values nod keeps on each, unset ones empty and the last one whole',
  () => {
    const home = tmp.make('nod-tmux-home-')
    const tmux = Tmux.of(home)
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
