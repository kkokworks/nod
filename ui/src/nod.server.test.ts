import { afterAll, expect, test } from 'bun:test'
import { Todos } from '../../src/todos'
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

test('the task page names as its root the project session whose task it is, with the command that reopens it and who added it', () => {
  const todos = new Todos(ledger)
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  // Made-up session ids: A and then B opened for the project, S never by nod open.
  const [A, B, S] = [
    'aaaa1111-0000-4000-8000-00000000000a',
    'bbbb2222-0000-4000-8000-00000000000b',
    'ffff6666-0000-4000-8000-00000000000f',
  ]
  todos.addSession(p.id, A, '/work/release')
  const brief = {
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  }
  // A task in no project, or in the project.
  const loose = (rootSession: string | null) => ledger.add({ ...brief, rootSession })
  const inProject = (rootSession: string | null) =>
    todos.delegateNew({ ...brief, rootSession }, p.id, 'human')
  const opened = loose(A)
  const fromA = inProject(A)
  const fromS = inProject(S)

  const latest = { project: p, command: `nod open p${p.id}` }
  expect(detail(opened).root).toEqual({ ...latest, addedFrom: null })
  expect(detail(fromS).root).toEqual({ ...latest, addedFrom: S })
  expect(detail(inProject(null)).root).toEqual({ ...latest, addedFrom: null })
  expect(detail(loose(S)).root).toBeNull()
  expect(detail(loose(null)).root).toBeNull()
  // A new session of the project carries on with its tasks; one in no project stays with A.
  todos.addSession(p.id, B, '/work/release 2')
  expect(detail(fromA).root).toEqual({ ...latest, addedFrom: A })
  expect(detail(fromS).root).toEqual({ ...latest, addedFrom: S })
  expect(detail(opened).root).toEqual({
    project: p,
    command: `cd '/work/release' && claude --resume ${A}`,
    addedFrom: null,
  })
})
