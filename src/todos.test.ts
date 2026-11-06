import { afterAll, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { followWork, type PrLookup, type PullRequest } from './done'
import { Ledger, type NewTask, type Task } from './ledger'
import { Tmux } from './tmux'
import {
  type Found,
  OPEN,
  OPEN_ROLES,
  parseRef,
  type TodoEdit,
  type TodoFilter,
  Todos,
} from './todos'
import { tick } from './triggers'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const books = () => {
  const ledger = new Ledger(tmp.make('nod-todos-'))
  return { ledger, todos: new Todos(ledger) }
}
// As the hooks follow tasks. A task in no repo made no commits, so its todo is done once it
// succeeds.
const follow = (todos: Todos): Promise<void> => followWork(todos.ledger, 'nod', null)
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

test('a watch is only for a waiting todo, and passing it makes the todo next again, once', () => {
  const todos = fresh()
  const t = captured(todos, 'Get the repo pushed')
  expect(() => todos.set(t.id, { watch: 'true' }, 'human')).toThrow('a watch is for a waiting todo')
  expect(() => todos.set(t.id, { status: 'waiting', watch: '' }, 'human')).toThrow('empty watch')
  todos.set(t.id, { status: 'waiting', waitingOn: 'Kim', watch: 'test -f pushed' }, 'human')
  expect(ids(todos.watched())).toEqual([t.id])

  // Its watch changed while the command ran: that result is not for this watch.
  expect(todos.endWatch(t.id, 'test -f other', 'passed', 'nod')).toBeNull()
  expect(todos.endWatch(t.id, 'test -f pushed', 'passed', 'nod', true)).toEqual({ back: null })
  const back = todos.get(t.id)
  expect([back.status, back.waitingOn, back.watch]).toEqual(['next', null, null])
  expect(back.notes).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} watch passed: test -f pushed$/)
  expect(todos.changes(t.id).at(-1)?.actor).toBe('nod')
  expect(todos.endWatch(t.id, 'test -f pushed', 'passed', 'nod')).toBeNull()
  expect(todos.watched()).toEqual([])

  // Leaving waiting any other way forgets the watch too.
  const u = captured(todos, 'Hear back on the quote')
  todos.set(u.id, { status: 'waiting', watch: 'false' }, 'human')
  expect(todos.set(u.id, { status: 'done' }, 'human').watch).toBeNull()
})

test('the last check of a watch is the one it ran in this wait', () => {
  const todos = fresh()
  const t = todos.set(captured(todos, 'Hear back').id, { status: 'waiting', watch: 'a' }, 'human')
  expect(todos.lastCheck(t)).toBeNull()
  todos.recordCheck(t.id, 'a', 1, 'not yet')
  todos.recordCheck(t.id, 'a', 2, 'still not')
  expect(todos.lastCheck(t)).toMatchObject({ watch: 'a', code: 2, output: 'still not' })
  // Another watch has not run yet, nor has the same one in a later wait, nor one whose run was
  // for the watch before.
  expect(todos.lastCheck(todos.set(t.id, { watch: 'b' }, 'human'))).toBeNull()
  todos.set(t.id, { status: 'next' }, 'human')
  expect(todos.lastCheck(todos.set(t.id, { status: 'waiting', watch: 'a' }, 'human'))).toBeNull()
  todos.recordCheck(t.id, 'b', 1, '')
  expect(todos.lastCheck(todos.get(t.id))).toBeNull()
})

test('a todo waiting on its task has no watch: handing it over drops one, and none is given', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Ship the fix')
  todos.set(t.id, { status: 'waiting', watch: 'test -f shipped' }, 'human')
  const first = todos.delegate(t.id, task, 'human')
  expect(todos.get(t.id)).toMatchObject({ status: 'waiting', watch: null })
  expect(() => todos.check(t.id, { watch: 'test -f shipped' })).toThrow(
    `t${t.id} waits on its task`,
  )
  // Once the task has ended, the todo is the person's again and can be watched.
  ledger.succeed(first)
  await follow(todos)
  const watched = todos.set(
    t.id,
    { status: 'waiting', watch: 'test -f shipped' },
    'human',
    [],
    'done',
  )
  expect(watched.watch).toBe('test -f shipped')
})

test('--back-to names the task that did the todo; a passing watch hands the todo back to it', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const did = todos.delegate(t.id, task, 'human')
  const unrelated = ledger.add(task)
  for (const id of [did, unrelated]) {
    ledger.setRunning(id, `/work/${id}`)
    ledger.succeed(id)
  }
  await follow(todos)
  const watch = 'test -f answered'
  // The task did it, so it is done: reopening it says so (from).
  const reopen = (edit: TodoEdit) => todos.set(t.id, edit, 'human', [], 'done')
  expect(() => reopen({ status: 'waiting', backTo: did })).toThrow(
    '--back-to is for when a watch passes',
  )
  expect(() => reopen({ status: 'waiting', watch, backTo: unrelated })).toThrow(
    `task n${unrelated} is not the latest task of t${t.id}`,
  )
  reopen({ status: 'waiting', waitingOn: 'Kim', watch, backTo: did })
  // It goes with the watch: clearing the watch, or leaving waiting, forgets it.
  expect(todos.set(t.id, { watch: null }, 'human').backTo).toBeNull()
  todos.set(t.id, { watch, backTo: did }, 'human')
  expect(todos.set(t.id, { status: 'next' }, 'human').backTo).toBeNull()
  // The task is the one named when the watch ends: none for a watch that cannot run, nor once the
  // person took it back while the command ran.
  todos.set(t.id, { status: 'waiting', watch, backTo: did }, 'human')
  expect(todos.endWatch(t.id, watch, 'cannot run (gone)', 'nod')).toEqual({ back: null })
  todos.set(t.id, { status: 'waiting', watch, backTo: did }, 'human')
  todos.set(t.id, { backTo: null }, 'human')
  expect(todos.endWatch(t.id, watch, 'passed', 'nod', true)).toEqual({ back: null })
  expect(todos.get(t.id).status).toBe('next')

  Bun.sleepSync(2) // so it starts waiting after the task ended, on a millisecond clock
  todos.set(t.id, { status: 'waiting', waitingOn: 'Kim', watch, backTo: did }, 'human')
  expect(todos.endWatch(t.id, watch, 'passed', 'nod', true)).toEqual({ back: did })
  const back = todos.get(t.id)
  expect([back.status, back.waitingOn, back.watch, back.backTo]).toEqual([
    'waiting',
    null,
    null,
    null,
  ])
  expect(back.notes).toMatch(/ watch passed, back to task n\d+: test -f answered$/)
  // It waits on the task now: not moved by its earlier end, moved by the next one.
  await follow(todos)
  expect(todos.get(t.id).status).toBe('waiting')
  ledger.setRunning(did, `/work/${did}`)
  ledger.succeed(did)
  await follow(todos)
  expect(todos.get(t.id).status).toBe('done')

  // A task gc collected comes back when told, so it can still be named.
  ledger.collected(did, null)
  expect(reopen({ status: 'waiting', watch, backTo: did }).backTo).toBe(did)
})

test('--back-to takes only the latest task, the one whose end moves the todo', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const ended = async (id: number) => {
    ledger.setRunning(id, `/work/${id}`)
    ledger.succeed(id)
    await follow(todos)
  }
  const earlier = todos.delegate(t.id, task, 'human')
  await ended(earlier)
  todos.set(t.id, { status: 'next' }, 'human', [], 'done')
  const latest = todos.delegate(t.id, task, 'human')
  await ended(latest)
  const watch = 'test -f answered'
  const reopen = (edit: TodoEdit) => todos.set(t.id, edit, 'human', [], 'done')
  // followTasks goes by the latest task, so an earlier one carrying on would never move the todo.
  expect(() => reopen({ status: 'waiting', watch, backTo: earlier })).toThrow(
    `task n${earlier} is not the latest task of t${t.id}`,
  )
  reopen({ status: 'waiting', watch, backTo: latest })
  todos.endWatch(t.id, watch, 'passed', 'nod', true)
  await ended(latest)
  expect(todos.get(t.id).status).toBe('done')
})

test('a watched todo waits on its watch, not on a task told more after it began waiting', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const did = todos.delegate(t.id, task, 'human')
  const ended = async () => {
    ledger.setRunning(did, `/work/${did}`)
    ledger.succeed(did)
    await follow(todos)
  }
  await ended()
  Bun.sleepSync(2) // so it starts waiting after the task ended, on a millisecond clock
  const watch = 'test -f answered'
  todos.set(t.id, { status: 'waiting', watch, backTo: did }, 'human', [], 'done')
  Bun.sleepSync(2)
  await ended() // the person told the task something (nod tell), and it ended again
  expect(todos.get(t.id)).toMatchObject({ status: 'waiting', watch, backTo: did })
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

test('a change goes in only from the status its caller read, and a finished todo reopens only so', () => {
  const todos = fresh()
  const t = captured(todos, 'Ship the fix')
  todos.set(t.id, { status: 'waiting', waitingOn: 'Kim' }, 'human')
  // One session reads it waiting and plans; another closes it before the first one writes.
  todos.finish([t.id], 'done', 'claude:closer')
  const closed = todos.get(t.id)
  const when = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}'
  expect(() => todos.set(t.id, { status: 'next' }, 'claude:stale', [], 'waiting')).toThrow(
    new RegExp(
      `^t${t.id} is done, not waiting \\(moved by claude:closer ${when}\\); nothing changed`,
    ),
  )
  expect(() => todos.set(t.id, { notes: 'x' }, 'claude:stale', [], 'waiting')).toThrow(
    `t${t.id} is done, not waiting`,
  )
  // Without a status read, a finished todo is not reopened either.
  expect(() => todos.set(t.id, { status: 'next' }, 'claude:stale')).toThrow(
    new RegExp(
      `^t${t.id} is done \\(moved by claude:closer ${when}\\); reopening it takes --from done`,
    ),
  )
  expect(todos.get(t.id)).toEqual(closed)
  expect(todos.changes(t.id).map((c) => c.actor)).toEqual(['human', 'human', 'claude:closer'])
  // A finished todo's other fields, and done to dropped, change without one.
  expect(todos.set(t.id, { title: 'Ship the fix today' }, 'human').status).toBe('done')
  expect(todos.set(t.id, { status: 'dropped' }, 'human').status).toBe('dropped')
  // Read as it is, it reopens.
  expect(todos.set(t.id, { status: 'next' }, 'human', [], 'dropped').status).toBe('next')

  // Finishing several from a status is all or nothing.
  const u = captured(todos, 'Reply to Kim')
  expect(() => todos.finish([t.id, u.id], 'done', 'human', 'next')).toThrow(
    `t${u.id} is inbox, not next`,
  )
  expect(todos.get(t.id).status).toBe('next')
  // A todo named twice is one todo, which left `from` the first time.
  expect(todos.finish([t.id, t.id], 'done', 'human', 'next').map((x) => x.status)).toEqual(['done'])
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
  expect(() => todos.set(t.id, { status: 'next' }, 'human', [], 'done')).toThrow(`p${p.id} is done`)
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

test("a project's latest session is its session, and each session knows its project", () => {
  const todos = fresh()
  const p = project(todos, 'Release')
  const q = project(todos, 'Health')
  // Made-up session ids.
  const [A, B, C] = [
    'aaaa1111-0000-4000-8000-00000000000a',
    'bbbb2222-0000-4000-8000-00000000000b',
    'cccc3333-0000-4000-8000-00000000000c',
  ]
  expect(todos.latestSession(p.id)).toBeNull()
  const a = todos.addSession(p.id, A, '/work/one')
  expect(todos.sessionPlace(A)).toEqual({ session: a, project: p, latest: true })
  const b = todos.addSession(p.id, B, '/work/two')
  todos.addSession(q.id, C, '/work/one')
  expect(todos.latestSession(p.id)).toEqual(b)
  expect(todos.sessionPlace(A)).toMatchObject({ latest: false, project: { id: p.id } })
  expect(todos.sessionPlace(B)).toMatchObject({ latest: true, session: { cwd: '/work/two' } })
  expect(todos.sessionPlace(C)?.project.id).toBe(q.id)
  expect(todos.sessionPlace('dddd4444-0000-4000-8000-00000000000d')).toBeNull()
  expect(() => todos.addSession(99, 'eeee', '/work')).toThrow('no project p99')
  expect(() => todos.addSession(q.id, A, '/work')).toThrow()
  expect(todos.session('eeee')).toBeNull()
})

test('a session of no project has no project_sessions row and no place, and the latest of its name stands for it', () => {
  const { ledger, todos } = books()
  const [A, B, C, D] = ['key-a', 'key-b', 'key-c', 'key-d']
  const north = { role: 'orchestrator', name: 'north' } as const
  expect(todos.latestNamed('north')).toBeNull()
  expect(todos.latestOrchestrator()).toBeNull()
  const first = todos.addSession(north, A, '/work/one')
  const gate = todos.addSession({ role: 'relay', name: 'gate' }, B, '/work/two')
  const south = todos.addSession({ role: 'orchestrator', name: 'south' }, C, '/work/three')
  // --new: another row of the same name, which stands for it from now on.
  const again = todos.addSession(north, D, '/work/four')

  expect(again).toMatchObject({ role: 'orchestrator', name: 'north' })
  expect(todos.latestNamed('north')).toEqual(again)
  expect(todos.latestNamed('south')).toEqual(south)
  expect(todos.latestNamed('gate')).toEqual(gate)
  expect(todos.latestOrchestrator()).toEqual(again)
  for (const key of [A, B, C, D]) expect(todos.sessionPlace(key)).toBeNull()
  expect(todos.session(B)).toEqual(gate)
  const rows = (): unknown => ledger.db.query('select count(*) n from project_sessions').get()
  expect(rows()).toEqual({ n: 0 })

  // A socket goes by the session, whatever its role, and is one session's.
  todos.setSocket(A, '/socks/x')
  expect(todos.sessionAt('/socks/x')).toEqual({ ...first, socket: '/socks/x' })
  todos.setSocket(B, '/socks/x')
  expect(todos.sessionAt('/socks/x')).toEqual({ ...gate, socket: '/socks/x' })
  expect(todos.session(A)?.socket).toBeNull()

  // A project session has its row and its project's name, which no role's name reads as.
  const p = project(todos, 'Release')
  const session = todos.addSession(p.id, 'key-p', '/work/p')
  expect(session).toMatchObject({ role: 'project', name: 'Release' })
  expect(rows()).toEqual({ n: 1 })
  expect(todos.latestNamed('Release')).toBeNull()
  // Nothing is left of one that could not go in.
  expect(() => todos.addSession(99, 'key-q', '/work/q')).toThrow('no project p99')
  expect(todos.session('key-q')).toBeNull()
})

test('a task in no project is heard by the latest of the orchestrator that added it, anything else by the orchestrator made last of those taking messages, and none by a relay', () => {
  const { todos } = books()
  const [A, B, C, D] = ['key-a', 'key-b', 'key-c', 'key-d']
  expect(todos.listener(null, null)).toBeNull()
  expect(todos.listener(null, A)).toBeNull()
  const north = { role: 'orchestrator', name: 'north' } as const
  const opened = todos.addSession(north, A, '/work/one')
  todos.addSession({ role: 'relay', name: 'gate' }, B, '/work/two')
  // No orchestrator opened since, the relay after it included.
  expect(todos.listener(null, null)).toEqual(opened)
  const south = todos.addSession({ role: 'orchestrator', name: 'south' }, C, '/work/three')
  expect(todos.listener(null, A)).toEqual(opened)
  expect(todos.listener(null, C)).toEqual(south)
  expect(todos.listener(null, B)).toEqual(south)
  expect(todos.listener(null, null)).toEqual(south)
  expect(todos.listener(null, 'key-unknown')).toEqual(south)
  const newer = todos.addSession(north, D, '/work/four')
  expect(todos.listener(null, A)).toEqual(newer)
  expect(todos.listener(null, C)).toEqual(south)

  // Taking messages goes before being made last, for what no orchestrator added alone.
  todos.setSocket(C, '/socks/c')
  const running = { ...south, socket: '/socks/c' }
  expect(todos.listener(null, null)).toEqual(running)
  expect(todos.listener(null, B)).toEqual(running)
  expect(todos.listener(null, A)).toEqual(newer)
  todos.setSocket(A, '/socks/a')
  expect(todos.listener(null, null)).toEqual(running)
  // Of those taking messages, the one made last.
  todos.setSocket(D, '/socks/d')
  expect(todos.listener(null, null)).toEqual({ ...newer, socket: '/socks/d' })
  // None taking messages: it waits for the one made last.
  for (const key of [A, C, D]) todos.setSocket(key, null)
  expect(todos.listener(null, null)).toEqual(newer)

  const p = project(todos, 'Release')
  expect(todos.listener(p.id, A)).toBeNull()
  const session = todos.addSession(p.id, 'key-p', '/work/p')
  expect(todos.listener(p.id, A)).toEqual(session)
})

test('claiming a role puts in a session nod does not know, takes a project session out of its project, and refuses a name it cannot tell apart', () => {
  const { ledger, todos } = books()
  const [A, B, C, D] = ['key-a', 'key-b', 'key-c', 'key-d']
  const made = todos.claimSession(A, 'orchestrator', 'north', '/work/one')
  expect(made).toMatchObject({
    role: 'orchestrator',
    name: 'north',
    cwd: '/work/one',
    socket: null,
  })
  expect(todos.session(A)).toEqual(made)

  const p = project(todos, 'Release')
  const older = todos.addSession(p.id, C, '/work/three')
  const had = todos.addSession(p.id, B, '/work/two')
  todos.setSocket(B, '/socks/b')
  // A folder only goes in for a new row: this one keeps where nod open opened it.
  const claimed = todos.claimSession(B, 'relay', 'gate', '/somewhere/else')
  expect(claimed).toEqual({ ...had, role: 'relay', name: 'gate', socket: '/socks/b' })
  expect(todos.session(B)).toEqual(claimed)
  expect(todos.sessionPlace(B)).toBeNull()
  expect(todos.latestSession(p.id)).toEqual(older)
  const rows = ledger.db.query('select session_id from project_sessions').all()
  expect(rows).toEqual([{ session_id: older.id }])

  // Another role's name, a project's title or what reads as a project go in nowhere.
  const refused = (name: string, error: string): void => {
    expect(() => todos.claimSession(D, 'relay', name, '/x')).toThrow(error)
    expect(todos.session(D)).toBeNull()
  }
  refused('north', 'the name north is taken by role orchestrator')
  refused('Release', 'Release names a project')
  refused('p7', 'p7 names a project')
  refused(' ', 'empty name')
  // A session may give up its own name for another role, and take a name its role has.
  expect(todos.claimSession(B, 'orchestrator', 'gate', '/x').role).toBe('orchestrator')
  expect(todos.claimSession(D, 'orchestrator', 'gate', '/x').name).toBe('gate')
})

for (const role of OPEN_ROLES) {
  test(`a ${role} session's work is what it added, as any session's, and it is nobody's root place`, () => {
    const { ledger, todos } = books()
    const [A, B] = ['key-a', 'key-b']
    todos.addSession({ role, name: 'north' }, A, '/work/one')
    const task = (rootSession: string): Task =>
      ledger.get(
        todos.delegateNew(
          {
            brief: 'x',
            repo: null,
            branch: null,
            checkCmd: null,
            model: null,
            after: [],
            triggerId: null,
            issue: null,
            rootSession,
          },
          null,
          'human',
        ),
      )
    const [mine, theirs] = [task(A), task(B)]
    expect(todos.isMine(A, mine)).toBe(true)
    expect(todos.isMine(A, theirs)).toBe(false)
    expect(todos.rootPlace(mine)).toBeNull()
  })
}

test("a session nod open opened has all its project's tasks as its own, whoever added them; any other session, those it added", () => {
  const { ledger, todos } = books()
  const p = project(todos, 'Release')
  const q = project(todos, 'Health')
  // Made-up session ids: A and then B opened for p, S never opened by nod open.
  const [A, B, S] = [
    'aaaa1111-0000-4000-8000-00000000000a',
    'bbbb2222-0000-4000-8000-00000000000b',
    'ffff6666-0000-4000-8000-00000000000f',
  ]
  todos.addSession(p.id, A, '/work/one')
  const added = (root: string | null, projectId: number | null): Task => {
    const id = todos.delegateNew({ ...task, rootSession: root }, projectId, 'human')
    return ledger.get(id)
  }
  const ofA = added(A, p.id)
  const ofS = added(S, p.id)
  const shell = added(null, p.id)
  const health = added(S, q.id)
  const loose = added(S, null)
  const retro = ledger.get(ledger.addRetro(ofS, 'look back'))
  todos.addSession(p.id, B, '/work/two')
  const mine = (session: string) =>
    [ofA, ofS, shell, health, loose, retro].filter((t) => todos.isMine(session, t)).map((t) => t.id)

  expect(todos.projectOf(retro)).toBe(p.id)
  expect(todos.projectOf(loose)).toBeNull()
  // Both of p's sessions, the newer included, carry on with every task of p, its retrospective's too.
  expect(mine(B)).toEqual([ofA.id, ofS.id, shell.id, retro.id])
  expect(mine(A)).toEqual(mine(B))
  // S, never opened for a project, keeps what it added, whatever project that went in.
  expect(mine(S)).toEqual([ofS.id, health.id, loose.id, retro.id])
  // Who added each stays as it was.
  expect([ofA, ofS, shell].map((t) => ledger.get(t.id).rootSession)).toEqual([A, S, null])

  // Two tasks' workers may tell each other within one project, or one session's work.
  expect(todos.sameWork(ofA, shell)).toBe(true)
  expect(todos.sameWork(shell, ofS)).toBe(true)
  expect(todos.sameWork(ofS, health)).toBe(true)
  expect(todos.sameWork(ofA, health)).toBe(false)
  expect(todos.sameWork(health, ofA)).toBe(false)
  expect(todos.sameWork(ofA, loose)).toBe(false)
  expect(todos.sameWork(shell, loose)).toBe(false)

  // Its root, as shown: the project's latest session, else the session that added it.
  expect(todos.rootPlace(ofA)?.session.sessionKey).toBe(B)
  expect(todos.rootPlace(shell)?.session.sessionKey).toBe(B)
  expect(todos.rootPlace(loose)).toBeNull()
  // A todo moved out of every project stays with the session that added it.
  todos.set(ofA.todoId ?? 0, { projectId: null }, 'human')
  expect(todos.rootPlace(ofA)).toMatchObject({ session: { sessionKey: A }, latest: false })
  expect(todos.isMine(B, ofA)).toBe(false)
  expect(todos.isMine(A, ofA)).toBe(true)
  // One moved to a project of no session is no session's of p any more.
  todos.set(ofA.todoId ?? 0, { projectId: q.id }, 'human')
  expect(todos.rootPlace(ofA)).toBeNull()
  expect(todos.isMine(A, ofA)).toBe(false)
})

test('a todo can be captured into a project, and put in one as it is delegated', () => {
  const { ledger, todos } = books()
  const p = project(todos, 'Release')
  const into = todos.capture(
    { title: 'Tag it', notes: null, source: 'cli', sourceKey: 'k', url: null, projectId: p.id },
    'human',
  )
  expect(into.todo).toMatchObject({ status: 'inbox', projectId: p.id })
  // Captured again by its key, it stays where it is.
  const again = todos.capture(
    { title: 'Tag it', notes: null, source: 'cli', sourceKey: 'k', url: null, projectId: null },
    'human',
  )
  expect(again).toMatchObject({ created: false, todo: { id: into.todo.id, projectId: p.id } })
  const loose = captured(todos, 'Write the notes')
  const taskId = todos.delegate(loose.id, task, 'human', p.id)
  expect(todos.get(loose.id)).toMatchObject({ status: 'waiting', projectId: p.id })
  expect(ledger.get(taskId).todoId).toBe(loose.id)
  // A closed project takes no open todo, so nothing is handed over.
  const closed = project(todos, 'Old')
  todos.setProject(closed.id, { status: 'done' }, 'human')
  const before = ledger.list().length
  const other = captured(todos, 'Clean up')
  expect(() => todos.delegate(other.id, task, 'human', closed.id)).toThrow(`p${closed.id} is done`)
  expect(ledger.list().length).toBe(before)
  expect(todos.get(other.id)).toMatchObject({ status: 'inbox', projectId: null })
})

test('refs need their prefix: a bare number could be a decision or a task', () => {
  expect(parseRef('t12', 't')).toBe(12)
  expect(() => parseRef('12', 't')).toThrow('not a todo: 12 (write t<n>)')
  expect(() => parseRef('p12', 't')).toThrow('not a todo: p12')
})

test('a decision is d<n> and a trigger c<n>, or their bare number as before; nothing else', () => {
  expect(parseRef('d12', 'd', true)).toBe(12)
  expect(parseRef('12', 'd', true)).toBe(12)
  expect(parseRef('c3', 'c', true)).toBe(3)
  expect(parseRef('3', 'c', true)).toBe(3)
  expect(() => parseRef('#12', 'd', true)).toThrow('not a decision: #12 (write d<n>)')
  expect(() => parseRef('n12', 'd', true)).toThrow('not a decision: n12 (write d<n>)')
  expect(() => parseRef('', 'c', true)).toThrow('not a trigger:  (write c<n>)')
  expect(() => parseRef('d12', 'c', true)).toThrow('not a trigger: d12 (write c<n>)')
})

test('a delegated todo waits on its tasks, and follows the last once none can go on', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Write the release notes')
  const first = todos.delegate(t.id, task, 'human')
  expect(todos.get(t.id)).toMatchObject({ status: 'waiting', waitingOn: null })
  expect(ledger.get(first).todoId).toBe(t.id)
  const second = todos.delegate(t.id, { ...task, after: [first] }, 'human')
  ledger.succeed(first)
  await follow(todos)
  expect(todos.get(t.id).status).toBe('waiting')
  // A task in error can still be resumed.
  ledger.error(second, 'session ended')
  await follow(todos)
  expect(todos.get(t.id).status).toBe('waiting')
  ledger.succeed(second)
  await follow(todos)
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

test('a task handed over without a todo gets one of its own, in the project given', async () => {
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
  await follow(todos)
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
  expect(todos.taskRef(`n${first}`)).toBe(first)
  expect(todos.taskRef(`n${second}`)).toBe(second)
  // Another kind's letter, or nothing, names no task, rather than a task numbered NaN.
  for (const wrong of [`d${first}`, `c${first}`, `#${first}`, `p${first}`, 'n', 'x1', '', ' ']) {
    expect(() => todos.taskRef(wrong)).toThrow(`not a task: ${wrong} (write n<n>, t<n> or r<n>)`)
  }
  const idle = captured(todos, 'Read the spec')
  expect(() => todos.taskRef(`t${idle.id}`)).toThrow(`t${idle.id} has no task`)
  expect(ledger.get(second).todoId).toBe(t.id)
})

test('a task can be named by the retrospective it runs, as ls shows it', () => {
  const { ledger, todos } = books()
  const retro = ledger.addRetro(ledger.get(ledger.add(task)), 'look back')
  const { retroId } = ledger.get(retro)
  if (retroId === null) throw new Error('no retrospective')
  expect(todos.taskRef(`r${retroId}`)).toBe(retro)
  expect(() => todos.taskRef(`r${retroId + 1}`)).toThrow(`r${retroId + 1} not found`)
  expect(() => todos.taskRef('rx')).toThrow('not a retrospective: rx (write r<n>)')
})

test('a number finds every kind it numbers, a prefix only its own kind, nothing else nothing', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Write the report')
  const taskId = todos.delegate(t.id, { ...task, brief: 'Draft the report\nwith the numbers' }, 'h')
  const retroTask = ledger.addRetro(ledger.get(taskId), 'look back')
  const p = project(todos, 'Health')
  const d = ask(ledger, taskId, 'Which chart?\nA bar or a line.')
  expect([t.id, taskId, ledger.get(retroTask).retroId, p.id, d]).toEqual([1, 1, 1, 1, 1])

  const all: Found[] = [
    { kind: 'todo', id: 1, ref: 't1', title: 'Write the report', status: 'waiting' },
    { kind: 'task', id: 1, ref: 'n1', title: 'Draft the report', status: 'needs_decision', taskId },
    {
      kind: 'retro',
      id: 1,
      ref: 'r1',
      title: 'of n1: Draft the report',
      status: 'queued',
      taskId: retroTask,
    },
    { kind: 'project', id: 1, ref: 'p1', title: 'Health', status: 'active' },
    { kind: 'decision', id: 1, ref: 'd1', title: 'Which chart?', status: 'open', taskId },
  ]
  expect(todos.find('1')).toEqual(all)
  expect(todos.find(' 1 ')).toEqual(all)
  for (const [ref, kind] of [
    ['t1', 'todo'],
    ['n1', 'task'],
    // `#<n>`, as nod wrote a task before `n`.
    ['#1', 'task'],
    ['r1', 'retro'],
    ['p1', 'project'],
    ['d1', 'decision'],
  ]) {
    expect(todos.find(ref ?? '')).toEqual(all.filter((f) => f.kind === kind))
  }
  // The ref each is shown by finds it again.
  for (const f of all) expect(todos.find(f.ref)).toContainEqual(f)
  // A task's state is as the caller names it, such as a running task whose terminal is gone.
  const ended = todos.find('1', () => 'session ended')
  expect(ended.map((f) => f.status)).toEqual([
    'waiting',
    'session ended',
    'session ended',
    'active',
    'open',
  ])
  // The retrospective's task numbers nothing else.
  expect(todos.find(String(retroTask)).map((f) => f.ref)).toEqual([`n${retroTask}`])
  const nothing = ['9', 't9', 'n9', '#9', 'r9', 'p9', 'd9', 'x1', 't', 'n', '', 'Write the report']
  for (const none of nothing) {
    expect(todos.find(none)).toEqual([])
  }

  // A retrospective that ended says how; a decision, whether a person answered it.
  ledger.endRetro(1, 'declined')
  ledger.answer(d, 'a bar')
  const d2 = ask(ledger, taskId, 'And the colour?')
  ledger.dismiss(d2, 'went on without it')
  expect(todos.find('r1').map((f) => f.status)).toEqual(['declined'])
  expect(todos.find('1').at(-1)?.status).toBe('answered')
  expect(todos.find('2').at(-1)?.status).toBe('closed')
})

test('a todo whose task was dropped comes back; one waiting on a person or on no task stays', async () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Fix the build')
  ledger.drop(ask(ledger, todos.delegate(t.id, task, 'human'), 'Which branch?'))
  await follow(todos)
  expect(todos.get(t.id).status).toBe('next')
  Bun.sleepSync(2)
  // Set waiting again by the person after its task ended: it waits on nothing nod runs.
  todos.set(t.id, { status: 'waiting' }, 'human')
  const kim = captured(todos, 'Ask about the invoice')
  todos.set(kim.id, { status: 'waiting', waitingOn: 'Kim' }, 'human')
  await follow(todos)
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
  todos.set(t.id, { status: 'next' }, 'human', [], 'done')
  todos.finish([t.id], 'done', 'human')
  expect(ids(todos.list({ ...open, statuses: ['next'] }))).toEqual([next.id])
  todos.finish([next.id], 'dropped', 'human')
  expect(todos.list({ ...open, statuses: ['next'] })).toEqual([])
  const undated = captured(todos, 'Stretch')
  expect(() => todos.set(undated.id, { repeat: 'daily' }, 'human')).toThrow(
    'a repeating todo needs a due, on or start day',
  )
})

test('a monthly series keeps the day it was set on through short months', () => {
  setSystemTime(new Date(2026, 0, 15, 12))
  try {
    const todos = fresh()
    const edit: TodoEdit = { status: 'next', due: '2026-01-31', repeat: 'monthly' }
    let t = todos.set(captured(todos, 'Pay the rent').id, edit, 'human')
    const dues: (string | null)[] = []
    for (let i = 0; i < 3; i += 1) {
      todos.finish([t.id], 'done', 'human')
      t = only(todos.list({ ...open, statuses: ['next'] }))
      dues.push(t.due)
    }
    expect(dues).toEqual(['2026-02-28', '2026-03-31', '2026-04-30'])
  } finally {
    setSystemTime()
  }
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

// ── a delegated todo and its task's commits ──

const PR = 'https://git.example.com/o/r/pulls/'
const ORIGIN = 'https://git.example.com/o/r'
const LATER = '2099-01-01T00:00:00.000Z'

// A ledger, and a repo whose `origin` is ORIGIN with its default branch at the first commit. Each
// todo handed over goes to a task on a branch of its own, which succeeds having made a commit or
// none. `hooks` follows the tasks as the hooks do, reading no git service; `gc` as gc and the
// tick do, reading the pull requests in `prs`.
const repoBooks = () => {
  const home = tmp.make('nod-todos-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string => {
    const cmd = ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', '-C', cwd, ...args]
    const r = Bun.spawnSync(cmd)
    if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
  }
  const commit = (cwd: string, file: string): void => {
    writeFileSync(join(cwd, file), file)
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', file)
  }
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', ORIGIN)
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const handOver = (commits: boolean) => {
    const title = `todo ${todos.ledger.list().length + 1}`
    const todo = captured(todos, title).id
    const branch = `feat/${todo}`
    const id = todos.delegate(todo, { ...task, brief: title, repo, branch }, 'human')
    const cwd = join(home, 'work', branch)
    git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
    if (commits) commit(cwd, `${branch.replace('/', '-')}.txt`)
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    return { todo, task: id, branch }
  }
  const prs: Record<string, PullRequest> = {}
  const lookup: PrLookup = async (url) => prs[url] ?? null
  // The branch's own pull request, open.
  const opened = (branch: string): PullRequest => ({
    state: 'open',
    head: branch,
    headRepo: ORIGIN,
    mergedAt: null,
    approvedAt: null,
  })
  const statuses = (...ts: { todo: number }[]) => ts.map((t) => todos.get(t.todo).status)
  return {
    home,
    ledger,
    todos,
    repo,
    git,
    commit,
    handOver,
    prs,
    opened,
    statuses,
    hooks: () => followWork(ledger, 'nod', null),
    gc: () => followWork(ledger, 'nod', lookup),
  }
}

test('a succeeded task leaves its todo done without commits of its own, waiting on its open pull request, next for commits alone', async () => {
  const b = repoBooks()
  const none = b.handOver(false)
  const open = b.handOver(true)
  b.ledger.link(open.task, [`${PR}1`])
  b.prs[`${PR}1`] = b.opened(open.branch)
  const alone = b.handOver(true)
  // A branch of that name in a fork is someone else's.
  const forked = b.handOver(true)
  b.ledger.link(forked.task, [`${PR}2`])
  b.prs[`${PR}2`] = { ...b.opened(forked.branch), headRepo: 'https://git.example.com/fork/r' }
  // A link that is no pull request, a chat message on the todo, holds nothing back.
  const chatted = b.handOver(true)
  b.todos.link(chatted.todo, 'https://chat.example.com/m/1', null, 'human')

  // The hooks read no git service: a task with a pull request linked waits for gc to read it.
  await b.hooks()
  expect(b.statuses(none, open, alone, forked, chatted)).toEqual([
    'done',
    'waiting',
    'next',
    'waiting',
    'next',
  ])
  expect(b.todos.links(open.todo)).toEqual([])
  await b.gc()
  expect(b.statuses(none, open, alone, forked, chatted)).toEqual([
    'done',
    'waiting',
    'next',
    'next',
    'next',
  ])
  // The pull request it waits on is on the todo.
  expect(b.todos.links(open.todo).map((l) => l.url)).toEqual([`${PR}1`])
  expect(b.todos.changes(open.todo).at(-1)).toMatchObject({
    actor: 'nod',
    change: { link: [null, `${PR}1`] },
  })
}, 30_000)

test('a todo nod left open is done once its commits are in the default branch, and only gc looks again', async () => {
  const b = repoBooks()
  const merging = b.handOver(true)
  b.ledger.link(merging.task, [`${PR}1`])
  b.prs[`${PR}1`] = b.opened(merging.branch)
  const squashed = b.handOver(true)
  // Pushed and opened later, by the root session, say, which links it to the task.
  const later = b.handOver(true)
  const theirs = b.handOver(true)
  await b.gc()
  expect(b.statuses(merging, squashed, later, theirs)).toEqual(['waiting', 'next', 'next', 'next'])
  // Taken back by the person: theirs from now on.
  b.todos.set(theirs.todo, { status: 'waiting' }, 'human')

  b.prs[`${PR}1`] = { ...b.opened(merging.branch), state: 'merged', mergedAt: LATER }
  b.commit(b.repo, `${squashed.branch.replace('/', '-')}.txt`)
  b.git(b.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  b.ledger.link(later.task, [`${PR}2`])
  b.prs[`${PR}2`] = b.opened(later.branch)
  b.ledger.link(theirs.task, [`${PR}3`])
  b.prs[`${PR}3`] = { ...b.opened(theirs.branch), state: 'merged', mergedAt: LATER }
  // The hooks looked once each task ended, and do not again.
  await b.hooks()
  expect(b.statuses(merging, squashed, later, theirs)).toEqual([
    'waiting',
    'next',
    'next',
    'waiting',
  ])
  await b.gc()
  expect(b.statuses(merging, squashed, later, theirs)).toEqual([
    'done',
    'done',
    'waiting',
    'waiting',
  ])
  expect(b.todos.links(later.todo).map((l) => l.url)).toEqual([`${PR}2`])
  b.prs[`${PR}2`] = { ...b.opened(later.branch), state: 'merged', mergedAt: LATER }
  await b.gc()
  expect(b.statuses(later, theirs)).toEqual(['done', 'waiting'])
  // A pull request closed without merging leaves the commits to the person.
  const closed = b.handOver(true)
  b.ledger.link(closed.task, [`${PR}4`])
  b.prs[`${PR}4`] = { ...b.opened(closed.branch), state: 'closed' }
  // Pushed, its pull request merged: done, unless a commit came after the merge, which is not in it.
  const pushed = (mergedAt: string) => {
    const t = b.handOver(true)
    b.git(b.repo, 'update-ref', `refs/remotes/origin/${t.branch}`, t.branch)
    const url = `${PR}${t.task + 10}`
    b.ledger.link(t.task, [url])
    b.prs[url] = { ...b.opened(t.branch), state: 'merged', mergedAt }
    return t
  }
  const pushedMerged = pushed(LATER)
  const pushedSince = pushed('2000-01-01T00:00:00.000Z')
  await b.gc()
  expect(b.statuses(closed, pushedMerged, pushedSince)).toEqual(['next', 'done', 'next'])
}, 30_000)

test('a todo handed to another task while nod read what the last one left waits on the new one', async () => {
  const b = repoBooks()
  const t = b.handOver(true)
  await b.todos.followTasks(
    'nod',
    async () => {
      // The person hands it over again (nod add --todo) while gc reads its pull requests.
      b.todos.delegate(t.todo, task, 'human')
      return { status: 'done' }
    },
    true,
  )
  expect(b.todos.get(t.todo)).toMatchObject({ status: 'waiting', followed: null })
}, 30_000)

test('in a repo nod lands, the todo waits on the landing, done once merged and next once it stops', async () => {
  const b = repoBooks()
  b.ledger.setRepo(b.repo, { land: 'pr' }, 'human')
  const landing = b.handOver(true)
  const stopping = b.handOver(true)
  await b.hooks()
  expect(b.statuses(landing, stopping)).toEqual(['waiting', 'waiting'])
  // nod opened its pull request (land.ts), then merged it.
  b.ledger.setLanding(landing.task, { pr: `${PR}1` })
  b.ledger.link(landing.task, [`${PR}1`])
  b.prs[`${PR}1`] = b.opened(landing.branch)
  b.ledger.setLanding(stopping.task, { stopped: 'dropped' })
  await b.gc()
  expect(b.statuses(landing, stopping)).toEqual(['waiting', 'next'])
  expect(b.todos.links(landing.todo).map((l) => l.url)).toEqual([`${PR}1`])
  b.ledger.setLanding(landing.task, { mergedAt: LATER })
  // Told more after nod merged it: its new commit is not in the merge, and nod lands it no more.
  const more = b.handOver(true)
  b.ledger.setLanding(more.task, { mergedAt: '2000-01-01T00:00:00.000Z' })
  await b.gc()
  expect(b.statuses(landing, more)).toEqual(['done', 'next'])
}, 30_000)

test('a todo whose branch gc deleted is read by the head gc recorded', async () => {
  const b = repoBooks()
  // Pushed, its pull request merged, and gc deleted the branch, as a remote holds it.
  const gone = (mergedAt: string) => {
    const t = b.handOver(true)
    b.git(b.repo, 'update-ref', `refs/remotes/origin/${t.branch}`, t.branch)
    const url = `${PR}${t.task}`
    b.ledger.link(t.task, [url])
    b.prs[url] = { ...b.opened(t.branch), state: 'merged', mergedAt }
    b.ledger.collected(t.task, b.git(b.repo, 'rev-parse', t.branch))
    b.git(b.repo, 'worktree', 'remove', '--force', b.ledger.get(t.task).workspace ?? '')
    b.git(b.repo, 'branch', '-D', t.branch)
    return t
  }
  const merged = gone(LATER)
  // A commit came after the merge: it is not in it.
  const since = gone('2000-01-01T00:00:00.000Z')
  await b.gc()
  expect(b.statuses(merged, since)).toEqual(['done', 'next'])
}, 30_000)

test('the tick and nod gc follow the todos nod left open', async () => {
  // Commits alone, left next, whose changes then went into the default branch.
  const inMain = () => {
    const b = repoBooks()
    const t = b.handOver(true)
    return { b, t }
  }
  const settled = async ({ b, t }: ReturnType<typeof inMain>) => {
    await b.hooks()
    b.commit(b.repo, `${t.branch.replace('/', '-')}.txt`)
    b.git(b.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    return b.statuses(t)
  }
  const ticked = inMain()
  expect(await settled(ticked)).toEqual(['next'])
  const { home } = ticked.b
  // Only on a minute it runs the watches and gc.
  await tick(ticked.b.ledger, home, Tmux.of(home), new Date(), false)
  expect(ticked.b.statuses(ticked.t)).toEqual(['next'])
  await tick(ticked.b.ledger, home, Tmux.of(home), new Date(), true)
  expect(ticked.b.statuses(ticked.t)).toEqual(['done'])

  const swept = inMain()
  expect(await settled(swept)).toEqual(['next'])
  const { CLAUDECODE: _, CLAUDE_CODE_SESSION_ID: __, NOD_TASK: ___, ...shell } = process.env
  const gc = Bun.spawnSync(['bun', resolve(import.meta.dir, 'cli.ts'), 'gc'], {
    env: { ...shell, NOD_HOME: swept.b.home },
  })
  expect(gc.exitCode).toBe(0)
  expect(swept.b.statuses(swept.t)).toEqual(['done'])
}, 30_000)

test('a todo left waiting is looked at again when its task ends again, though its status stayed', async () => {
  const b = repoBooks()
  b.ledger.setRepo(b.repo, { land: 'pr' }, 'human')
  const t = b.handOver(true)
  await b.hooks()
  expect(b.statuses(t)).toEqual(['waiting'])
  const { statusAt, followed } = b.todos.get(t.todo)
  expect(followed).toBe(b.ledger.get(t.task).finishedAt)
  b.ledger.setLanding(t.task, { mergedAt: LATER })
  await b.hooks()
  expect(b.statuses(t)).toEqual(['waiting'])
  // Told more (a landing turn, say), it ended again.
  b.ledger.setRunning(t.task, b.ledger.get(t.task).workspace ?? '')
  b.ledger.succeed(t.task)
  b.ledger.db.run('update tasks set finished_at = ? where id = ?', [LATER, t.task])
  expect(b.todos.get(t.todo).statusAt).toBe(statusAt)
  await b.hooks()
  expect(b.todos.get(t.todo)).toMatchObject({ status: 'done', followed: null })
}, 30_000)

test('a todo left next is looked at again when its task ends again', async () => {
  const b = repoBooks()
  const t = b.handOver(true)
  await b.hooks()
  expect(b.todos.get(t.todo)).toMatchObject({
    status: 'next',
    followed: b.ledger.get(t.task).finishedAt,
  })
  // Its commits went in another way; the hooks do not look again until the task ends again.
  b.commit(b.repo, `${t.branch.replace('/', '-')}.txt`)
  b.git(b.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await b.hooks()
  expect(b.statuses(t)).toEqual(['next'])
  b.ledger.setRunning(t.task, b.ledger.get(t.task).workspace ?? '')
  b.ledger.succeed(t.task)
  b.ledger.db.run('update tasks set finished_at = ? where id = ?', [LATER, t.task])
  await b.hooks()
  expect(b.todos.get(t.todo)).toMatchObject({ status: 'done', followed: null })
}, 30_000)
