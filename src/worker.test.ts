import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger, type TaskStatus } from './ledger'
import { Terminals } from './tmux'
import { addTrigger, tick } from './triggers'
import {
  answer,
  drop,
  onStop,
  parseReport,
  sessionName,
  startReady,
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
  writeFileSync(join(home, 'work', '.trusted'), '') // nod's own work folder counts as trusted
  log = join(home, 'agent.log')
  process.env.FAKE_AGENT_LOG = log // a new tmux server per home starts with this environment
  delete process.env.FAKE_AGENT_UNTRUSTED
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
  const id = ledger.add({
    brief,
    repo: null,
    checkCmd: check,
    model: null,
    after: [],
    triggerId: null,
  })
  await startTask(ledger, home, id)
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
  const out = await onStop(ledger, home, {
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

test('a task that comes after another starts once that one succeeds, and hears its report', async () => {
  const first = await add('ask-first')
  const decision = await until(() => ledger.decisions(first)[0])
  const next = ledger.add({
    brief: 'then this',
    repo: null,
    checkCmd: null,
    model: null,
    after: [first],
    triggerId: null,
  })
  expect(await startReady(ledger, home)).toEqual([])
  expect(status(next)).toBe('queued')

  await answer(ledger, home, decision.id, 'yes')
  await reaches(next, 'succeeded')
  const message = entries('turn').find((t) => t.message?.startsWith('then this'))?.message
  expect(message).toContain(`- #${first} ask-first: did it`)
})

// A fixed identity and no hooks, so commits do not depend on this machine's git config.
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=nod test',
      '-c',
      'user.email=nod-test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd },
  )
  if (result.exitCode !== 0) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`)
}

test('in a repo, done needs the work committed, and the next task starts from that branch', async () => {
  const repo = newRepo()
  const first = ledger.add({
    brief: 'make ok',
    repo,
    checkCmd: 'test -f ok.txt',
    model: null,
    after: [],
    triggerId: null,
  })
  await startTask(ledger, home, first)
  await reaches(first, 'succeeded')
  expect(ledger.attempts(first).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'], // no ok.txt yet
    ['retry', 'failed'], // ok.txt written but not committed
    ['retry', 'passed'],
  ])

  const next = ledger.add({
    brief: 'build on it',
    repo,
    checkCmd: null,
    model: null,
    after: [first],
    triggerId: null,
  })
  expect(await startReady(ledger, home)).toEqual([next])
  await reaches(next, 'succeeded')
  expect(existsSync(join(workspaceOf(home, next), 'ok.txt'))).toBe(true)
  const message = entries('turn').find((t) => t.message?.startsWith('build on it'))?.message
  expect(message).toContain(`starts from task #${first}'s branch`)
})

function newRepo(): string {
  const repo = tmp.make('nod-repo-')
  git(repo, 'init', '-q')
  git(repo, 'commit', '--allow-empty', '-qm', 'init')
  return repo
}

test('a repo Claude Code does not trust yet becomes a decision: yes trusts and starts, no cancels', async () => {
  process.env.FAKE_AGENT_UNTRUSTED = '1'
  const addIn = (repo: string): number =>
    ledger.add({
      brief: 'work here',
      repo,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
    })
  const trusted = addIn(newRepo())
  const refused = addIn(newRepo())
  await startTask(ledger, home, trusted)
  await startTask(ledger, home, refused)
  const [yes, no] = [trusted, refused].map((id) => ledger.decisions(id)[0])
  expect([yes?.reason, no?.reason]).toEqual(['trust', 'trust'])
  expect(entries('turn')).toEqual([])

  if (!yes || !no) throw new Error('no trust decision')
  await answer(ledger, home, yes.id, 'yes')
  await reaches(trusted, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['work here'])

  await answer(ledger, home, no.id, 'not this one')
  expect(status(refused)).toBe('cancelled')
  expect(Terminals.of(home).alive(sessionName(refused))).toBe(false)
})

test('due triggers add tasks, a source only for lines it has not printed before, and notify hears', async () => {
  // One file per event, renamed into place, so a read never sees half an event.
  const events = join(home, 'events')
  mkdirSync(events)
  writeFileSync(
    join(home, 'notify'),
    `#!/bin/sh\nf=${JSON.stringify(events)}/$$\ncat > "$f.tmp" && mv "$f.tmp" "$f.json"\n`,
  )
  chmodSync(join(home, 'notify'), 0o755)
  const items = join(home, 'items.txt')
  writeFileSync(items, 'a\told item\n')
  const base = { cron: '* * * * *', repo: null, checkCmd: null, model: null }
  const source = `cat ${JSON.stringify(items)}`
  await addTrigger(ledger, home, { ...base, brief: 'triage', source })
  await addTrigger(ledger, home, { ...base, brief: 'ask-first', source: null })
  writeFileSync(items, 'a\told item\nb\tnew item\n')

  const now = new Date(Date.now() + 120_000)
  const [fromSource, scheduled] = await tick(ledger, home, now)
  expect(await tick(ledger, home, now)).toEqual([]) // both ran this minute already
  if (fromSource === undefined || scheduled === undefined) throw new Error('triggers added no task')
  expect(ledger.get(fromSource).brief).toContain('> new item')
  expect(ledger.get(scheduled).triggerId).not.toBeNull()

  await reaches(fromSource, 'succeeded')
  await reaches(scheduled, 'needs_decision')
  const heard = (): [string, number][] =>
    readdirSync(events)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(events, f), 'utf8')))
      .map((e) => [e.event, e.task.id])
  await until(() => heard().length === 2)
  expect(heard()).toContainEqual(['succeeded', fromSource])
  expect(heard()).toContainEqual(['decision', scheduled])
})
