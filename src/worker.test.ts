import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger, type TaskStatus } from './ledger'
import { Terminals } from './tmux'
import {
  answer,
  drop,
  onStop,
  parseReport,
  sessionName,
  startTask,
  tell,
  workspaceOf,
} from './worker'

const tmp = tempDirs()
const homes: string[] = []
// tmux sockets go in a temp dir too, so test servers leave nothing in the shared tmux dir.
process.env.TMUX_TMPDIR = tmp.make('nod-tmux-')
afterAll(() => {
  for (const h of homes) Terminals.of(h).killServer()
  tmp.removeAll()
})

// The fake stands in for `claude` through PATH, which nod passes on to worker sessions.
const bin = tmp.make('nod-fake-bin-')
const fake = resolve(import.meta.dir, '../test/fake-agent.ts')
writeFileSync(
  join(bin, 'claude'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
)
chmodSync(join(bin, 'claude'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
// Stop before any test can reach the real claude.
if (Bun.which('claude', { PATH: process.env.PATH }) !== join(bin, 'claude')) {
  throw new Error('fake claude is not first on PATH')
}

let home: string
let ledger: Ledger
let log: string

beforeEach(() => {
  home = tmp.make('nod-worker-')
  homes.push(home)
  mkdirSync(join(home, 'work'))
  writeFileSync(join(home, 'work', '.trusted'), '') // the fake has no trust dialog
  log = join(home, 'agent.log')
  process.env.FAKE_AGENT_LOG = log // a new tmux server per home starts with this environment
  ledger = new Ledger(home)
})

type LogEntry = { event: string; sessionId: string; resumed?: boolean; message?: string }
const entries = (event: string): LogEntry[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line): LogEntry => JSON.parse(line))
        .filter((e) => e.event === event)
    : []

async function until<T>(get: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = get()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error('timed out')
}

const status = (id: number): TaskStatus => ledger.get(id).status
const reaches = (id: number, want: TaskStatus): Promise<true> =>
  until(() => status(id) === want || (status(id) === 'error' && fail(id)))
const fail = (id: number): never => {
  throw new Error(`task ${id} errored: ${ledger.get(id).error}`)
}

async function add(brief: string, check: string | null = null): Promise<number> {
  const id = ledger.add(brief, null, check)
  await startTask(ledger, home, id, null)
  return id
}

test('a failing check goes back into the same turn until it passes', async () => {
  const id = await add('make ok', 'test -f ok.txt')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.checkResult])).toEqual([
    ['start', 'succeeded', 'failed'],
    ['retry', 'succeeded', 'passed'],
  ])
  expect(entries('launch')).toHaveLength(1)
  expect(ledger.stats()).toMatchObject({ attempts: 2, retries: 1, succeededWithoutDecision: 1 })
})

test('a question becomes a decision, and the answer goes into the same live session', async () => {
  const id = await add('ask-first, then write ok.txt', 'test -f ok.txt')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('question')
  expect(decision.question).toContain('May I proceed?')

  await answer(ledger, home, decision.id, 'yes')
  await reaches(id, 'succeeded')
  expect(entries('launch')).toHaveLength(1)
  expect(entries('turn').map((t) => t.message)).toEqual([
    'ask-first, then write ok.txt',
    'Human decision: yes',
  ])
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'answer'])
})

test('a check that keeps failing becomes a decision after the retry budget', async () => {
  const id = await add('never good enough', 'false')
  await reaches(id, 'needs_decision')
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['check_failed'])
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'retry', 'retry'])
})

test('a worker that gives up, or stops without a report, becomes a decision', async () => {
  const gaveUp = await add('give-up')
  const silent = await add('silent')
  await reaches(gaveUp, 'needs_decision')
  await reaches(silent, 'needs_decision')
  expect(ledger.decisions(gaveUp).map((d) => [d.reason, d.question])).toEqual([
    ['failed', 'NOD: failed | cannot do it'],
  ])
  expect(ledger.decisions(silent).map((d) => [d.reason, d.question])).toEqual([
    ['question', 'Stopped without a report.'],
  ])
})

test('a permission prompt becomes a decision, and yes approves it in the session', async () => {
  const id = await add('need-permission')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('permission')
  expect(status(id)).toBe('needs_decision')

  await answer(ledger, home, decision.id, 'yes')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.summary])).toEqual([['start', 'allowed']])
})

test('denying a permission ends the turn, so the worker hears why in a new turn', async () => {
  const id = await add('need-permission')
  const decision = await until(() => ledger.decisions(id)[0])
  await answer(ledger, home, decision.id, 'no, skip the fetch')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual([
    'need-permission',
    'Human decision: permission denied. no, skip the fetch',
  ])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'needs_decision'],
    ['answer', 'succeeded'],
  ])
})

test('dropping a decision cancels the task and closes its session', async () => {
  const id = await add('ask-first')
  const decision = await until(() => ledger.decisions(id)[0])
  await drop(ledger, home, decision.id)
  expect(status(id)).toBe('cancelled')
  expect(Terminals.of(home).alive(sessionName(id))).toBe(false)
})

test('tell continues the same session, and reopens it from the transcript once it has ended', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  tell(ledger, home, id, 'second')
  await reaches(id, 'succeeded')

  Terminals.of(home).kill(sessionName(id))
  tell(ledger, home, id, 'third')
  await reaches(id, 'succeeded')

  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.resumed])).toEqual([
    [session, false],
    [session, true],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'second', 'third'])
  expect(existsSync(workspaceOf(home, id))).toBe(true)
})

test('a stop from a session nod did not start changes nothing', async () => {
  const out = await onStop(ledger, {
    session_id: 'not-ours',
    last_assistant_message: 'NOD: done | x',
    stop_hook_active: false,
  })
  expect(out).toBeNull()
  expect(ledger.list()).toEqual([])
})

test('the report line is read from the end, through Markdown emphasis', () => {
  expect(parseReport('NOD: question | old\nmore\n**NOD: Done** | `shipped`')).toEqual({
    status: 'done',
    text: 'shipped',
  })
  expect(parseReport('no report here')).toBeNull()
})
