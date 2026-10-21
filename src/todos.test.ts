import { afterAll, expect, test } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { Ledger, type NewTask } from './ledger'
import { OPEN, parseRef, type TodoEdit, type TodoFilter, Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const books = () => {
  const ledger = new Ledger(tmp.make('nod-todos-'))
  return { ledger, todos: new Todos(ledger) }
}
const fresh = (): Todos => books().todos
const captured = (todos: Todos, title: string, source = 'cli', sourceKey: string | null = null) =>
  todos.capture({ title, notes: null, source, sourceKey, url: null }, 'human').todo
const project = (todos: Todos, title: string) => todos.addProject({ title, outcome: null }, 'human')
const open: TodoFilter = {
  statuses: OPEN,
  context: null,
  projectId: null,
  hideSomedayProjects: true,
  day: null,
}
const ids = (ts: { id: number }[]) => ts.map((t) => t.id)
const task: NewTask = {
  brief: 'do it',
  repo: null,
  branch: null,
  checkCmd: null,
  model: null,
  after: [],
  triggerId: null,
  issue: null,
}
// Opens a question on the task, as a worker that stops to ask does.
const ask = (ledger: Ledger, taskId: number, question: string): number => {
  const attempt = ledger.startAttempt({
    taskId,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 'p',
  })
  return ledger.ask(taskId, attempt, 'question', question)
}

test('a capture lands in the inbox once per source key, and records who captured it', () => {
  const todos = fresh()
  const first = todos.capture(
    { title: 'Reply to the review', notes: null, source: 'chat', sourceKey: 'k1', url: null },
    'claude:abc',
  )
  expect(first.created).toBe(true)
  expect(first.todo.status).toBe('inbox')
  const again = todos.capture(
    { title: 'Reply (renamed)', notes: null, source: 'chat', sourceKey: 'k1', url: null },
    'claude:abc',
  )
  expect(again).toEqual({ todo: first.todo, created: false })
  // The same key from another channel is another item.
  expect(captured(todos, 'Other', 'mail', 'k1').id).not.toBe(first.todo.id)
  expect(todos.changes(first.todo.id)).toEqual([
    {
      actor: 'claude:abc',
      change: {
        title: [null, 'Reply to the review'],
        status: [null, 'inbox'],
        source: [null, 'chat'],
        sourceKey: [null, 'k1'],
      },
      at: first.todo.createdAt,
    },
  ])
})

test('a capture needs a title and a source, and a key or link that is not empty', () => {
  const todos = fresh()
  const base = { title: 'x', notes: null, source: 'cli', sourceKey: null, url: null }
  expect(() => todos.capture({ ...base, title: ' ' }, 'human')).toThrow('empty title')
  expect(() => todos.capture({ ...base, source: '' }, 'human')).toThrow('empty source')
  expect(() => todos.capture({ ...base, sourceKey: '' }, 'human')).toThrow('empty key')
  expect(() => todos.capture({ ...base, url: '' }, 'human')).toThrow('empty link')
  expect(todos.list({ ...open, statuses: ['inbox'] })).toEqual([])
})

test('clarifying records each field before and after; status time moves only with the status', () => {
  const todos = fresh()
  const t = captured(todos, 'Call the dentist')
  const p = project(todos, 'Health')
  // A context is written with @, given with or without it.
  const next = todos.set(t.id, { status: 'next', projectId: p.id, context: 'phone' }, 'human')
  expect(next.context).toBe('@phone')
  const statusChanged = todos.changes(t.id)[1]?.at
  expect(next.statusAt).toBe(String(statusChanged))
  Bun.sleepSync(2)
  const renamed = todos.set(t.id, { title: 'Call the dentist to book', context: null }, 'worker:3')
  expect(renamed.statusAt).toBe(next.statusAt)
  expect(todos.changes(t.id)[2]?.at).not.toBe(statusChanged)
  // Setting what is already there is no change.
  todos.set(t.id, { status: 'next', notes: undefined }, 'human')
  expect(todos.changes(t.id).map((c) => [c.actor, c.change])).toEqual([
    [
      'human',
      { title: [null, 'Call the dentist'], status: [null, 'inbox'], source: [null, 'cli'] },
    ],
    ['human', { status: ['inbox', 'next'], projectId: [null, p.id], context: [null, '@phone'] }],
    [
      'worker:3',
      { title: ['Call the dentist', 'Call the dentist to book'], context: ['@phone', null] },
    ],
  ])
})

test('leaving waiting forgets whom it waited on, unless the edit names someone', () => {
  const todos = fresh()
  const t = captured(todos, 'Ask about the invoice')
  todos.set(t.id, { status: 'waiting', waitingOn: 'Kim' }, 'human')
  expect(todos.set(t.id, { status: 'waiting', waitingOn: 'Lee' }, 'human').waitingOn).toBe('Lee')
  expect(todos.set(t.id, { status: 'next' }, 'human').waitingOn).toBeNull()
  expect(todos.changes(t.id).at(-1)?.change).toEqual({
    status: ['waiting', 'next'],
    waitingOn: ['Lee', null],
  })
})

test('an edit that fails changes nothing, links included', () => {
  const todos = fresh()
  const t = captured(todos, 'x')
  expect(() => todos.set(t.id, { projectId: 99 }, 'human', ['https://example.com/1'])).toThrow(
    'no project p99',
  )
  expect(() => todos.set(t.id, { title: ' ' }, 'human')).toThrow('empty title')
  expect(() => todos.set(t.id, {}, 'human', [''])).toThrow('empty link')
  expect(todos.get(t.id)).toEqual(t)
  expect(todos.links(t.id)).toEqual([])
  expect(todos.changes(t.id)).toHaveLength(1)
})

test('finishing several todos is all or nothing', () => {
  const todos = fresh()
  const a = captured(todos, 'a')
  expect(() => todos.finish([a.id, 99], 'done', 'human')).toThrow('no todo t99')
  expect(todos.get(a.id).status).toBe('inbox')
  expect(todos.finish([a.id], 'done', 'human').map((t) => t.status)).toEqual(['done'])
})

test('links are kept once each and recorded as changes', () => {
  const todos = fresh()
  const t = todos.capture(
    { title: 't', notes: null, source: 'cli', sourceKey: null, url: 'https://example.com/a' },
    'human',
  ).todo
  todos.set(t.id, {}, 'human', ['https://example.com/a', 'https://example.com/b'])
  expect(todos.links(t.id)).toEqual([
    { url: 'https://example.com/a', title: null },
    { url: 'https://example.com/b', title: null },
  ])
  expect(todos.changes(t.id).filter((c) => 'link' in c.change)).toHaveLength(2)
})

test('lists go in GTD order and filter by status, context and project', () => {
  const todos = fresh()
  const p = project(todos, 'P')
  const waiting = captured(todos, 'w')
  todos.set(waiting.id, { status: 'waiting', waitingOn: 'Kim', projectId: p.id }, 'human')
  const inbox = captured(todos, 'i')
  const phone = captured(todos, 'n')
  todos.set(phone.id, { status: 'next', context: '@phone', projectId: p.id }, 'human')
  const anywhere = captured(todos, 'a')
  todos.set(anywhere.id, { status: 'next' }, 'human')
  const desk = captured(todos, 'd')
  todos.set(desk.id, { status: 'next', context: '@desk' }, 'human')

  expect(ids(todos.list(open))).toEqual([inbox.id, phone.id, anywhere.id, desk.id, waiting.id])
  // A todo with no context can be done anywhere, so it is listed in every context.
  expect(ids(todos.list({ ...open, statuses: ['next'], context: 'phone' }))).toEqual([
    phone.id,
    anywhere.id,
  ])
  expect(ids(todos.list({ ...open, projectId: p.id }))).toEqual([phone.id, waiting.id])
})

test('putting a project off hides its todos until it is named or everything is listed', () => {
  const todos = fresh()
  const p = project(todos, 'Later')
  const t = captured(todos, 'Plan the trip')
  todos.set(t.id, { status: 'next', projectId: p.id }, 'human')
  todos.setProject(p.id, { status: 'someday' }, 'human')
  expect(todos.list(open)).toEqual([])
  expect(ids(todos.list({ ...open, hideSomedayProjects: false }))).toEqual([t.id])
  expect(ids(todos.list({ ...open, projectId: p.id, hideSomedayProjects: false }))).toEqual([t.id])
})

test('a closed project holds no open todo, whichever side changes', () => {
  const todos = fresh()
  const p = project(todos, 'Move office')
  const t = captured(todos, 'Book movers')
  todos.set(t.id, { status: 'next', projectId: p.id }, 'human')
  expect(todos.projects(['active']).map((x) => [x.id, x.next, x.waiting])).toEqual([[p.id, 1, 0]])
  expect(() => todos.setProject(p.id, { status: 'done' }, 'human')).toThrow(
    `p${p.id} still has open todos t${t.id}`,
  )
  todos.finish([t.id], 'done', 'human')
  expect(todos.setProject(p.id, { status: 'done' }, 'human').status).toBe('done')
  expect(todos.projects(['active'])).toEqual([])
  // Reopening a todo of the closed project, or moving an open one into it, is refused.
  expect(() => todos.set(t.id, { status: 'next' }, 'human')).toThrow(`p${p.id} is done`)
  const other = captured(todos, 'Other')
  expect(() => todos.set(other.id, { projectId: p.id }, 'human')).toThrow(`p${p.id} is done`)
  // A finished todo may still be filed under it.
  todos.finish([other.id], 'done', 'human')
  expect(todos.set(other.id, { projectId: p.id }, 'human').projectId).toBe(p.id)
})

test('project changes record who made them, and titles never look like refs', () => {
  const todos = fresh()
  const p = todos.addProject({ title: 'Health', outcome: 'Teeth fixed' }, 'claude:abc')
  todos.setProject(p.id, { outcome: null, status: 'someday' }, 'human')
  expect(todos.projectChanges(p.id).map((c) => [c.actor, c.change])).toEqual([
    [
      'claude:abc',
      { title: [null, 'Health'], outcome: [null, 'Teeth fixed'], status: [null, 'active'] },
    ],
    ['human', { outcome: ['Teeth fixed', null], status: ['active', 'someday'] }],
  ])
  expect(() => project(todos, 'p7')).toThrow('a project title cannot look like p<n>: p7')
  expect(() => project(todos, '2026')).toThrow('a project title cannot look like p<n>: 2026')
})

test('a project is found by p<n> or by its exact title, and only one', () => {
  const todos = fresh()
  const a = project(todos, 'Same')
  expect(todos.findProject(`p${a.id}`)).toEqual(a)
  expect(todos.findProject('Same')).toEqual(a)
  expect(() => todos.findProject(String(a.id))).toThrow(`not a project: ${a.id} (write p<n>)`)
  const b = project(todos, 'Same')
  expect(() => todos.findProject('Same')).toThrow(`p${a.id}, p${b.id} are all titled "Same"`)
  expect(() => todos.findProject('Nope')).toThrow('no project titled "Nope"')
})

test('refs need their prefix: a bare number could be a decision or a task', () => {
  expect(parseRef('t12', 't')).toBe(12)
  expect(() => parseRef('12', 't')).toThrow('not a todo: 12 (write t<n>)')
  expect(() => parseRef('p12', 't')).toThrow('not a todo: p12')
})

test('a delegated todo waits on its tasks, and follows the last once none can go on', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Write the release notes')
  const first = todos.delegate(t.id, task, 'human')
  expect(todos.get(t.id)).toMatchObject({ status: 'waiting', waitingOn: null })
  expect(ledger.get(first).todoId).toBe(t.id)
  const second = todos.delegate(t.id, { ...task, after: [first] }, 'human')
  ledger.succeed(first)
  todos.followTasks('nod')
  expect(todos.get(t.id).status).toBe('waiting')
  // A task in error can still be resumed.
  ledger.error(second, 'session ended')
  todos.followTasks('nod')
  expect(todos.get(t.id).status).toBe('waiting')
  ledger.succeed(second)
  todos.followTasks('nod')
  expect(todos.changes(t.id).map((c) => [c.actor, c.change])).toEqual([
    [
      'human',
      { title: [null, 'Write the release notes'], status: [null, 'inbox'], source: [null, 'cli'] },
    ],
    ['human', { status: ['inbox', 'waiting'] }],
    ['nod', { status: ['waiting', 'done'] }],
  ])
  expect(todos.tasks(t.id).map((x) => x.task.id)).toEqual([first, second])
  expect(() => todos.delegate(t.id, task, 'human')).toThrow(`t${t.id} is done; reopen it`)
})

test('a task handed over without a todo gets one of its own, in the project given', () => {
  const { ledger, todos } = books()
  const p = project(todos, 'Launch')
  const id = todos.delegateNew(
    { ...task, brief: 'Ship the site\n\nDetails follow.' },
    p.id,
    'human',
  )
  const todoId = ledger.get(id).todoId
  if (todoId === null) throw new Error('no todo')
  expect(todos.get(todoId)).toMatchObject({
    title: 'Ship the site',
    status: 'waiting',
    waitingOn: null,
    projectId: p.id,
    source: 'nod',
  })
  ledger.succeed(id)
  todos.followTasks('nod')
  expect(todos.get(todoId).status).toBe('done')
  // A closed project takes no new open todo, so nothing is added.
  todos.setProject(p.id, { status: 'done' }, 'human')
  const before = ledger.list().length
  expect(() => todos.delegateNew(task, p.id, 'human')).toThrow(`p${p.id} is done`)
  expect(ledger.list().length).toBe(before)
})

test('a task can be named by its todo: the latest task doing it', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Fix the build')
  const first = todos.delegate(t.id, task, 'human')
  expect(todos.taskRef(`t${t.id}`)).toBe(first)
  const second = todos.delegate(t.id, { ...task, after: [first] }, 'human')
  expect(todos.taskRef(`t${t.id}`)).toBe(second)
  expect(todos.taskRef(String(first))).toBe(first)
  const idle = captured(todos, 'Read the spec')
  expect(() => todos.taskRef(`t${idle.id}`)).toThrow(`t${idle.id} has no task`)
  expect(ledger.get(second).todoId).toBe(t.id)
})

test('a todo whose task was dropped comes back; one waiting on a person or on no task stays', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Fix the build')
  ledger.drop(ask(ledger, todos.delegate(t.id, task, 'human'), 'Which branch?'))
  todos.followTasks('nod')
  expect(todos.get(t.id).status).toBe('next')
  Bun.sleepSync(2)
  // Set waiting again by the person after its task ended: it waits on nothing nod runs.
  todos.set(t.id, { status: 'waiting' }, 'human')
  const kim = captured(todos, 'Ask about the invoice')
  todos.set(kim.id, { status: 'waiting', waitingOn: 'Kim' }, 'human')
  todos.followTasks('nod')
  expect([todos.get(t.id).status, todos.get(kim.id).status]).toEqual(['waiting', 'waiting'])
})

test("an open decision is a next action, of the project its task's todo is in", () => {
  const { ledger, todos } = books()
  const p = project(todos, 'Release')
  const t = captured(todos, 'Write the release notes')
  todos.set(t.id, { projectId: p.id }, 'human')
  const id = todos.delegate(t.id, task, 'human')
  const counts = () => todos.projects(['active']).map((x) => [x.next, x.waiting])
  expect(counts()).toEqual([[0, 1]])
  const d = ask(ledger, id, 'Which version?')
  expect(counts()).toEqual([[1, 1]])
  const plain = ledger.add(task)
  const other = ask(ledger, plain, 'Go on?')
  expect(todos.decisions().map((x) => [x.decision.id, x.todo?.id ?? null])).toEqual([
    [d, t.id],
    [other, null],
  ])
})

const only = <T>(xs: T[]): T => {
  const [x, ...rest] = xs
  if (x === undefined || rest.length > 0) throw new Error(`expected one, got ${xs.length}`)
  return x
}

test('a todo that starts later stays out of the lists until its day', () => {
  const todos = fresh()
  const later = captured(todos, 'File the return')
  todos.set(later.id, { status: 'next', start: '2099-01-01' }, 'human')
  const now = captured(todos, 'Book the room')
  todos.set(now.id, { status: 'next', start: 'today' }, 'human')
  const today = new Date().toLocaleDateString('sv-SE')
  expect(todos.get(now.id).start).toBe(today)
  expect(ids(todos.list({ ...open, day: today }))).toEqual([now.id])
  expect(ids(todos.list(open))).toEqual([later.id, now.id])
})

test('done makes the next one of a repeating todo, once; dropped ends it', () => {
  const todos = fresh()
  const p = project(todos, 'Habits')
  const t = captured(todos, 'Weekly review')
  const edit: TodoEdit = { status: 'next', projectId: p.id, context: 'desk', focus: 'today' }
  todos.set(t.id, { ...edit, due: '2026-10-16 17:00', repeat: 'weekly' }, 'claude:abc')
  todos.finish([t.id], 'done', 'claude:abc')
  const next = only(todos.list({ ...open, statuses: ['next'] }))
  expect(next).toMatchObject({
    title: 'Weekly review',
    projectId: p.id,
    context: '@desk',
    repeat: 'weekly',
    focus: null,
    source: 'cli',
    sourceKey: `t${t.id}`,
  })
  // A Friday at 17:00, after today.
  const due = String(next.due)
  expect([new Date(`${due.slice(0, 10)}T12:00`).getDay(), due.slice(10)]).toEqual([5, ' 17:00'])
  expect(due > new Date().toLocaleDateString('sv-SE')).toBe(true)
  expect(todos.changes(next.id).map((c) => c.actor)).toEqual(['claude:abc'])
  // Reopened and done again, it makes no second one.
  todos.set(t.id, { status: 'next' }, 'human')
  todos.finish([t.id], 'done', 'human')
  expect(ids(todos.list({ ...open, statuses: ['next'] }))).toEqual([next.id])
  todos.finish([next.id], 'dropped', 'human')
  expect(todos.list({ ...open, statuses: ['next'] })).toEqual([])
  const undated = captured(todos, 'Stretch')
  expect(() => todos.set(undated.id, { repeat: 'daily' }, 'human')).toThrow(
    'a repeating todo needs a due, on or start day',
  )
})

test('a day holds what is overdue, scheduled, due and focused, each open todo once', () => {
  const todos = fresh()
  const at = (title: string, edit: TodoEdit) =>
    todos.set(captured(todos, title).id, { status: 'next', ...edit }, 'human').id
  const late = at('Late', { due: '2026-10-19' })
  const missed = at('Missed', { scheduled: '2026-10-18 10:00' })
  const call = at('Call', { scheduled: '2026-10-20 15:00', due: '2026-10-20' })
  const early = at('Early', { scheduled: '2026-10-20 09:00' })
  const due = at('Due', { due: '2026-10-20 17:00', focus: '2026-10-20' })
  const picked = at('Picked', { focus: '2026-10-20' })
  at('Picked yesterday', { focus: '2026-10-19' })
  at('Later', { due: '2026-10-21' })
  todos.finish([at('Done', { due: '2026-10-19' })], 'done', 'human')
  const day = Object.entries(todos.day('2026-10-20')).map(([group, ts]) => [group, ids(ts)])
  expect(Object.fromEntries(day)).toEqual({
    overdue: [missed, late],
    scheduled: [early, call],
    due: [due],
    focus: [picked],
  })
})

test('the weekly review is the last done todo of the review series, and a waited-on person goes stale', () => {
  const { ledger, todos } = books()
  const today = new Date().toLocaleDateString('sv-SE')
  expect(todos.trust(today).sinceReview).toBeNull()
  const review = todos.capture(
    { title: 'Weekly review', notes: null, source: 'review', sourceKey: 'weekly', url: null },
    'human',
  ).todo
  todos.set(review.id, { status: 'next', due: 'today 17:00', repeat: 'weekly' }, 'human')
  todos.finish([review.id], 'done', 'human')
  // The next one keeps the channel, so it is still the review.
  expect(todos.list({ ...open, statuses: ['next'] }).map((t) => t.source)).toEqual(['review'])
  expect(todos.trust(today).sinceReview).toBe(0)
  const kim = captured(todos, 'Ask Kim for the report')
  todos.set(kim.id, { status: 'waiting', waitingOn: 'Kim' }, 'human')
  expect(todos.trust(today).stale).toEqual([])
  ledger.db.run("update todo_changes set at = '2026-01-01T00:00:00.000Z' where todo_id = ?", [
    kim.id,
  ])
  expect(todos.trust(today).stale.map((x) => x.todo.id)).toEqual([kim.id])
})
