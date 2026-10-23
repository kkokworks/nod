import { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger, MIGRATIONS } from './ledger'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const freshHome = (): string => tmp.make('nod-ledger-')

test('reopening a ledger keeps its data and does not re-run migrations', () => {
  const home = freshHome()
  const id = new Ledger(home).add({
    brief: 'keep me',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const reopened = new Ledger(home)
  expect(reopened.get(id).brief).toBe('keep me')
  expect(reopened.db.query('pragma user_version').get()).toEqual({ user_version: 16 })
})

test('v16 moves the retrospectives so far into their own table, with what became of each', () => {
  const home = freshHome()
  const old = new Database(join(home, 'nod.db'), { create: true, strict: true })
  for (const sql of MIGRATIONS.slice(0, 15)) old.exec(sql)
  old.exec('pragma user_version = 15')
  const at = '2026-01-01T00:00:00.000Z'
  const task = (id: number, retroOf: number | null, status: string): void => {
    old
      .query(
        `insert into tasks (id, brief, status, created_at, finished_at, retro_of)
         values ($id, 'x', $status, $at, $at, $retroOf)`,
      )
      .run({ id, status, at, retroOf })
  }
  const rule = (taskId: number, summary: string, answer: string): void => {
    const attempt = old
      .query<{ id: number }, { taskId: number; summary: string; at: string }>(
        `insert into attempts (task_id, kind, session_id, prompt, summary, started_at)
         values ($taskId, 'start', 's', 'p', $summary, $at) returning id`,
      )
      .get({ taskId, summary, at })
    if (attempt === null) throw new Error('no attempt')
    const { id } = attempt
    old
      .query(
        `insert into decisions (task_id, attempt_id, reason, question, answer, created_at, answered_at)
         values ($taskId, $id, 'rule', 'q', $answer, $at, $at)`,
      )
      .run({ taskId, id, answer, at })
  }
  for (const id of [1, 2, 3, 4, 5]) task(id, null, 'succeeded')
  task(6, 1, 'succeeded')
  rule(6, 'do A', 'yes')
  task(7, 2, 'cancelled')
  rule(7, 'do B', '(dropped)')
  task(8, 3, 'succeeded')
  task(9, 4, 'cancelled')
  task(10, 5, 'error')
  old.close()

  const ledger = new Ledger(home)
  const moved = [6, 7, 8, 9, 10].map((id) => {
    const { retroId } = ledger.get(id)
    if (retroId === null) throw new Error(`task ${id} lost its retrospective`)
    const r = ledger.retro(retroId)
    return [r.ofTaskId, r.rule, r.outcome]
  })
  expect(moved).toEqual([
    [1, 'do A', 'added'],
    [2, 'do B', 'declined'],
    [3, null, 'none'],
    [4, null, 'dropped'],
    [5, null, null],
  ])
  expect(ledger.get(1).retroId).toBeNull()
  expect(ledger.retroFor(1)?.outcome).toBe('added')
})

test('links are kept once each, and only for a task that exists', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.link(id, ['https://example.com/pr/1'])
  ledger.link(id, ['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(ledger.links(id).sort()).toEqual(['https://example.com/pr/1', 'https://example.com/pr/2'])
  expect(() => ledger.link(id + 1, ['https://example.com/pr/3'])).toThrow('not found')
})

test('a task keeps its issue, and its retrospective and source items carry one', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: 'PROJ-1',
  })
  expect(ledger.get(id).issue).toBe('PROJ-1')
  expect(ledger.get(ledger.addRetro(ledger.get(id), 'look back')).issue).toBe('PROJ-1')

  const triggerId = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'look',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    source: 'true',
    seen: [],
  })
  const fromItem = ledger.addItemTask(ledger.trigger(triggerId), 'PROJ-2', 'PROJ-2', 'look')
  expect(fromItem === null ? null : ledger.get(fromItem).issue).toBe('PROJ-2')
})

test('a decision can be answered once, and answering puts the task back to running', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const attemptId = ledger.startAttempt({
    taskId,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  const decisionId = ledger.ask(taskId, attemptId, 'question', 'ok?')
  expect(ledger.get(taskId).status).toBe('needs_decision')

  ledger.answer(decisionId, 'yes')
  expect(ledger.get(taskId).status).toBe('running')
  expect(() => ledger.answer(decisionId, 'again')).toThrow('already answered')
  expect(ledger.taskOfSession('s')).toBe(taskId)
  expect(ledger.taskOfSession('unknown')).toBeNull()
})

test('median decision wait uses answered decisions only', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add({
    brief: 't',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const attemptId = ledger.startAttempt({
    taskId,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  for (const wait of [10, 30, 20]) {
    const id = ledger.ask(taskId, attemptId, 'question', 'q')
    ledger.db
      .query(
        `update decisions set answer = 'a', created_at = '2026-01-01T00:00:00.000Z',
         answered_at = $at where id = $id`,
      )
      .run({ id, at: `2026-01-01T00:00:${wait}.000Z` })
  }
  ledger.ask(taskId, attemptId, 'question', 'still open')
  expect(ledger.stats().decisions).toEqual({ total: 4, open: 1, medianWaitSecs: 20 })
})

const task = (ledger: Ledger, t: { repo?: string; after?: number[] } = {}): number =>
  ledger.add({
    brief: 't',
    repo: t.repo ?? null,
    branch: t.repo === undefined ? null : 'feat/t',
    checkCmd: null,
    model: null,
    after: t.after ?? [],
    triggerId: null,
    issue: null,
  })

test('a waiting task is claimed once, and only after every task it comes after has succeeded', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger)
  const b = task(ledger)
  const c = task(ledger, { after: [a, b] })
  expect(ledger.claimReady()).toEqual([]) // a and b wait for nothing; `nod add` starts those
  ledger.succeed(a)
  expect(ledger.claimReady()).toEqual([])
  ledger.succeed(b)
  expect(ledger.claimReady()).toEqual([c])
  expect(ledger.claimReady()).toEqual([])
  expect(ledger.get(c).status).toBe('running')
})

test('dropping a task cancels every task waiting on it, all the way down', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger)
  const attemptId = ledger.startAttempt({
    taskId: a,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 't',
  })
  const decisionId = ledger.ask(a, attemptId, 'question', 'ok?')
  const b = task(ledger, { after: [a] })
  const c = task(ledger, { after: [b] })
  const unrelated = task(ledger)
  ledger.drop(decisionId)
  expect([a, b, c].map((id) => ledger.get(id).status)).toEqual([
    'cancelled',
    'cancelled',
    'cancelled',
  ])
  expect(ledger.get(c).error).toBe(`task #${b} it waits for was cancelled`)
  expect(ledger.get(unrelated).status).toBe('queued')
})

test('in one repo a task can come after only one task, and after only tasks that exist', () => {
  const ledger = new Ledger(freshHome())
  const a = task(ledger, { repo: '/r' })
  const b = task(ledger, { repo: '/r' })
  const elsewhere = task(ledger, { repo: '/s' })
  expect(() => task(ledger, { repo: '/r', after: [a, b] })).toThrow('chain them')
  expect(() => task(ledger, { after: [999] })).toThrow('task 999 not found')
  const c = task(ledger, { repo: '/r', after: [a, elsewhere] })
  expect(ledger.after(c).map((t) => t.id)).toEqual([a, elsewhere])
  expect(ledger.list().map((t) => t.id)).toEqual([a, b, elsewhere, c]) // failed adds left nothing
})

test('a trigger run is claimed once, a source item adds a task once, and removal hides it', () => {
  const ledger = new Ledger(freshHome())
  const id = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'b',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    source: 'x',
    seen: ['old'],
  })
  expect(ledger.claimRun(id, null, '2026-10-06T00:01:00.000Z')).toBe(true)
  expect(ledger.claimRun(id, null, '2026-10-06T00:01:00.000Z')).toBe(false) // another tick won

  const trigger = ledger.trigger(id)
  expect(ledger.addItemTask(trigger, 'old', null, 'b')).toBeNull()
  const taskId = ledger.addItemTask(trigger, 'new', null, 'b')
  if (taskId === null) throw new Error('a new item added no task')
  expect(ledger.addItemTask(trigger, 'new', null, 'b')).toBeNull()
  expect(ledger.get(taskId).triggerId).toBe(id)

  ledger.removeTrigger(id)
  expect(ledger.triggers()).toEqual([])
  expect(() => ledger.removeTrigger(id)).toThrow(`trigger ${id} not found`)
})

test("a trigger's task in a repo works on the trigger's branch prefix and its own id", () => {
  const ledger = new Ledger(freshHome())
  const triggerId = ledger.addTrigger({
    cron: '* * * * *',
    brief: 'sweep',
    repo: '/repo',
    branch: 'chore/sweep',
    checkCmd: null,
    model: null,
    source: null,
    seen: [],
  })
  const id = ledger.addTriggerTask(ledger.trigger(triggerId), null, 'sweep')
  expect(ledger.get(id).branch).toBe(`chore/sweep/${id}`)
})
