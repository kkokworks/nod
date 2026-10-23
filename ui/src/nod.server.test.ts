import { afterAll, expect, test } from 'bun:test'
import { tempDirs } from '../../test/tmp'

const tmp = tempDirs()
afterAll(tmp.removeAll)

// The module opens the ledger at $NOD_HOME as it loads, so it is loaded once that points at an
// empty home, which other test files then do not see.
const before = process.env.NOD_HOME
process.env.NOD_HOME = tmp.make('nod-ui-server-')
const { detail, ledger, rules } = await import('./nod.server')
if (before === undefined) delete process.env.NOD_HOME
else process.env.NOD_HOME = before

test('the Settings page lists every rule with its retrospective task, and both pages mark the same edits', () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const retroTask = ledger.addRetro(ledger.get(of), 'look back')
  const retroId = ledger.get(retroTask).retroId ?? 0
  ledger.proposeRule(retroId, 'check first')
  const proposed = ledger.addRule('check first', retroId, 'human')
  ledger.setRule(proposed.id, { text: 'check first, always', state: 'off' }, 'human')
  ledger.addRule('keep it short', null, 'human')

  expect(rules()).toMatchObject([
    { text: 'check first, always', state: 'off', retroId, retroTaskId: retroTask, edited: true },
    { text: 'keep it short', state: 'on', retroId: null, retroTaskId: null, edited: false },
  ])
  expect(detail(retroTask).retro?.rules).toMatchObject([{ id: proposed.id, edited: true }])
})
