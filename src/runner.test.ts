import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { runPool } from './pool'
import { DEFAULT_SETTINGS, resultFiles, runTask } from './runner'

const tmp = tempDirs()
afterAll(tmp.removeAll)

// Put a fake `claude` first on PATH.
const bin = tmp.make('nod-fake-bin-')
const fake = resolve(import.meta.dir, '../test/fake-claude.ts')
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec bun ${fake} "$@"\n`)
chmodSync(join(bin, 'claude'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
// Stop before any test can reach the real claude (that happened once when spawn ignored PATH).
if (Bun.which('claude', { PATH: process.env.PATH }) !== join(bin, 'claude')) {
  throw new Error('fake claude is not first on PATH')
}

let home: string
let ledger: Ledger
let log: string

beforeEach(() => {
  home = tmp.make('nod-runner-')
  ledger = new Ledger(home)
  log = join(home, 'calls.jsonl')
  process.env.FAKE_CLAUDE_LOG = log
})

const runAll = (): Promise<void> =>
  runPool(
    () => ledger.ready(),
    (task) =>
      runTask(ledger, task, {
        home,
        permissionMode: 'acceptEdits',
        settings: DEFAULT_SETTINGS,
      }),
  )

const calls = (): { prompt: string; sessionId: string; resumed: boolean }[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : []

test('a failing check is fed back to the same session until it passes', async () => {
  const id = ledger.add('make the file', null, 'test -f ok.txt')
  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  const attempts = ledger.attempts(id)
  expect(attempts.map((a) => [a.kind, a.outcome, a.checkResult])).toEqual([
    ['start', 'succeeded', 'failed'],
    ['retry', 'succeeded', 'passed'],
  ])
  expect(new Set(attempts.map((a) => a.sessionId)).size).toBe(1)
  expect(calls().map((c) => c.resumed)).toEqual([false, true])
  expect(ledger.decisions(id)).toEqual([])
})

test('a question becomes a decision, and the answer resumes the same session', async () => {
  const id = ledger.add('ask-first then work', null, null)
  await runAll()

  expect(ledger.get(id).status).toBe('needs_decision')
  const [decision] = ledger.openDecisions()
  expect(decision).toMatchObject({ taskId: id, reason: 'question', question: 'May I proceed?' })
  if (!decision) throw new Error('no decision')

  ledger.answer(decision.id, 'yes')
  expect(ledger.get(id).status).toBe('queued')
  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  const attempts = ledger.attempts(id)
  expect(attempts.map((a) => [a.kind, a.decisionId])).toEqual([
    ['start', null],
    ['answer', decision.id],
  ])
  const session = attempts[0]?.sessionId
  expect(calls()).toMatchObject([
    { prompt: 'ask-first then work', sessionId: session, resumed: false },
    { prompt: 'Human decision: yes', sessionId: session, resumed: true },
  ])
  expect(ledger.pendingAnswer(id)).toBeNull()
  expect(ledger.openDecisions()).toEqual([])
})

test('a check that keeps failing becomes a decision after the retry budget', async () => {
  const id = ledger.add('try hard', null, 'false')
  await runAll()

  expect(ledger.get(id).status).toBe('needs_decision')
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'retry', 'retry'])
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['check_failed'])
})

test('a worker that gives up becomes a decision', async () => {
  const id = ledger.add('give-up', null, null)
  await runAll()
  expect(ledger.decisions(id)).toMatchObject([{ reason: 'failed', question: 'cannot do it' }])
})

test('an interrupted run resumes its session on the next run', async () => {
  const id = ledger.add('long task', null, null)
  ledger.setRunning(id, join(home, 'work', String(id)))
  ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: 's-1',
    prompt: 'x',
  })

  expect(ledger.requeueRunning()).toBe(1)
  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.error])).toEqual([
    ['start', 'error', 'interrupted'],
    ['resume', 'succeeded', null],
  ])
  expect(calls()).toMatchObject([{ sessionId: 's-1', resumed: true }])
})

test('a crashed worker marks the attempt and the task as errors', async () => {
  const id = ledger.add('crash', null, null)
  await runAll()
  expect(ledger.get(id).status).toBe('error')
  expect(ledger.attempts(id)[0]?.outcome).toBe('error')
})

test('stats match the ledger', async () => {
  ledger.add('make the file', null, 'test -f ok.txt') // 2 attempts, 1 retry
  const asking = ledger.add('ask-first', null, null) // 1 open decision
  ledger.add('plain', null, null) // 1 attempt
  await runAll()

  expect(ledger.stats()).toEqual({
    tasks: { queued: 0, running: 0, succeeded: 2, needs_decision: 1, cancelled: 0, error: 0 },
    succeededWithoutDecision: 2,
    attempts: 4,
    retries: 1,
    decisions: { total: 1, open: 1, medianWaitSecs: null },
    costUsd: 0.04,
  })
  expect(ledger.decisions(asking)).toHaveLength(1)
})

test('dropping a decision cancels the task without running a worker', async () => {
  const id = ledger.add('ask-first', null, null)
  await runAll()
  const [decision] = ledger.openDecisions()
  if (!decision) throw new Error('no decision')

  ledger.drop(decision.id)
  await runAll()

  expect(ledger.get(id).status).toBe('cancelled')
  expect(calls()).toHaveLength(1)
  expect(ledger.stats().tasks.cancelled).toBe(1)
  expect(() => ledger.answer(decision.id, 'late')).toThrow('already answered')
})

// A runner that died left this attempt open; its worker has since finished and written a result.
const orphanWithResult = (brief: string, sessionId: string): { id: number; attemptId: number } => {
  const id = ledger.add(brief, null, null)
  ledger.setRunning(id, join(home, 'work', String(id)))
  const attemptId = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId,
    prompt: brief,
  })
  mkdirSync(join(home, 'results'), { recursive: true })
  writeFileSync(
    resultFiles(home, attemptId).out,
    JSON.stringify({
      is_error: false,
      session_id: sessionId,
      total_cost_usd: 0.02,
      structured_output: { outcome: 'succeeded', summary: 'finished while nobody watched' },
    }),
  )
  return { id, attemptId }
}

test('a result written after the runner died is adopted without running the worker again', async () => {
  const { id, attemptId } = orphanWithResult('orphaned', 's-done')
  expect(ledger.requeueRunning()).toBe(1)
  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.attempts(id)).toMatchObject([
    {
      id: attemptId,
      outcome: 'succeeded',
      summary: 'finished while nobody watched',
      costUsd: 0.02,
    },
  ])
  expect(calls()).toEqual([])
})

test('a worker still running from a dead runner is waited for, not duplicated', async () => {
  const { id, attemptId } = orphanWithResult('still running', 's-live')
  const out = resultFiles(home, attemptId).out
  const result = readFileSync(out, 'utf8')
  writeFileSync(out, '')
  // Stands in for the orphaned worker: its command line carries the session id, like claude's.
  const worker = Bun.spawn(['sh', '-c', `sleep 1 && printf %s '${result}' > ${out}`, 's-live'])
  ledger.setPid(attemptId, worker.pid)
  ledger.requeueRunning()

  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.attempts(id)).toHaveLength(1)
  expect(calls()).toEqual([])
})

test('killing the runner mid-attempt loses nothing: the next run adopts the result', async () => {
  const id = ledger.add('slow task', null, null)
  const cli = resolve(import.meta.dir, 'cli.ts')
  const runner = Bun.spawn(['bun', cli, 'run'], { env: { ...process.env, NOD_HOME: home } })
  while (ledger.openAttempt(id)?.pid == null) await Bun.sleep(50)
  runner.kill('SIGKILL')
  await runner.exited

  expect(ledger.requeueRunning()).toBe(1)
  await runAll()

  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', 'succeeded']])
  expect(calls()).toHaveLength(1)
})
