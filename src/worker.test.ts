import { afterAll, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { setAccountRule } from './account'
import { collect } from './gc'
import { Ledger, type Task, type TaskStatus } from './ledger'
import { DIFF_LIMIT, reviewBrief } from './review'
import { Terminals } from './tmux'
import { Todos } from './todos'
import { addTrigger, tick } from './triggers'
import {
  answer,
  drop,
  lostTurns,
  onStop,
  parseCaptures,
  parseReport,
  restart,
  restartDue,
  sessionFolder,
  sessionName,
  startReady,
  startTask,
  tell,
  trustedFile,
  workerEnv,
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
// Workers get the account in the environment; the fake keeps its transcripts there.
process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-claude-')

let home: string
let ledger: Ledger
let log: string

beforeEach(() => {
  home = tmp.make('nod-worker-')
  homes.push(home)
  mkdirSync(join(home, 'work'))
  trust(process.env.CLAUDE_CONFIG_DIR ?? null) // nod's own work folder counts as trusted
  log = join(home, 'agent.log') // where the fake logs (fake-agent.ts)
  ledger = new Ledger(home)
})

const trust = (config: string | null): void => writeFileSync(trustedFile(home, config), '')

type LogEntry = {
  event: string
  sessionId: string
  resumed?: boolean
  prompt?: string | null
  message?: string
  system?: string | null
  config?: string | null
  env?: string[]
}
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
// The task the retrospective of task `of` runs in.
const retroTask = (of: number): Task | undefined => {
  const retro = ledger.retroFor(of)
  return retro === null ? undefined : ledger.list().find((t) => t.retroId === retro.id)
}
const reaches = (id: number, want: TaskStatus): Promise<true> =>
  until(() => status(id) === want || (status(id) === 'error' && fail(id))).catch(
    (error: unknown) => {
      throw new Error(`task ${id} is not ${want}: ${String(error)}\n${whereIs(id)}`)
    },
  )
const fail = (id: number): never => {
  throw new Error(`task ${id} errored: ${ledger.get(id).error}`)
}

// Where a task got to, for a test that gave up waiting on it.
function whereIs(id: number): string {
  const task = ledger.get(id)
  const terminals = Terminals.of(home)
  const name = sessionName(id)
  const git =
    task.repo !== null && task.workspace !== null
      ? Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: task.workspace, env: process.env })
          .stdout.toString()
          .trim()
      : null
  const state = {
    status: task.status,
    error: task.error,
    attempts: ledger
      .attempts(id)
      .map((a) => [
        a.kind,
        a.outcome,
        a.checkResult,
        a.summary,
        a.error,
        a.checkOutput?.slice(0, 300),
      ]),
    decisions: ledger.decisions(id).map((d) => [d.reason, d.question.slice(0, 500)]),
    launches: entries('launch').map((l) => [l.sessionId, l.resumed, l.prompt?.slice(0, 40)]),
    turns: entries('turn').map((t) => [t.sessionId, t.message?.split('\n')[0]]),
    git,
  }
  const screen = terminals.alive(name) ? terminals.screen(name).trimEnd() : '(no terminal)'
  return `${JSON.stringify(state, null, 1)}\nscreen:\n${screen}`
}

async function add(brief: string, check: string | null = null): Promise<number> {
  const id = ledger.add({
    brief,
    repo: null,
    branch: null,
    checkCmd: check,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
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
  // One launch of this task's session; the retrospective that follows has its own.
  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').filter((l) => l.sessionId === session)).toHaveLength(1)
  expect(ledger.stats()).toMatchObject({ retries: 1, succeededWithoutDecision: 1 })
})

test('a brief longer than tmux takes in one command reaches the worker whole', async () => {
  const brief = `make it's \`$HOME\` "quoted"\n${'x'.repeat(20_000)}`
  const id = await add(brief)
  await reaches(id, 'succeeded')
  expect(entries('turn')[0]?.message).toContain(brief)
  expect(readdirSync(join(home, 'work')).filter((f) => f.startsWith('.launch-'))).toEqual([])
})

test('a question becomes a decision, and the answer goes into the same live session', async () => {
  const id = await add('ask-first, then write ok.txt', 'test -f ok.txt')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('question')
  expect(decision.question).toContain('May I proceed?')

  await answer(ledger, home, decision.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch')).toHaveLength(1)
  expect(entries('turn').map((t) => t.message)).toEqual([
    'ask-first, then write ok.txt\n\nWhen you stop, nod runs this acceptance check in this directory and sends any failure back: `test -f ok.txt`',
    'Human decision: yes',
  ])
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'answer'])
  // The whole last message is kept, not just the report line.
  expect(ledger.attempts(id).map((a) => a.report)).toEqual([
    expect.stringContaining('May I proceed?'),
    expect.stringContaining('NOD: done | did it'),
  ])
})

test('a check that keeps failing becomes a decision after the retry budget', async () => {
  const id = await add('never good enough', 'false')
  await reaches(id, 'needs_decision')
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['check_failed'])
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'retry', 'retry'])
})

test('an independent review that finds a problem sends it back into the same turn', async () => {
  const id = await add('review-strict: write the file')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'],
    ['retry', 'passed'],
  ])
  expect(ledger.attempts(id)[1]?.prompt).toStartWith(
    'An independent review of your work failed:\nok.txt is missing.',
  )
  // The reviewer gets the brief and the worker's report, not the worker's conversation.
  const first = entries('review')[0]?.message
  expect(first).toContain('> review-strict: write the file')
  expect(first).toContain('There is no acceptance check.')
  expect(first).toContain('> NOD: done | did it')
})

test('a review that gives no verdict errors the task instead of passing it', async () => {
  const id = await add('review-mute')
  await until(() => status(id) === 'error')
  expect(ledger.get(id).error).toContain('the review gave no verdict')
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

  await answer(ledger, home, decision.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.summary])).toEqual([['start', 'allowed']])
})

test('denying a permission ends the turn, so the worker hears why in a new turn', async () => {
  const id = await add('need-permission')
  const decision = await until(() => ledger.decisions(id)[0])
  await answer(ledger, home, decision.id, 'no, skip the fetch', 'human')
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
  await tell(ledger, home, id, 'second')
  await reaches(id, 'succeeded')

  Terminals.of(home).kill(sessionName(id))
  await tell(ledger, home, id, 'third')
  await reaches(id, 'succeeded')

  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.resumed])).toEqual([
    [session, false],
    [session, true],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'second', 'third'])
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(true)
  // The review judges against what the human said since the brief, too.
  expect(entries('review').at(-1)?.message).toContain('- second\n- third')
})

test('a watch with --back-to passes into that task, brought back after gc, which carries on in its session; with no transcript left the person takes the todo', async () => {
  const todos = new Todos(ledger)
  const { todo } = todos.capture(
    { title: 'Get the review answered', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  )
  const id = todos.delegate(
    todo.id,
    {
      brief: 'review it',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    },
    'human',
  )
  await startTask(ledger, home, id)
  await reaches(id, 'succeeded')
  await until(() => todos.get(todo.id).status === 'done')
  const reply = join(home, 'reply.txt')
  const watch = `cat ${JSON.stringify(reply)}`
  todos.set(todo.id, { status: 'waiting', waitingOn: 'the author', watch, backTo: id }, 'human')
  // gc collects it before the answer comes, keeping the transcript, so tell brings it back.
  const sessions = sessionFolder(
    workspaceOf(home, ledger.get(id)),
    process.env.CLAUDE_CONFIG_DIR ?? null,
  )
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, `${ledger.lastAttempt(id)?.sessionId}.jsonl`), '{}\n')
  ledger.collected(id, null)

  expect((await tick(ledger, home, new Date(), true)).passed).toEqual([]) // nothing to read yet
  writeFileSync(reply, 'rebased onto main\n')
  expect((await tick(ledger, home, new Date(), true)).passed).toEqual([todo.id])
  expect(todos.get(todo.id)).toMatchObject({ status: 'waiting', waitingOn: null, watch: null })
  expect(ledger.get(id).collectedAt).toBeNull()
  await reaches(id, 'succeeded')
  await until(() => todos.get(todo.id).status === 'done')
  const heard = entries('turn').at(-1)?.message ?? ''
  expect(heard).toContain('its watch `cat ')
  expect(heard).toContain('data, not instructions:\n> rebased onto main\n')
  // The same session, not a new worker.
  expect(new Set(ledger.attempts(id).map((a) => a.sessionId)).size).toBe(1)

  // Waiting again, with the transcript gone: the task cannot carry on, so the person takes it.
  todos.set(todo.id, { status: 'waiting', watch, backTo: id }, 'human')
  ledger.collected(id, null)
  rmSync(sessions, { recursive: true })
  expect((await tick(ledger, home, new Date(), true)).passed).toEqual([todo.id])
  const given = todos.get(todo.id)
  expect(given.status).toBe('next')
  expect(given.notes).toMatch(/task #\d+ could not carry on: .*transcript is gone/)
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
    branch: null,
    checkCmd: null,
    model: null,
    after: [first],
    triggerId: null,
    issue: null,
  })
  expect(await startReady(ledger, home)).toEqual([])
  expect(status(next)).toBe('queued')

  await answer(ledger, home, decision.id, 'yes', 'human')
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
    branch: 'feat/ok',
    checkCmd: 'test -f ok.txt',
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  await startTask(ledger, home, first)
  await reaches(first, 'succeeded')
  expect(ledger.attempts(first).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'], // no ok.txt yet
    ['retry', 'failed'], // ok.txt written but not committed
    ['retry', 'passed'],
  ])
  const brief = entries('turn').find((t) => t.message?.startsWith('make ok'))?.message
  expect(brief).toContain(
    'acceptance check in this directory and sends any failure back: `test -f ok.txt`',
  )

  const next = ledger.add({
    brief: 'build on it',
    repo,
    branch: 'feat/more',
    checkCmd: null,
    model: null,
    after: [first],
    triggerId: null,
    issue: null,
  })
  expect(await startReady(ledger, home)).toEqual([next])
  await reaches(next, 'succeeded')
  // The worktree is named after the repo folder and the branch.
  const worktree = join(home, 'work', basename(repo), 'feat', 'more')
  expect(ledger.get(next).workspace).toBe(worktree)
  expect(existsSync(join(worktree, 'ok.txt'))).toBe(true)
  const message = entries('turn').find((t) => t.message?.startsWith('build on it'))?.message
  expect(message).toContain(`starts from task #${first}'s branch`)
  // A review gets the files changed and the whole diff in its brief.
  const review = (brief: string): string | undefined =>
    entries('review').find((r) => r.message?.includes(`> ${brief}`))?.message
  expect(review('make ok')).toContain('>  ok.txt | 1 +')
  expect(review('make ok')).toContain('The whole diff:')
  expect(review('make ok')).toContain('> +ok')
  // A task's changes start where the earlier task's branch ended, so here there are none.
  const base = Bun.spawnSync(['git', 'rev-parse', 'feat/ok'], { cwd: repo }).stdout.toString()
  expect(review('build on it')).toContain(`since ${base.trim()}. There are none.`)
}, 30_000)

test('a diff too long for the review brief is cut, and the reviewer is told where', () => {
  const id = ledger.add({
    brief: 'big change',
    repo: '/repo',
    branch: 'feat/big',
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const diff = `+${'x'.repeat(DIFF_LIMIT)}`
  const brief = reviewBrief(ledger, ledger.get(id), 'NOD: done | ok', {
    start: 'abc123',
    stat: ' big.txt | 1 +\n',
    diff,
  })
  expect(brief).toContain(
    `The diff, cut at ${DIFF_LIMIT} characters; read the rest with \`git diff abc123..HEAD\`:`,
  )
  expect(brief).toContain(`> ${diff.slice(0, DIFF_LIMIT)}\n`)
  expect(brief).not.toContain(diff)
})

test('a repo task gets its submodules filled from the repo checkout, and gc still removes it', async () => {
  const lib = newRepo()
  writeFileSync(join(lib, 'a.txt'), 'lib')
  git(lib, 'add', 'a.txt')
  git(lib, 'commit', '-qm', 'lib')
  const repo = newRepo()
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib')
  git(repo, 'commit', '-qm', 'add lib')
  const id = ledger.add({
    brief: 'use the lib',
    repo,
    branch: 'feat/lib',
    checkCmd: 'test -f lib/a.txt',
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  await startTask(ledger, home, id)
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => a.checkResult)).toEqual(['passed'])

  const report = await collect(ledger, home, { before: new Date(Date.now() + 60_000) })
  expect(report.removed).toContain(id)
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(false)
})

function newRepo(): string {
  const repo = tmp.make('nod-repo-')
  git(repo, 'init', '-q')
  git(repo, 'commit', '--allow-empty', '-qm', 'init')
  return repo
}

test('a repo Claude Code does not trust yet becomes a decision: yes trusts and starts, no cancels', async () => {
  writeFileSync(join(home, 'fake-untrusted'), '')
  const addIn = (repo: string): number =>
    ledger.add({
      brief: 'work here',
      repo,
      branch: 'feat/here',
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
  const trusted = addIn(newRepo())
  const refused = addIn(newRepo())
  await startTask(ledger, home, trusted)
  await startTask(ledger, home, refused)
  const [yes, no] = [trusted, refused].map((id) => ledger.decisions(id)[0])
  expect([yes?.reason, no?.reason]).toEqual(['trust', 'trust'])
  expect(entries('turn')).toEqual([])

  if (!yes || !no) throw new Error('no trust decision')
  await answer(ledger, home, yes.id, 'yes', 'human')
  await reaches(trusted, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['work here'])

  await answer(ledger, home, no.id, 'not this one', 'human')
  expect(status(refused)).toBe('cancelled')
  expect(Terminals.of(home).alive(sessionName(refused))).toBe(false)
})

type Heard = { event: string; task?: { id: number }; error?: string; reason?: string }

// Makes <home>/notify keep each event, and returns what it has kept so far. One file per event,
// renamed into place, so a read never sees half an event.
function listen(): () => Heard[] {
  const events = join(home, 'events')
  mkdirSync(events)
  writeFileSync(
    join(home, 'notify'),
    `#!/bin/sh\nf=${JSON.stringify(events)}/$$\ncat > "$f.tmp" && mv "$f.tmp" "$f.json"\n`,
  )
  chmodSync(join(home, 'notify'), 0o755)
  return () =>
    readdirSync(events)
      .filter((f) => f.endsWith('.json'))
      .map((f): Heard => JSON.parse(readFileSync(join(events, f), 'utf8')))
}

test('due triggers add tasks, a source only for lines it has not printed before, and notify hears every turn of a task', async () => {
  const events = listen()
  const items = join(home, 'items.txt')
  writeFileSync(items, 'a\told item\n')
  const base = { cron: '* * * * *', repo: null, branch: null, checkCmd: null, model: null }
  const source = `cat ${JSON.stringify(items)}`
  await addTrigger(ledger, home, { ...base, brief: 'triage', source })
  await addTrigger(ledger, home, { ...base, brief: 'ask-first', source: null })
  writeFileSync(items, 'a\told item\nb\tnew item\n')

  const now = new Date(Date.now() + 120_000)
  const {
    added: [fromSource, scheduled],
  } = await tick(ledger, home, now, false)
  expect((await tick(ledger, home, now, false)).added).toEqual([]) // both ran this minute already
  if (fromSource === undefined || scheduled === undefined) throw new Error('triggers added no task')
  expect(ledger.get(fromSource).brief).toContain('> new item')
  expect(ledger.get(scheduled).triggerId).not.toBeNull()

  await reaches(fromSource, 'succeeded')
  await reaches(scheduled, 'needs_decision')
  const heard = (): [string, number | undefined][] => events().map((e) => [e.event, e.task?.id])
  await until(() => heard().length === 2)
  expect(heard()).toContainEqual(['succeeded', fromSource])
  expect(heard()).toContainEqual(['decision', scheduled])

  // Answers and drops are heard too, so a to-do list that mirrors nod can close what is done.
  const asked = ledger.decisions(scheduled)[0]
  if (asked === undefined) throw new Error('no decision')
  await answer(ledger, home, asked.id, 'yes', 'human')
  await reaches(scheduled, 'succeeded')
  const dropped = await add('ask-first')
  const second = await until(() => ledger.decisions(dropped)[0])
  await drop(ledger, home, second.id)
  await until(() => heard().length === 6)
  expect(heard()).toContainEqual(['answered', scheduled])
  expect(heard()).toContainEqual(['succeeded', scheduled])
  expect(heard()).toContainEqual(['cancelled', dropped])
})

test('a task that needed a retry gets a retrospective, and an approved rule reaches later workers while it is on', async () => {
  const id = await add('make ok', 'test -f ok.txt')
  await reaches(id, 'succeeded')
  const retro = await until(() => retroTask(id))
  expect(retro.brief).toContain('Check failed')
  const decision = await until(() => ledger.decisions(retro.id)[0])
  expect(decision.reason).toBe('rule')
  expect(decision.question).toContain(`its retrospective r${retro.retroId}`)
  expect(decision.question).toContain('nod rule ls')
  expect(ledger.retroFor(id)).toMatchObject({ rule: 'did it', outcome: null })

  await answer(ledger, home, decision.id, 'yes', 'human')
  expect(status(retro.id)).toBe('succeeded')
  expect(ledger.retroFor(id)?.outcome).toBe('added')
  // The rule goes in the ledger, tied to its retrospective, as added by whoever answered.
  expect(ledger.rules()).toMatchObject([
    { id: 1, text: 'did it', retroId: retro.retroId, state: 'on' },
  ])
  const actors = ledger.db.query<{ actor: string }, []>('select actor from rule_changes').all()
  expect(actors).toEqual([{ actor: 'human' }])
  const next = await add('plain')
  await reaches(next, 'succeeded')
  expect(entries('launch').at(-1)?.system).toContain('- did it')
  // The smooth task and the retrospective get none of their own.
  expect(ledger.list().filter((t) => t.retroId !== null)).toHaveLength(1)

  // Turned off, a rule reaches neither the next worker nor the next retrospective's brief, which
  // quotes the rules workers get; one that is on reaches both.
  ledger.setRule(1, { state: 'off' }, 'human')
  ledger.addRule('mine', null, 'human')
  const again = await add('make ok', 'test -f ok.txt')
  const session = ledger.attempts(again)[0]?.sessionId
  const { system } = await until(() => entries('launch').find((l) => l.sessionId === session))
  expect(system).toContain('- mine')
  expect(system).not.toContain('- did it')
  await reaches(again, 'succeeded')
  const brief = (await until(() => retroTask(again))).brief
  expect(brief).toContain('> - mine')
  expect(brief).not.toContain('> - did it')
})

test('dropping a task that gave up starts a retrospective, and declining its rule cancels it', async () => {
  const id = await add('give-up')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('failed')
  await drop(ledger, home, decision.id)
  const retro = retroTask(id)
  if (retro === undefined) throw new Error('no retrospective')

  const rule = await until(() => ledger.decisions(retro.id)[0])
  await answer(ledger, home, rule.id, 'not this one', 'human')
  expect(status(retro.id)).toBe('cancelled')
  expect(ledger.retroFor(id)?.outcome).toBe('declined')
  expect(ledger.rules()).toEqual([])
  expect(ledger.list().filter((t) => t.retroId !== null)).toHaveLength(1)
})

test('a retrospective that finds no general rule just succeeds', async () => {
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
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  ledger.startAttempt({
    taskId: retro,
    kind: 'start',
    decisionId: null,
    sessionId: 'retro-session',
    prompt: 'look back',
  })
  await onStop(ledger, home, {
    session_id: 'retro-session',
    last_assistant_message: 'Nothing general here.\nNOD: done | none',
    stop_hook_active: false,
  })
  expect(status(retro)).toBe('succeeded')
  expect(ledger.decisions(retro)).toEqual([])
  expect(ledger.retroFor(of)).toMatchObject({ rule: null, outcome: 'none' })
  // Ended, it is not taken up again, which would write over what became of it.
  await expect(tell(ledger, home, retro, 'look again')).rejects.toThrow('which ended (none)')
})

test('a worker learns its task through NOD_TASK, so the todos it changes name it', () => {
  expect(workerEnv('/h', 5)).toMatchObject({ NOD_HOME: '/h', NOD_TASK: '5' })
  expect(workerEnv('/h', null)).not.toHaveProperty('NOD_TASK')
})

test('a worker keeps only what it needs of the environment it starts from, and the account it is given', () => {
  const outer = {
    // What a terminal, an agent host and a person's shell put there for themselves.
    TERM_SESSION_ID: 'w0t0p0:example',
    CLAUDE_CODE_SSE_PORT: '12345',
    NOD_ACTOR: 'human',
    // What the worker needs.
    HTTPS_PROXY: 'http://proxy.example.com:3128',
    NODE_EXTRA_CA_CERTS: '/certs/example.pem',
    LC_ALL: 'ko_KR.UTF-8',
    ANTHROPIC_BASE_URL: 'https://llm.example.com',
  }
  // In a process started with them, as nod is: Bun leaves proxy variables set at run time out of
  // process.env's keys (measured on 1.3.14).
  const workerEnvIn = (config: string | null): Record<string, string> => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `import { workerEnv } from ${JSON.stringify(join(import.meta.dir, 'worker.ts'))}
console.log(JSON.stringify(workerEnv('/h', 5, ${JSON.stringify(config)})))`,
      ],
      { env: { ...process.env, ...outer } },
    )
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    return JSON.parse(run.stdout.toString())
  }
  const env = workerEnvIn('/accounts/a')
  expect(env).toMatchObject({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    HTTPS_PROXY: outer.HTTPS_PROXY,
    NODE_EXTRA_CA_CERTS: outer.NODE_EXTRA_CA_CERTS,
    LC_ALL: outer.LC_ALL,
    ANTHROPIC_BASE_URL: outer.ANTHROPIC_BASE_URL,
    NOD_HOME: '/h',
    NOD_TASK: '5',
    CLAUDE_CONFIG_DIR: '/accounts/a',
  })
  for (const marker of ['TERM_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'NOD_ACTOR']) {
    expect(env).not.toHaveProperty(marker)
  }
  expect(workerEnvIn(null)).not.toHaveProperty('CLAUDE_CONFIG_DIR')
})

test("a worker's terminal passes on none of the tmux server's environment", async () => {
  // As a terminal marks its panes; the home's tmux server starts with it.
  process.env.NOD_TEST_PANE_ID = 'outer'
  try {
    const id = await add('first')
    await reaches(id, 'succeeded')
  } finally {
    delete process.env.NOD_TEST_PANE_ID
  }
  // A child gets process.env as it was set at run time (TMUX_TMPDIR) only when given it.
  const server = Terminals.of(home).attachCommand('x').slice(0, 3)
  const global = Bun.spawnSync([...server, 'show-environment', '-g', 'NOD_TEST_PANE_ID'], {
    env: process.env,
  })
  expect(global.stdout.toString().trim()).toBe('NOD_TEST_PANE_ID=outer')
  const env = entries('launch')[0]?.env ?? []
  expect(env).not.toContain('NOD_TEST_PANE_ID')
  // TMUX_TMPDIR: where the tests keep nod's tmux sockets, which its hooks need too.
  expect(env).toEqual(
    expect.arrayContaining([
      'HOME',
      'PATH',
      'NOD_HOME',
      'NOD_TASK',
      'CLAUDE_CONFIG_DIR',
      'TERM',
      'TMUX_TMPDIR',
    ]),
  )
})

// Ends a worker's Claude Code and not its terminal, as a tool that switches accounts does.
function endClaude(id: number): void {
  const terminal = Terminals.of(home).panePid(sessionName(id))
  Bun.spawnSync(['pkill', '-TERM', '-P', String(terminal)])
}

test('whatever ends its Claude Code, a worker starts again in the same terminal and conversation, without the brief', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  const name = sessionName(id)
  const pane = Terminals.of(home).pane(name)
  endClaude(id)
  await until(() => entries('launch')[1])
  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.resumed, l.prompt])).toEqual([
    [session, false, 'first'],
    [session, true, null],
  ])
  expect(Terminals.of(home).pane(name)).toBe(pane)

  await tell(ledger, home, id, 'second')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'second'])
  expect(entries('launch')).toHaveLength(2)
  expect(ledger.decisions(id)).toEqual([])
}, 30_000)

test('a turn its Claude Code ended becomes a decision once it is up again, and the answer goes on in the same conversation', async () => {
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  endClaude(id)
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('interrupted')
  expect(decision.question).toContain('ended in the middle of a turn')
  expect(decision.question).toContain('> hang until ended')
  expect(ledger.attempts(id).map((a) => a.outcome)).toEqual(['error'])

  await answer(ledger, home, decision.id, 'check and carry on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch').map((l) => l.resumed)).toEqual([false, true])
  expect(entries('turn').map((t) => t.message)).toEqual([
    'hang until ended',
    expect.stringMatching(/^Your last turn was cut off.*\nHuman decision: check and carry on$/s),
  ])
}, 30_000)

test('a Claude Code that keeps exiting as it starts is not started again: the person hears why, and the next message starts it', async () => {
  const events = listen()
  const id = await add('first')
  await reaches(id, 'succeeded')
  writeFileSync(join(home, 'fake-exit'), '')
  endClaude(id)
  await until(() => !Terminals.of(home).alive(sessionName(id)))
  const error = events().find((e) => e.event === 'error')
  expect(error?.error).toContain('exited 3 times as it started')
  expect(error?.error).toContain('Not logged in')
  // Between turns there was nothing to decide.
  expect(status(id)).toBe('succeeded')

  rmSync(join(home, 'fake-exit'))
  await tell(ledger, home, id, 'again')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'again'])
}, 30_000)

test('with an account rule, a worker starts again as the current account: at once between turns, after a turn in progress, and with the message that finds it on the old one', async () => {
  const current = join(home, 'account')
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => tmp.make(`nod-account-${x}-`))
  for (const x of [a, b, c, d]) trust(x ?? null)
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('first')
  await reaches(id, 'succeeded')
  expect(ledger.get(id).account).toBe(a ?? '')

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home)).toEqual([id])
  await until(() => entries('launch')[1])

  await tell(ledger, home, id, 'need-permission')
  const permission = await until(() => ledger.decisions(id)[0])
  writeFileSync(current, `${c}\n`)
  expect(await restartDue(ledger, home)).toEqual([]) // in the middle of a turn
  await answer(ledger, home, permission.id, 'yes', 'human')
  await until(() => entries('launch')[2])

  writeFileSync(current, `${d}\n`)
  await tell(ledger, home, id, 'go on')
  await reaches(id, 'succeeded')
  await until(() => entries('turn')[2])
  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.config, l.prompt])).toEqual([
    [session, a, 'first'],
    [session, b, null],
    [session, c, null],
    [session, d, 'go on'],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'need-permission', 'go on'])
  expect(ledger.get(id).account).toBe(d ?? '')
}, 30_000)

test('a restart waits for a person attached to the worker, who hears why once', async () => {
  const events = listen()
  const id = await add('first')
  await reaches(id, 'succeeded')
  const name = sessionName(id)
  const terminals = Terminals.of(home)
  // A control-mode client is attached as a person's terminal is, without needing one.
  const [tmux = 'tmux', ...attach] = terminals.attachCommand(name)
  const person = Bun.spawn([tmux, '-C', ...attach], {
    stdin: 'pipe',
    stdout: 'ignore',
    env: process.env,
  })
  await until(() => terminals.attached(name))
  expect(await restart(ledger, home, id, 'nod restart')).toBe('attached')
  expect(await restartDue(ledger, home)).toEqual([])
  expect(events().filter((e) => e.event === 'restart_held')).toEqual([
    expect.objectContaining({ reason: 'nod restart' }),
  ])

  person.kill()
  await person.exited
  await until(() => !terminals.attached(name))
  expect(await restartDue(ledger, home)).toEqual([id])
  await until(() => entries('launch')[1])
}, 30_000)

test('a turn whose terminal went (the machine or tmux restarted) becomes a decision, and the answer reopens its conversation', async () => {
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  Terminals.of(home).killServer()
  // A turn just started may still be opening its terminal.
  expect(await lostTurns(ledger, home, new Date())).toEqual([])
  const later = new Date(Date.now() + 60_000)
  expect(await lostTurns(ledger, home, later)).toEqual([id])
  expect(await lostTurns(ledger, home, later)).toEqual([])
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  expect(decision.reason).toBe('interrupted')
  expect(decision.question).toContain('Its terminal went in the middle of a turn')

  await answer(ledger, home, decision.id, 'carry on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch').map((l) => l.resumed)).toEqual([false, true])
  expect(entries('turn').at(-1)?.message).toContain('Human decision: carry on')
}, 30_000)

test("a delegated todo waits through its task's decision, is done when it succeeds, and comes back when dropped", async () => {
  const todos = new Todos(ledger)
  const delegated = (title: string, brief: string, after: number[] = []) => {
    const todo = todos.capture(
      { title, notes: null, source: 'cli', sourceKey: null, url: null },
      'human',
    ).todo.id
    const task = todos.delegate(
      todo,
      {
        brief,
        repo: null,
        branch: null,
        checkCmd: null,
        model: null,
        after,
        triggerId: null,
        issue: null,
      },
      'human',
    )
    return { todo, task }
  }
  const asked = delegated('Ask first', 'ask-first, then write ok.txt')
  await startTask(ledger, home, asked.task)
  const question = await until(() => ledger.decisions(asked.task)[0])
  expect(todos.get(asked.todo).status).toBe('waiting')
  expect(todos.decisions().map((d) => d.todo?.id)).toEqual([asked.todo])
  await answer(ledger, home, question.id, 'yes', 'human')
  await until(() => todos.get(asked.todo).status === 'done')
  expect(todos.changes(asked.todo).at(-1)).toMatchObject({
    actor: 'nod',
    change: { status: ['waiting', 'done'] },
  })
  expect(todos.tasks(asked.todo).map((x) => x.summary)).toEqual(['did it'])

  // Dropping a task gives its todo back, and the todo of the task that waited on it too.
  const gaveUp = delegated('Give up', 'give-up')
  const after = delegated('Then this', 'after it', [gaveUp.task])
  await startTask(ledger, home, gaveUp.task)
  const failed = await until(() => ledger.decisions(gaveUp.task)[0])
  await drop(ledger, home, failed.id)
  expect(status(after.task)).toBe('cancelled')
  expect([todos.get(gaveUp.todo).status, todos.get(after.todo).status]).toEqual(['next', 'next'])
})

test('nod captures the todos a worker reports once its done is accepted, and sends a bad line back', async () => {
  const todos = new Todos(ledger)
  const inbox = () =>
    todos
      .list({
        statuses: ['inbox'],
        context: null,
        projectId: null,
        hideSomedayProjects: false,
        day: null,
      })
      .map((t) => [t.title, t.source, t.sourceKey])
  const id = await add('capture-bad: the day')
  await reaches(id, 'succeeded')
  // Nothing from the report with the bad line; only what the worker reported again.
  expect(inbox()).toEqual([['Ask Kim again', 'chat', 'm1']])
  expect(ledger.attempts(id).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'],
    ['retry', 'passed'],
  ])
  expect(ledger.attempts(id)[1]?.prompt).toStartWith('A `NOD: in` line nod cannot read:')
  const [first] = todos.list({
    statuses: ['inbox'],
    context: null,
    projectId: null,
    hideSomedayProjects: false,
    day: null,
  })
  expect(first === undefined ? null : todos.changes(first.id)[0]?.actor).toBe(`worker:${id}`)
  // Reported again by the next run, the keyed one goes in once.
  const next = await add('capture: the next day')
  await reaches(next, 'succeeded')
  expect(inbox()).toEqual([
    ['Ask Kim again', 'chat', 'm1'],
    ['Book the room', 'worker', null],
  ])
})

test('a report may ask for at most 50 captures, each with JSON nod can read', () => {
  const line = (n: number) => `NOD: in {"title": "t${n}"}`
  const many = Array.from({ length: 51 }, (_, n) => line(n)).join('\n')
  expect(parseCaptures(many)).toEqual({ error: '51 `NOD: in` lines; report at most 50' })
  expect(parseCaptures('NOD: in {"key": "k", "title": "x"}\nNOD: done | ok')).toMatchObject({
    error: expect.stringContaining('a key needs its source'),
  })
  expect(parseCaptures('NOD: in title only')).toMatchObject({
    error: expect.stringContaining('NOD: in title only'),
  })
  expect(parseCaptures('**NOD: done | nothing to capture**')).toEqual({ captures: [] })
})
