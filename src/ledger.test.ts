import { afterAll, expect, test } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const freshHome = (): string => tmp.make('nod-ledger-')

test('reopening a ledger keeps its data and does not re-run migrations', () => {
  const home = freshHome()
  const id = new Ledger(home).add('keep me', null, null)
  const reopened = new Ledger(home)
  expect(reopened.get(id).brief).toBe('keep me')
  expect(reopened.db.query('pragma user_version').get()).toEqual({ user_version: 2 })
})

test('a decision can be answered once, and answering puts the task back to running', () => {
  const ledger = new Ledger(freshHome())
  const taskId = ledger.add('t', null, null)
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
  const taskId = ledger.add('t', null, null)
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
