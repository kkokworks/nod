import { afterAll, expect, test } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const freshHome = (): string => tmp.make('nod-ledger-')

test('reopening a ledger keeps its data and does not re-run migrations', () => {
  const home = freshHome()
  const id = new Ledger(home).add({
    brief: 'keep me',
    repo: null,
    checkCmd: null,
    model: null,
    after: [],
  })
  const reopened = new Ledger(home)
  expect(reopened.get(id).brief).toBe('keep me')
  expect(reopened.db.query('pragma user_version').get()).toEqual({ user_version: 3 })
})

test('a decision can be answered once, and answering puts the task back to running', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add({ brief: 't', repo: null, checkCmd: null, model: null, after: [] })
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
  const taskId = ledger.add({ brief: 't', repo: null, checkCmd: null, model: null, after: [] })
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
    checkCmd: null,
    model: null,
    after: t.after ?? [],
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
