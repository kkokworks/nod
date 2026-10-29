import { afterAll, expect, setSystemTime, test } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { Ledger, type NewTask, type Task } from './ledger'
import { type Found, OPEN, parseRef, type TodoEdit, type TodoFilter, Todos } from './todos'

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

test('a todo waiting on its task has no watch: handing it over drops one, and none is given', () => {
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
  todos.followTasks('nod')
  expect(todos.set(t.id, { status: 'waiting', watch: 'test -f shipped' }, 'human').watch).toBe(
    'test -f shipped',
  )
})

test('--back-to names the task that did the todo; a passing watch hands the todo back to it', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const did = todos.delegate(t.id, task, 'human')
  const unrelated = ledger.add(task)
  for (const id of [did, unrelated]) {
    ledger.setRunning(id, `/work/${id}`)
    ledger.succeed(id)
  }
  todos.followTasks('nod')
  const watch = 'test -f answered'
  expect(() => todos.set(t.id, { status: 'waiting', backTo: did }, 'human')).toThrow(
    '--back-to is for when a watch passes',
  )
  expect(() => todos.set(t.id, { status: 'waiting', watch, backTo: unrelated }, 'human')).toThrow(
    `task n${unrelated} is not the latest task of t${t.id}`,
  )
  todos.set(t.id, { status: 'waiting', waitingOn: 'Kim', watch, backTo: did }, 'human')
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
  todos.followTasks('nod')
  expect(todos.get(t.id).status).toBe('waiting')
  ledger.setRunning(did, `/work/${did}`)
  ledger.succeed(did)
  todos.followTasks('nod')
  expect(todos.get(t.id).status).toBe('done')

  // A task gc collected comes back when told, so it can still be named.
  ledger.collected(did, null)
  expect(todos.set(t.id, { status: 'waiting', watch, backTo: did }, 'human').backTo).toBe(did)
})

test('--back-to takes only the latest task, the one whose end moves the todo', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const ended = (id: number) => {
    ledger.setRunning(id, `/work/${id}`)
    ledger.succeed(id)
    todos.followTasks('nod')
  }
  const earlier = todos.delegate(t.id, task, 'human')
  ended(earlier)
  todos.set(t.id, { status: 'next' }, 'human')
  const latest = todos.delegate(t.id, task, 'human')
  ended(latest)
  const watch = 'test -f answered'
  // followTasks goes by the latest task, so an earlier one carrying on would never move the todo.
  expect(() => todos.set(t.id, { status: 'waiting', watch, backTo: earlier }, 'human')).toThrow(
    `task n${earlier} is not the latest task of t${t.id}`,
  )
  todos.set(t.id, { status: 'waiting', watch, backTo: latest }, 'human')
  todos.endWatch(t.id, watch, 'passed', 'nod', true)
  ended(latest)
  expect(todos.get(t.id).status).toBe('done')
})

test('a watched todo waits on its watch, not on a task told more after it began waiting', () => {
  const { ledger, todos } = books()
  const t = captured(todos, 'Get the review answered')
  const did = todos.delegate(t.id, task, 'human')
  const ended = () => {
    ledger.setRunning(did, `/work/${did}`)
    ledger.succeed(did)
    todos.followTasks('nod')
  }
  ended()
  Bun.sleepSync(2) // so it starts waiting after the task ended, on a millisecond clock
  const watch = 'test -f answered'
  todos.set(t.id, { status: 'waiting', watch, backTo: did }, 'human')
  Bun.sleepSync(2)
  ended() // the person told the task something (nod tell), and it ended again
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
})

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
  expect(todos.rootPlace(ofA)?.session.sessionId).toBe(B)
  expect(todos.rootPlace(shell)?.session.sessionId).toBe(B)
  expect(todos.rootPlace(loose)).toBeNull()
  // A todo moved out of every project stays with the session that added it.
  todos.set(ofA.todoId ?? 0, { projectId: null }, 'human')
  expect(todos.rootPlace(ofA)).toMatchObject({ session: { sessionId: A }, latest: false })
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
