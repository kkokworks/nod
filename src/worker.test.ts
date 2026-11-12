import { Database } from 'bun:sqlite'
import {
  afterAll,
  beforeEach,
  expect,
  it,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { FakeTerminals } from '../test/fake-terminals'
import { projectFolder } from '../test/projects'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { testTmux } from '../test/tmux'
// Workers run in fake terminals here (test/fake-terminals.ts), so these tests run in a worker's
// sandbox too, which opens no pseudo-terminal for tmux. The few of tmux itself are `tmuxTest`,
// which skips them there.
import { tmuxTest } from '../test/tmux-server'
import { setAccountRule, transcriptPath } from './account'
import { ALLOW } from './allow'
import { askToLand, permissionQuestion } from './decisions'
import { workerEnv } from './env'
import { collect } from './gc'
import { onCompact, onPrompt, onStop, onStopFailure } from './hooks'
import { sendNotices } from './inbox'
import {
  Ledger,
  type NewTask,
  RETRO_STATUS,
  type RetroOutcome,
  type Task,
  type TaskStatus,
} from './ledger'
import { notify } from './notify'
import { PROMPTED_OPTION, sessionName, socketsDir, workspaceOf } from './place'
import { AT_ONCE, readAtOnce, spawn } from './proc'
import { askedAgain, reviewBrief } from './review'
import { retroBrief } from './rules'
import {
  forgetStuck,
  heldUp,
  knownDialog,
  listen as listenFor,
  SENDING,
  sendWatched,
  type Worker,
  watchStart,
} from './sending'
import { quote, type Terminals, Tmux } from './tmux'
import { Todos } from './todos'
import { heardOf, promptMark } from './transcript'
import { tick } from './triggers'
import { REVIEW } from './verify'
import {
  answer,
  cancel,
  claudeArgs,
  closeFinished,
  drop,
  firstMessage,
  lostTurns,
  overdueWaits,
  restart,
  restartDue,
  restartMark,
  resume,
  StopEvent,
  settle,
  startReady,
  startTask,
  tell,
  trustedBy,
  trustedFile,
  workerPrompt,
} from './worker'

// A test here starts workers, each a few processes (`nod run`, the fake agent, its hooks), which take
// seconds more where other work runs too, as nod's checks do.
setDefaultTimeout(30_000)

const tmp = tempDirs()
const homes: string[] = []
// The homes whose test ran on tmux (useTmux).
const tmuxHomes: string[] = []
testTmux(tmp)
afterAll(() => {
  for (const h of homes) FakeTerminals.of(h).killAll()
  for (const h of tmuxHomes) Tmux.of(h).killServer()
  tmp.removeAll()
})

// The fake stands in for `claude` through PATH, which nod passes on to worker sessions.
const bin = tmp.make('nod-fake-bin-')
const fakeAgent = resolve(import.meta.dir, '../test/fake-agent.ts')
writeFileSync(
  join(bin, 'claude'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAgent)} "$@"\n`,
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
// The home's terminals, which every call here is given: its fake ones (`fake`), but in a test of
// tmux itself (useTmux).
let terminals: Terminals
let fake: FakeTerminals
let log: string

const USUAL_SENDING = { ...SENDING }
const USUAL_REVIEW = { ...REVIEW }
beforeEach(() => {
  Object.assign(SENDING, USUAL_SENDING)
  Object.assign(REVIEW, USUAL_REVIEW)
  useHome('nod-worker-')
})

function useHome(prefix: string): void {
  home = tmp.make(prefix)
  homes.push(home)
  // As a worker's hooks have it, for those a test runs itself: the fake reviewer logs there.
  process.env.NOD_HOME = home
  mkdirSync(join(home, 'work'))
  trust(process.env.CLAUDE_CONFIG_DIR ?? null) // nod's own work folder counts as trusted
  log = join(home, 'agent.log') // where the fake logs (fake-agent.ts)
  ledger = new Ledger(home)
  fake = FakeTerminals.of(home)
  terminals = fake
}

// For a test of tmux itself: the home's tmux in place of its fake terminals.
function useTmux(): Tmux {
  const tmux = Tmux.of(home)
  tmuxHomes.push(home)
  terminals = tmux
  return tmux
}

const trust = (config: string | null): void => writeFileSync(trustedFile(home, config), '')

// Account folders as a switcher keeps them: each trusts nod's work folder, and all share one
// projects/ folder, where Claude Code keeps conversations, so any of them can go on with one.
function accounts(...names: string[]): string[] {
  const shared = tmp.make('nod-projects-')
  return names.map((n) => {
    const folder = tmp.make(`nod-account-${n}-`)
    symlinkSync(shared, join(folder, 'projects'))
    trust(folder)
    return folder
  })
}

type LogEntry = {
  event: string
  sessionId: string
  resumed?: boolean
  prompt?: string | null
  message?: string
  system?: string | null
  config?: string | null
  env?: string[]
  autocompact?: string | null
  source?: string
  context?: string
  diff?: string | null
  addDir?: string | null
  addDirReal?: string | null
  command?: string
  out?: string
}
const entries = (event: string): LogEntry[] =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        // Read as the fake has made the file and not yet written to it.
        .filter((line) => line !== '')
        .map((line): LogEntry => JSON.parse(line))
        .filter((e) => e.event === event)
    : []

async function until<T>(get: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = get()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error('timed out')
}

const status = (id: number): TaskStatus => ledger.get(id).status
// Its Stop hook is done (onStop): restarts no longer wait on it.
const settled = (id: number): Promise<true> =>
  until(() => terminals.option(sessionName(id), 'nod_settling') === '')
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
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
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

tmuxTest('a brief longer than tmux takes in one command reaches the worker whole', async () => {
  useTmux()
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

  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
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

test('a check that keeps failing says an answer leaves it as it is, and how to judge by another', async () => {
  const id = ledger.add({
    brief: 'never good enough',
    repo: newRepo(),
    branch: 'feat/wrong',
    checkCmd: 'false',
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  await reaches(id, 'needs_decision')
  expect(ledger.decisions(id).map((d) => d.question)).toEqual([
    `Still failing after 2 retries:\nThe acceptance check \`false\` failed:\n\nAn answer does not change the check. To judge the work by another, run nod check n${id} '<command>' before you answer: nod runs it once the turn your answer starts ends.`,
  ])
})

test("a question on a task with a check says an answer leaves it as it is, so a check changed first spares the old one's retries", async () => {
  // A check that fails whatever the worker changes, which it asks about first.
  const id = await add('ask-first, then take it as it is', 'false')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.question).toBe(
    `Should I go ahead?\n**NOD: question | May I proceed?**\n\nAn answer does not change the acceptance check \`false\`. To judge the work by another, run nod check n${id} '<command>' before you answer: nod runs it once the turn your answer starts ends.`,
  )
  // nod check n<id> '' before the answer: the answer's turn ends with no check, not three of `false`.
  ledger.setCheck(id, null, 'human')
  await answer(ledger, home, terminals, decision.id, 'take it as it is', 'human')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', null],
    ['answer', 'passed'],
  ])
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['question'])
})

test('a check changed before the answer to its check_failed decision is the one the turn the answer starts ends with', async () => {
  const id = await add('never good enough', 'false')
  await reaches(id, 'needs_decision')
  const [decision] = ledger.decisions(id)
  ledger.setCheck(id, 'true', 'human')
  await answer(ledger, home, terminals, decision?.id ?? 0, 'the check changed; finish', 'human')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'],
    ['retry', 'failed'],
    ['retry', 'failed'],
    ['answer', 'passed'],
  ])
  // The worker heard the old check in its first message; the answer tells it the new one.
  expect(ledger.attempts(id)[3]?.prompt).toBe(
    'Human decision: the check changed; finish\n\nnod check changed the acceptance check: when you stop, nod runs `true`.',
  )
})

test('a check changed while the old one runs leaves that run as it is, and the retry it sends back ends with the new one', async () => {
  // The old check changes the task's as it runs, with the nod check a person would run, then fails.
  const cli = resolve(import.meta.dir, 'cli.ts')
  const id = ledger.add({
    brief: 'write it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  ledger.setCheck(
    id,
    `env -u NOD_TASK -u NOD_ACTOR -u CLAUDECODE NOD_HOME=${quote(home)} bun ${quote(cli)} check n${id} true && false`,
    'human',
  )
  const old = ledger.get(id).checkCmd
  await startTask(ledger, home, terminals, id)
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.checkResult])).toEqual([
    ['start', 'failed'],
    ['retry', 'passed'],
  ])
  expect(ledger.attempts(id)[1]?.prompt).toStartWith(`The acceptance check \`${old}\` failed:`)
  expect(ledger.taskChanges(id).map((c) => [c.actor, c.change])).toEqual([
    ['human', { checkCmd: [null, old] }],
    ['human', { checkCmd: [old, 'true'] }],
  ])
}, 20_000)

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

it('a review past its time limit errors saying so, and its notice says nod tell goes on, as it does; a review that fails otherwise keeps its words and its notice', async () => {
  const todos = new Todos(ledger)
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const hearing = 'aaaa1111-0000-4000-8000-00000000000a'
  todos.addSession(p.id, hearing, '/work/one')
  todos.setSocket(hearing, '/socks/a')
  // The turn of a new task ends, and what the project's session hears of that task then.
  const ended = async (brief: string, session: string): Promise<{ id: number; heard: string }> => {
    const id = started(brief, session, null, (task) => todos.delegateNew(task, p.id, 'human'))
    await stopped(session, 'NOD: done | did it')
    expect(status(id)).toBe('error')
    expect(ledger.decisions(id)).toEqual([])
    let heard = ''
    await sendNotices(ledger, async (_socket, line) => {
      heard = JSON.parse(line).message.content
    })
    return { id, heard }
  }
  const settleIt = (id: number): string =>
    `\nnext: nod show n${id} says why; settle with the person what to do`

  // Killed by something else, as the limit kills: the same code, and no limit in it.
  const killed = await ended('review-killed: write it', 'killed-review')
  expect(ledger.get(killed.id).error).toStartWith('the review exited with 137: ')
  expect(killed.heard).toEndWith(`: the review exited with 137:${settleIt(killed.id)}`)
  const mute = await ended('review-mute: write it', 'mute-review')
  expect(ledger.get(mute.id).error).toStartWith('the review gave no verdict: ')
  expect(mute.heard).toContain(`: the review gave no verdict: Looks fine.${settleIt(mute.id)}`)

  // The fake runs on until killed, so the limit ends it however long it takes to start.
  REVIEW.timeoutMs = 600
  const { id, heard } = await ended('review-hang: write it', 'hung-review')
  const why =
    'the review hit its time limit of 0.01 minutes and nod killed it, so it gave no verdict'
  expect(ledger.get(id).error).toStartWith(`${why}\nIts last output: `)
  expect(heard).toEndWith(
    `: ${why}\nnext: nod tell n${id} <message> opens it again in the same conversation, and the review runs again on its next done`,
  )

  // What that next says, in the same conversation, once what held the review up is gone. The next
  // Stop hook runs in a process of its own, with the usual limit.
  const cwd = ledger.get(id).workspace ?? ''
  const sessions = projectFolder(process.env.CLAUDE_CONFIG_DIR ?? '', cwd)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'hung-review.jsonl'), '{}\n')
  writeFileSync(join(cwd, 'ok.txt'), '')
  await tell(ledger, home, terminals, id, 'go on')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.sessionId, a.checkResult])).toEqual([
    ['start', 'hung-review', null],
    ['followup', 'hung-review', 'passed'],
  ])
})

// Shaped like a national ID number, as a masking test's input is; the fake reviewer blocks a first
// message with one, as a user's hook that screens for personal data does (fake-agent.ts).
const ID_SHAPED = `${'9'.repeat(6)}-${'1'.repeat(7)}`

it("a reviewer whose first message a hook blocks errors the task with the hook's reason, not the message", async () => {
  const id = started(`mask ${ID_SHAPED} in the log`, 'blocked')
  await stopped('blocked', 'NOD: done | did it')
  expect(status(id)).toBe('error')
  const error = ledger.get(id).error ?? ''
  expect(error).toContain("the reviewer's first message was blocked by a hook")
  // Why comes last, after the hook's command, however long that is.
  expect(error).toEndWith(' screen-pii]: looks like a national ID number')
  // The message would only bring back the brief and the report.
  expect(error).not.toContain('Original prompt')
  expect(error).not.toContain(ID_SHAPED)
})

test('a worker that gives up, or stops without a report, becomes a decision', async () => {
  const gaveUp = await add('give-up')
  const silent = await add('silent')
  await reaches(gaveUp, 'needs_decision')
  await reaches(silent, 'needs_decision')
  expect(ledger.decisions(gaveUp).map((d) => [d.reason, d.question])).toEqual([
    ['question', 'NOD: failed | cannot do it'],
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

  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.summary])).toEqual([['start', 'allowed']])
})

test('denying a permission ends the turn, so the worker hears why in a new turn', async () => {
  const id = await add('need-permission')
  const decision = await until(() => ledger.decisions(id)[0])
  await answer(ledger, home, terminals, decision.id, 'no, skip the fetch', 'human')
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

test('a prompt nod is sure of it allows itself, with no decision, and records it; one it is not stays a decision', async () => {
  const repo = newRepo()
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'ignore dependencies')
  const clean = ledger.add({
    brief: 'need-permission rm -rf node_modules',
    repo,
    branch: 'feat/clean',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, clean)
  await reaches(clean, 'succeeded')
  expect(ledger.decisions(clean)).toEqual([])
  expect(ledger.attempts(clean)[0]?.summary).toBe('allowed by a hook')
  expect(ledger.allowed(clean).map((n) => n.note)).toEqual(['rm -rf node_modules'])

  const push = await add('need-permission git push')
  const decision = await until(() => ledger.decisions(push)[0])
  expect(decision.reason).toBe('permission')
  expect(ledger.allowed(push)).toEqual([])
  // The hook opens the decision before it exits, and the fake logs it once it has.
  await until(() => entries('permission-hook')[1])
  expect(entries('permission-hook').map((e) => [e.command, e.out?.trim()])).toEqual([
    ['rm -rf node_modules', JSON.stringify(ALLOW)],
    ['git push', ''],
  ])
})

test('dropping a decision cancels the task and closes its session', async () => {
  const id = await add('ask-first')
  const decision = await until(() => ledger.decisions(id)[0])
  await drop(ledger, home, terminals, decision.id)
  expect(status(id)).toBe('cancelled')
  expect(terminals.alive(sessionName(id))).toBe(false)
})

test('dropping a decision of a turn still running closes that turn with the session', async () => {
  const id = await add('hang')
  await until(() => entries('turn').length === 1)
  const turn = ledger.openAttempt(id)
  if (turn === null) throw new Error('no turn')
  // As a permission dialog the turn waits on (onPermissionAsk).
  await drop(
    ledger,
    home,
    terminals,
    ledger.ask(id, turn.id, 'permission', 'Claude needs your permission'),
  )
  expect(status(id)).toBe('cancelled')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.error])).toEqual([
    ['start', 'error', 'the task was cancelled'],
  ])
})

// The ends of a task its project's session hears (setStatus), as the ledger keeps them.
const endNotices = (id: number) =>
  ledger.db
    .query<{ event: string; note: string | null }, [number]>(
      'select event, note from notices where task_id = ? order by id',
    )
    .all(id)

test('nod cancel stops a running task with its turn, and the project session hears who cancelled it and why', async () => {
  const events = listen()
  const id = await add('hang')
  await until(() => entries('turn').length === 1)
  await cancel(ledger, home, terminals, id, 'human', 'not needed')
  expect(status(id)).toBe('cancelled')
  expect(ledger.get(id).error).toBe('cancelled by human: not needed')
  expect(terminals.alive(sessionName(id))).toBe(false)
  // Its turn went with its session; its folder stays for gc.
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.error])).toEqual([
    ['start', 'error', 'the task was cancelled'],
  ])
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(true)
  expect(events()).toEqual([
    {
      event: 'cancelled',
      task: { id, brief: 'hang', issue: null },
      by: 'human',
      reason: 'not needed',
    },
  ])
  expect(endNotices(id)).toEqual([{ event: 'cancelled', note: 'cancelled by human: not needed' }])
})

test('nod cancel ends a task waiting on a decision, and closes the decision', async () => {
  const events = listen()
  const id = await add('ask-first')
  const decision = await until(() => ledger.decisions(id)[0])
  // Heard before the cancel: closing its terminal ends the Stop hook that tells of it, with the hook.
  await until(() => events().some((e) => e.event === 'decision'))
  await cancel(ledger, home, terminals, id, 'human')
  expect(status(id)).toBe('cancelled')
  expect(ledger.get(id).error).toBe('cancelled by human')
  expect(ledger.decision(decision.id).answer).toBe('(the task was cancelled)')
  expect(terminals.alive(sessionName(id))).toBe(false)
  // The turn that asked ended as it asked.
  expect(ledger.attempts(id).map((a) => a.outcome)).toEqual(['needs_decision'])
  const heard = (event: string) => events().filter((e) => e.event === event)
  expect(heard('answered')).toMatchObject([
    { task: { id }, decision: { id: decision.id, answer: '(the task was cancelled)' } },
  ])
  // No reason given, none heard.
  expect(heard('cancelled')).toEqual([
    { event: 'cancelled', task: { id, brief: 'ask-first', issue: null }, by: 'human' },
  ])
})

test('nod cancel ends a queued task and the tasks that wait on it, and their todos are next actions again', async () => {
  const todos = new Todos(ledger)
  const first = delegated(todos, 'First', 'plain')
  const then = delegated(todos, 'Then', 'plain', [first.task])
  expect([status(first.task), status(then.task)]).toEqual(['queued', 'queued'])
  expect([todos.get(first.todo).status, todos.get(then.todo).status]).toEqual([
    'waiting',
    'waiting',
  ])
  await cancel(ledger, home, terminals, first.task, 'worker:7', 'superseded')
  expect([status(first.task), status(then.task)]).toEqual(['cancelled', 'cancelled'])
  expect(ledger.get(then.task).error).toBe(`task n${first.task} it waits for was cancelled`)
  expect([todos.get(first.todo).status, todos.get(then.todo).status]).toEqual(['next', 'next'])
  // Neither started, nor starts now.
  await startReady(ledger, home, terminals)
  expect([...ledger.attempts(first.task), ...ledger.attempts(then.task)]).toEqual([])
  expect(endNotices(first.task)).toEqual([
    { event: 'cancelled', note: 'cancelled by worker:7: superseded' },
  ])
  expect(endNotices(then.task)).toEqual([
    { event: 'cancelled', note: `task n${first.task} it waits for was cancelled` },
  ])
})

test('nod cancel refuses a task that has ended, and leaves it as it ended', async () => {
  const done = await finished('plain')
  const queued = () =>
    ledger.add({
      brief: 'x',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
  const failed = queued()
  ledger.error(failed, 'it broke')
  const cancelled = queued()
  ledger.cancel(cancelled, 'cancelled by human')
  const events = listen()
  for (const [id, was] of [
    [done, 'succeeded'],
    [failed, 'error'],
    [cancelled, 'cancelled'],
  ] as const) {
    const before = ledger.get(id)
    await expect(cancel(ledger, home, terminals, id, 'human')).rejects.toThrow(
      `task n${id} has ended (${was})`,
    )
    expect(ledger.get(id)).toEqual(before)
  }
  expect(events()).toEqual([])
})

test("nod cancel stops a check going on with the task's session, and no review follows", async () => {
  // The check holds until something writes to the FIFO, which it keeps open as long as it runs.
  const fifo = join(home, 'hold')
  const held = join(home, 'held')
  const checked = join(home, 'checked')
  if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0) throw new Error('mkfifo failed')
  const id = await add(
    'plain',
    `exec 3<> ${quote(fifo)}; : > ${quote(held)}; read _ <&3; : > ${quote(checked)}`,
  )
  await until(() => existsSync(held))
  await cancel(ledger, home, terminals, id, 'human')
  // The Stop hook went with the session, and the check with it: nothing reads the FIFO any more.
  const checkGone = (): boolean => {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK))
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENXIO') return true
      throw error
    }
  }
  await until(checkGone)
  expect(existsSync(checked)).toBe(false)
  expect(entries('review')).toEqual([])
  expect(status(id)).toBe('cancelled')
  expect(ledger.attempts(id).map((a) => a.checkResult)).toEqual([null])
})

it('a Stop hook that comes once its task was cancelled runs neither the check nor the review', async () => {
  const id = started('write it', 'cancel-late')
  const checked = join(home, 'checked')
  ledger.db
    .query('update tasks set check_cmd = $check where id = $id')
    .run({ check: `: > ${quote(checked)}`, id })
  await cancel(ledger, home, terminals, id, 'human')
  expect(await stopped('cancel-late', 'NOD: done | did it')).toBeNull()
  expect(existsSync(checked)).toBe(false)
  expect(entries('review')).toEqual([])
  expect(status(id)).toBe('cancelled')
  expect(ledger.get(id).error).toBe('cancelled by human')
  // Nor does it go in as a turn typed into the terminal after the cancel.
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.error])).toEqual([
    ['start', 'error', 'the task was cancelled'],
  ])
})

it('a Stop hook that comes as a cancel closes its session, its turn still open, runs neither the check nor the review', async () => {
  const id = started('write it', 'cancel-closing')
  const checked = join(home, 'checked')
  ledger.db
    .query('update tasks set check_cmd = $check where id = $id')
    .run({ check: `: > ${quote(checked)}`, id })
  // As endTask has it once its transaction ended the task, before it closes the open turn.
  ledger.cancel(id, 'cancelled by human')
  expect(await stopped('cancel-closing', 'NOD: done | did it')).toBeNull()
  expect(existsSync(checked)).toBe(false)
  expect(entries('review')).toEqual([])
  expect(status(id)).toBe('cancelled')
})

it('a task cancelled while nod starts it does not start, and keeps its folder for gc', async () => {
  const id = ledger.add({
    brief: 'plain',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const config = process.env.CLAUDE_CONFIG_DIR ?? ''
  setAccountRule(home, { command: `${cancelling(id)}; echo ${quote(config)}` })
  await startTask(ledger, home, terminals, id)
  expect(ledger.get(id)).toMatchObject({ status: 'cancelled', error: 'cancelled by human' })
  expect(ledger.attempts(id)).toEqual([])
  expect(terminals.alive(sessionName(id))).toBe(false)
  const folder = ledger.get(id).workspace
  expect(folder === null ? false : existsSync(folder)).toBe(true)
})

// The account command runs as a start begins, before its transaction: there the person cancels task
// `id`, from a process of its own, as `nod cancel` in their shell does.
function cancelling(id: number): string {
  const cli = resolve(import.meta.dir, 'cli.ts')
  // Not as the worker this test may itself run in.
  const nod = `env -u NOD_TASK NOD_HOME=${quote(home)} NOD_ACTOR=human ${quote(process.execPath)} ${quote(cli)}`
  return `${nod} cancel n${id} >/dev/null 2>&1`
}

it('a start that fails once its task was cancelled leaves it cancelled, and fails nothing', async () => {
  const id = ledger.add({
    brief: 'plain',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  // And then the account cannot be read, which would fail the start: its cancel told the person,
  // so neither an error (notifyError on what startTask throws) nor a start to resume follows.
  setAccountRule(home, { command: `${cancelling(id)}; exit 1` })
  await startTask(ledger, home, terminals, id)
  expect(ledger.get(id)).toMatchObject({ status: 'cancelled', error: 'cancelled by human' })
  expect(ledger.attempts(id)).toEqual([])
})

it('a repo task cancelled as nod waits for its Claude Code to come up stops waiting, and stays cancelled', async () => {
  // Its Claude Code never gets past its start, so nod keeps looking at its screen (awaitStart).
  writeFileSync(join(home, 'fake-slow-start'), '')
  const screen = fake.screen.bind(fake)
  // The person cancels it as nod first looks, and that look finds its terminal there (`shown`) or
  // already gone.
  for (const shown of [true, false]) {
    const id = ledger.add({
      brief: 'work here',
      repo: newRepo(),
      branch: 'feat/here',
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    let cancelled: Promise<void> | undefined
    fake.screen = (name: string): string => {
      cancelled ??= cancel(ledger, home, terminals, id, 'human')
      if (!shown) throw new Error(`can't find session: ${name}`)
      return screen(name)
    }
    await startTask(ledger, home, terminals, id)
    await cancelled
    expect(ledger.get(id)).toMatchObject({ status: 'cancelled', error: 'cancelled by human' })
    expect(terminals.alive(sessionName(id))).toBe(false)
    // One it found there it stops waiting for at once, rather than failing its start on a look at
    // the terminal gone.
    if (shown) {
      expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.error])).toEqual([
        ['start', 'error', 'the task was cancelled'],
      ])
    }
  }
})

it('nod cancel refuses a task that is landing, says to drop its decision or let nod land go on, and changes nothing', async () => {
  const events = listen()
  // Its work succeeded, and landing it asks a land decision.
  const asking = started('write it', 'cancel-land-decision')
  const turn = ledger.lastAttempt(asking)?.id ?? 0
  ledger.endAttempt(turn, { outcome: 'succeeded', summary: 'did it', report: 'NOD: done | did it' })
  ledger.succeed(asking)
  const after = ledger.add({
    brief: 'after it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [asking],
    issue: null,
  })
  const asked = ledger.ask(
    asking,
    turn,
    'land',
    'Its pull request was closed without being merged.',
  )
  // Its work succeeded, and its worker has its landing work, in a turn going on.
  const handed = started('write that', 'cancel-land-handed')
  ledger.setLanding(handed, { handedAt: new Date().toISOString() })
  for (const [id, instead] of [
    [asking, `nod drop d${asked} stops its landing`],
    [handed, `nod land n${handed} goes on landing it`],
  ] as const) {
    const [task, landing, decisions] = [ledger.get(id), ledger.landing(id), ledger.decisions(id)]
    const refused = cancel(ledger, home, terminals, id, 'human', 'merged by hand')
    await expect(refused).rejects.toThrow(`task n${id} succeeded and is landing`)
    await expect(refused).rejects.toThrow(instead)
    expect([ledger.get(id), ledger.landing(id), ledger.decisions(id)]).toEqual([
      task,
      landing,
      decisions,
    ])
  }
  expect(ledger.decision(asked).answer).toBeNull()
  expect(ledger.openAttempt(handed)).not.toBeNull()
  expect(status(after)).toBe('queued')
  expect(events()).toEqual([])
})

test('tell continues the same session, and reopens it from the transcript once it has ended', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await tell(ledger, home, terminals, id, 'second')
  await reaches(id, 'succeeded')

  fake.kill(sessionName(id))
  await tell(ledger, home, terminals, id, 'third')
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

// A task that has succeeded, its Stop hook done.
async function finished(brief: string): Promise<number> {
  const id = await add(brief)
  await reaches(id, 'succeeded')
  await settled(id)
  return id
}
// Just past the hour a finished task keeps its terminal.
const hourOn = (id: number): Date =>
  new Date(Date.parse(ledger.get(id).finishedAt ?? '') + 60 * 60_000 + 1000)
// What the fake logged of the task's own session, not of a retrospective that follows it.
const ofSession = (id: number, event: string): LogEntry[] =>
  entries(event).filter((e) => e.sessionId === ledger.attempts(id)[0]?.sessionId)
const resumedOf = (id: number) => ofSession(id, 'launch').map((l) => l.resumed)
const turnsOf = (id: number) => ofSession(id, 'turn').map((t) => t.message)

test('the tick closes the terminal of a task finished an hour ago, and a message goes on in the same conversation', async () => {
  const id = await finished('first')
  const name = sessionName(id)
  expect((await tick(ledger, home, terminals, new Date(), false)).closed).toEqual([])
  expect(terminals.alive(name)).toBe(true)

  expect((await tick(ledger, home, terminals, hourOn(id), false)).closed).toEqual([id])
  expect(terminals.alive(name)).toBe(false)
  // Only the terminal goes: the folder and the ledger stay as they were.
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(true)
  expect(ledger.get(id)).toMatchObject({ status: 'succeeded', collectedAt: null })

  await tell(ledger, home, terminals, id, 'second')
  await reaches(id, 'succeeded')
  expect(resumedOf(id)).toEqual([false, true])
  expect(turnsOf(id)).toEqual(['first', 'second'])
})

test('a decision a task gets once the tick closed its terminal is answered in the same conversation', async () => {
  const id = await finished('first')
  expect(await closeFinished(ledger, home, terminals, hourOn(id))).toEqual([id])
  // As landing asks later (land.ts), when a gate fails on the branch.
  await askToLand(ledger, home, id, 'check_failed', 'The gate failed: take the name out.')
  const decision = await until(() => ledger.decisions(id)[0])

  await answer(ledger, home, terminals, decision.id, 'take it out', 'human')
  await reaches(id, 'succeeded')
  expect(resumedOf(id)).toEqual([false, true])
  expect(turnsOf(id)).toEqual(['first', 'Human decision: take it out'])
})

test('the tick leaves the terminal of a finished task a person is attached to, one whose Stop hook still checks, one with a turn open, or one showing a dialog a decision waits on', async () => {
  const id = await finished('first')
  const name = sessionName(id)
  const attached = spyOn(terminals, 'attached').mockImplementation(() => true)
  const close = () => closeFinished(ledger, home, terminals, hourOn(id))
  expect(await close().finally(() => attached.mockRestore())).toEqual([])
  // A person typed in it half an hour after it finished, then left.
  const used = spyOn(terminals, 'lastUsed').mockImplementation(
    () => Date.parse(ledger.get(id).finishedAt ?? '') + 30 * 60_000,
  )
  expect(await close().finally(() => used.mockRestore())).toEqual([])
  terminals.setOption(name, 'nod_settling', String(process.pid))
  expect(await close()).toEqual([])
  terminals.setOption(name, 'nod_settling', null)
  // As a hook of a turn a person typed in records it (currentAttempt).
  const typed = ledger.startAttempt({
    taskId: id,
    kind: 'followup',
    decisionId: null,
    sessionId: ledger.lastAttempt(id)?.sessionId ?? '',
    prompt: '(typed into the terminal)',
  })
  expect(await close()).toEqual([])
  ledger.failAttempt(typed, 'test')
  // A task that errored with a permission dialog still up, its decision open.
  const asked = ledger.ask(id, typed, 'permission', 'Claude needs your permission')
  ledger.error(id, 'it broke')
  expect(await close()).toEqual([])
  expect(terminals.alive(name)).toBe(true)

  ledger.dismiss(asked, 'test')
  expect(await close()).toEqual([id])
})

// A person attaches to a task finished long ago, types a long turn in and leaves while it runs.
test('a turn a person types into a finished task is in the ledger from its start, so its terminal stays past the hour after their last key', async () => {
  const id = await finished('first')
  const name = sessionName(id)
  const long = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: long })
  fake.attach(name)
  terminals.send(name, 'hang until ended')
  await until(() => turnsOf(id).length === 2)
  fake.detach(name)

  // Its prompt hook opened the turn, as the Stop hook would have at its end; the task is as it was.
  expect(ledger.openAttempt(id)).toMatchObject({
    kind: 'followup',
    prompt: '(typed into the terminal)\nhang until ended',
  })
  expect(ledger.get(id).status).toBe('succeeded')
  // tmux keeps when in seconds.
  const hourAfter = new Date(Date.now() + 60 * 60_000 + 1000)
  expect(await closeFinished(ledger, home, terminals, hourAfter)).toEqual([])
  expect(terminals.alive(name)).toBe(true)
  // Nothing of the hook went into the conversation.
  expect(entries('prompt-hook-said')).toEqual([])

  // Then they had stopped it with Escape, which Claude Code records in the transcript and runs no
  // Stop for: the tick ends the turn, and the terminal goes as any idle one.
  const session = ledger.attempts(id)[0]?.sessionId ?? ''
  const file = transcriptPath(ledger.get(id).account || null, session)
  const stop = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
  appendFileSync(file ?? '', `${JSON.stringify({ type: 'user', message: stop })}\n`)
  expect(await closeFinished(ledger, home, terminals, hourAfter)).toEqual([id])
  expect(ledger.attempts(id).at(-1)).toMatchObject({
    outcome: 'error',
    error: 'the person stopped it (Escape)',
  })
})

// The same for gc, by hand or the tick's sweep: the task reads as succeeded until that turn's Stop.
test('gc leaves a finished task with a turn a person typed still open, and takes it once that turn ended without a Stop', async () => {
  const id = await finished('first')
  const name = sessionName(id)
  fake.attach(name)
  terminals.send(name, 'hang until ended')
  await until(() => turnsOf(id).length === 2)
  fake.detach(name)
  expect(ledger.get(id).status).toBe('succeeded')

  expect(await collect(ledger, home, terminals, { ids: [id] })).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id, reason: 'a turn is open in its terminal' }],
  })
  expect(terminals.alive(name)).toBe(true)
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(true)
  expect(ledger.get(id).collectedAt).toBeNull()

  // They had stopped it with Escape (no Stop): gc ends the turn, then takes the task as any other.
  const session = ledger.attempts(id)[0]?.sessionId ?? ''
  const file = transcriptPath(ledger.get(id).account || null, session)
  const stop = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
  appendFileSync(file ?? '', `${JSON.stringify({ type: 'user', message: stop })}\n`)
  expect((await collect(ledger, home, terminals, { ids: [id] })).removed).toEqual([id])
  expect(terminals.alive(name)).toBe(false)
  expect(ledger.attempts(id).at(-1)).toMatchObject({
    outcome: 'error',
    error: 'the person stopped it (Escape)',
  })
})

// A person attaches to a finished task and steers it: they stop a turn at its permission dialog
// (Escape, no Stop), then type another, which goes on in the turn still open.
test('what a person types into a worker’s terminal is kept once each, as theirs, for the review of its turn, and nod does not send it again', async () => {
  const id = await finished('first')
  const name = sessionName(id)
  fake.attach(name)
  terminals.send(name, 'need-permission')
  await until(() => ledger.decisions(id)[0])
  terminals.keys(name, 'Escape')
  terminals.send(name, 'use tabs')
  await until(() => entries('review')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  fake.detach(name)
  expect(turnsOf(id)).toEqual(['first', 'need-permission', 'use tabs'])
  expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
    ['start', 'first'],
    ['followup', '(typed into the terminal)\nneed-permission'],
  ])
  expect(ledger.messages(id).map((m) => m.text)).toEqual(['(typed into the terminal)\nuse tabs'])
  expect(entries('review')[1]?.message).toContain(
    'later words win:\n- (typed into the terminal) need-permission\n- (typed into the terminal) use tabs\n\n',
  )
}, 40_000)

test('a terminal that goes while the tick closes the others is not counted, and does not stop it', async () => {
  const gone = await finished('first')
  const other = await finished('second')
  // gc or drop closes it once the tick has listed the terminals.
  const attached = terminals.attached.bind(terminals)
  const closing = spyOn(terminals, 'attached').mockImplementation((name) => {
    if (name === sessionName(gone)) fake.kill(name)
    return attached(name)
  })

  const closed = await closeFinished(ledger, home, terminals, hourOn(other)).finally(() =>
    closing.mockRestore(),
  )

  expect(closed).toEqual([other])
})

test('a task told to go on while the tick closes the terminals before it keeps its own', async () => {
  const first = await finished('first')
  const told = await finished('second')
  // `nod tell` comes as the tick closes the terminal before; its turn goes on past the tick.
  const close = terminals.close.bind(terminals)
  const closing = spyOn(terminals, 'close').mockImplementation(async (name) => {
    if (name === sessionName(first)) await tell(ledger, home, terminals, told, 'hang until ended')
    return close(name)
  })

  const closed = await closeFinished(ledger, home, terminals, hourOn(told)).finally(() =>
    closing.mockRestore(),
  )

  expect(closed).toEqual([first])
  expect(terminals.alive(sessionName(told))).toBe(true)
  // In the terminal it had: no second launch.
  await until(() => turnsOf(told).length === 2)
  expect(resumedOf(told)).toEqual([false])
  expect(turnsOf(told)).toEqual(['second', 'hang until ended'])
})

test('gc of a task whose folder is already gone closes its terminal too', async () => {
  const id = await finished('first')
  rmSync(workspaceOf(home, ledger.get(id)), { recursive: true })

  expect(await collect(ledger, home, terminals, { ids: [id] })).toEqual({
    removed: [],
    clean: [id],
    skipped: [],
  })
  expect(terminals.alive(sessionName(id))).toBe(false)
})

test('a brief or a message that starts with a dash reaches the worker as a message, not an option', async () => {
  const id = await add('- fix the bug')
  await reaches(id, 'succeeded')
  fake.kill(sessionName(id))
  await tell(ledger, home, terminals, id, '-v too')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['- fix the bug', '-v too'])
})

test('a notify that cannot run changes nothing else: the task succeeds, and a passing watch makes its todo next', async () => {
  writeFileSync(join(home, 'notify'), '#!/bin/sh\nexit 0\n') // not executable
  const todos = new Todos(ledger)
  const { todo } = todos.capture(
    { title: 'Get the review answered', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  )
  const taskId = todos.delegate(
    todo.id,
    {
      brief: 'review it',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    },
    'human',
  )
  await startTask(ledger, home, terminals, taskId)
  await reaches(taskId, 'succeeded')
  await until(() => todos.get(todo.id).status === 'done')
  todos.set(todo.id, { status: 'waiting', watch: 'true' }, 'human', [], 'done')
  expect((await tick(ledger, home, terminals, new Date(), true)).passed).toEqual([todo.id])
  expect(todos.get(todo.id).status).toBe('next')
}, 30_000)

tmuxTest(
  'a message pastes without control characters, which could end the paste and type keys',
  async () => {
    useTmux()
    const id = await add('first')
    await reaches(id, 'succeeded')
    await tell(ledger, home, terminals, id, 'see\x1b[201~ this\x07\r\nand\tthat')
    await reaches(id, 'succeeded')
    expect(entries('turn').map((t) => t.message)).toEqual(['first', 'see[201~ this\nand\tthat'])
  },
  30_000,
)

it('a stop from a session nod did not start changes nothing', async () => {
  const out = await onStop(ledger, home, terminals, {
    session_id: 'not-ours',
    last_assistant_message: 'NOD: done | x',
    stop_hook_active: false,
  })
  expect(out).toBeNull()
  expect(ledger.list()).toEqual([])
})

it('a command past its time ends with what it started, which holds its output', async () => {
  // Bun's `timeout` alone ended only `sh`, and the run waited on `sleep`, which holds the output.
  // That `sleep` goes too is tested on runGroup (notify.test.ts).
  const run = await spawn(['sh', '-c', 'sleep 30; :'], undefined, { timeoutMs: 1000 })
  expect(run.code).not.toBe(0)
}, 10_000)

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
    issue: null,
  })
  expect(await startReady(ledger, home, terminals)).toEqual([])
  expect(status(next)).toBe('queued')

  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  await reaches(next, 'succeeded')
  const message = entries('turn').find((t) => t.message?.startsWith('then this'))?.message
  expect(message).toContain(`- n${first} ask-first: did it`)
})

test('in a repo, done needs the work committed, and the next task starts from that branch', async () => {
  const repo = newRepo()
  const first = ledger.add({
    brief: 'make ok',
    repo,
    branch: 'feat/ok',
    checkCmd: 'test -f ok.txt',
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, first)
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
  // A repo worker starts with the subagent review in its system prompt.
  expect(entries('launch').find((l) => l.prompt?.startsWith('make ok'))?.system).toContain(
    'subagent',
  )

  const next = ledger.add({
    brief: 'build on it',
    repo,
    branch: 'feat/more',
    checkCmd: null,
    model: null,
    after: [first],
    issue: null,
  })
  expect(await startReady(ledger, home, terminals)).toEqual([next])
  await reaches(next, 'succeeded')
  // The worktree is named after the repo folder and the branch.
  const worktree = join(home, 'work', basename(repo), 'feat', 'more')
  expect(ledger.get(next).workspace).toBe(worktree)
  expect(existsSync(join(worktree, 'ok.txt'))).toBe(true)
  const message = entries('turn').find((t) => t.message?.startsWith('build on it'))?.message
  expect(message).toContain(`starts from task n${first}'s branch`)
  // A review gets the files changed in its brief, and reads the diff itself.
  const review = (brief: string): string | undefined =>
    entries('review').find((r) => r.message?.includes(`> ${brief}`))?.message
  expect(review('make ok')).toContain('>  ok.txt | 1 +')
  expect(review('make ok')).toContain('Read all of it with the Read tool before you judge')
  expect(review('make ok')).not.toContain('> +ok')
  // A task's changes start where the earlier task's branch ended, so here there are none.
  const base = Bun.spawnSync(['git', 'rev-parse', 'feat/ok'], { cwd: repo }).stdout.toString()
  expect(review('build on it')).toContain(`since ${base.trim()}. There are none.`)
  // The worker hears the same start, for its subagent review.
  expect(message).toContain(`Your branch starts at commit ${base.trim()}.`)
  // The first task needed retries, so it has a retrospective, which quotes only what every worker
  // gets, not a repo worker's subagent review.
  expect((await until(() => retroTask(first))).brief).not.toContain('subagent')
}, 30_000)

// A repo task as startTask starts it, but without its terminal: a worktree on a new branch made
// from `from` (else the repo's HEAD), for a test that plays its worker's turn with git itself.
function startedInRepo(
  repo: string,
  session: string,
  from: string[] = [],
): { id: number; cwd: string } {
  const brief = `work in ${session}`
  const id = ledger.add({
    brief,
    repo,
    branch: `feat/${session}`,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  git(repo, 'worktree', 'add', '-q', '-b', `feat/${session}`, cwd, ...from)
  ledger.setRunning(id, cwd)
  ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: session,
    prompt: brief,
  })
  return { id, cwd }
}

function commit(cwd: string, file: string, text = `${file}\n`): void {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', file)
}

// The remote's default branch, as the last fetch left it: where the main clone is now.
function publish(repo: string): void {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
}

const reviewEntry = (id: number): LogEntry | undefined =>
  entries('review').find((r) => r.message?.includes(`nod task n${id}.`))
const reviewOf = (id: number): string => reviewEntry(id)?.message ?? ''

// The files task `id`'s reviewer read in the diff nod saved for it, which is what the command its
// brief names prints, run in `cwd`.
function reviewed(id: number, cwd: string): (string | undefined)[] {
  const command = /`(git diff [^`]+)`/.exec(reviewOf(id))?.[1]
  if (command === undefined) throw new Error(`no diff command in:\n${reviewOf(id)}`)
  const run = Bun.spawnSync(command.split(' '), { cwd })
  if (run.exitCode !== 0) throw new Error(`${command}: ${run.stderr.toString()}`)
  const diff = reviewEntry(id)?.diff
  expect(diff).toBe(run.stdout.toString())
  return [...(diff ?? '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])
}

it('the reviewer reads the diff from a file nod saves, so a hook on its first message never sees the code', async () => {
  const { id, cwd } = startedInRepo(newRepo(), 'mask')
  commit(cwd, 'mask.test.ts', `expect(mask('${ID_SHAPED}')).toBe('******-*******')\n`)
  // A temp folder behind a link, as macOS keeps it, on any machine.
  const linked = join(tmp.make('nod-linked-'), 'tmp')
  symlinkSync(tmp.make('nod-real-tmp-'), linked)
  const was = process.env.TMPDIR
  process.env.TMPDIR = linked
  try {
    await stopped('mask', 'NOD: done | masked it')
  } finally {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
  }
  expect(status(id)).toBe('succeeded')
  expect(reviewOf(id)).toContain('Files changed:\n>  mask.test.ts | 1 +')
  expect(reviewOf(id)).not.toContain(ID_SHAPED)
  expect(reviewed(id, cwd)).toEqual(['mask.test.ts'])
  // With the Read tool, in a folder it is given, since a hook may shorten what a shell command
  // prints; the folder goes once the review ends.
  const saved = /`([^`]+\.diff)`/.exec(reviewOf(id))?.[1] ?? ''
  expect(reviewOf(id)).toContain('Read all of it with the Read tool before you judge')
  expect(reviewEntry(id)?.addDir).toBe(dirname(saved))
  // Through no link (macOS keeps temp folders behind one), so the folder it may read and the file
  // it reads are one path however Claude Code compares them.
  expect(reviewEntry(id)?.addDir).toBe(reviewEntry(id)?.addDirReal)
  expect(existsSync(dirname(saved))).toBe(false)
})

it("the review reads the task's own commits, from where its branch started on the default branch or on an earlier task's branch", async () => {
  const repo = newRepo()
  publish(repo)
  const plain = startedInRepo(repo, 'plain')
  commit(plain.cwd, 'own.txt')
  const first = startedInRepo(repo, 'first')
  commit(first.cwd, 'first.txt')
  // As `--after` starts it: on the earlier task's branch, with its commits.
  const next = startedInRepo(repo, 'next', ['feat/first'])
  commit(next.cwd, 'next.txt')
  // Another pull request lands meanwhile, and neither worker moves onto it.
  commit(repo, 'other.txt')
  publish(repo)
  await stopped('plain', 'NOD: done | did it')
  await stopped('next', 'NOD: done | did it')
  expect(reviewed(plain.id, plain.cwd)).toEqual(['own.txt'])
  expect(reviewed(next.id, next.cwd)).toEqual(['next.txt'])
})

it("the review reads only the task's own commits once its worker moved them onto the default branch, also after the earlier task was squash-merged", async () => {
  const repo = newRepo()
  publish(repo)
  const moved = startedInRepo(repo, 'moved')
  commit(moved.cwd, 'own.txt')
  const merged = startedInRepo(repo, 'merged')
  commit(merged.cwd, 'mine.txt')
  const first = startedInRepo(repo, 'first')
  commit(first.cwd, 'first.txt')
  const next = startedInRepo(repo, 'next', ['feat/first'])
  commit(next.cwd, 'next.txt')
  // Another pull request lands, then the earlier task, squashed into a new commit.
  commit(repo, 'other.txt')
  commit(repo, 'first.txt')
  publish(repo)
  // Each worker moves its own commits onto the default branch itself, as a brief may tell it to.
  git(moved.cwd, 'rebase', '-q', 'origin/main')
  git(next.cwd, 'rebase', '-q', '--onto', 'origin/main', 'feat/first')
  // Or brings it in with a merge.
  git(merged.cwd, 'merge', '-q', '--no-edit', 'origin/main')
  await stopped('moved', 'NOD: done | did it')
  await stopped('next', 'NOD: done | did it')
  await stopped('merged', 'NOD: done | did it')
  expect(reviewed(moved.id, moved.cwd)).toEqual(['own.txt'])
  expect(reviewed(next.id, next.cwd)).toEqual(['next.txt'])
  expect(reviewed(merged.id, merged.cwd)).toEqual(['mine.txt'])
  // Nor do the files changed in the brief name the default branch's.
  expect(reviewOf(moved.id)).not.toContain('other.txt')
  expect(reviewOf(next.id)).not.toContain('other.txt')
})

it('a repo worker is told to have a subagent review its branch from where it starts, and a worker without a repo is not', () => {
  const task = (repo: string | null): Task =>
    ledger.get(
      ledger.add({
        brief: 'fix it',
        repo,
        branch: repo === null ? null : 'feat/fix',
        checkCmd: null,
        model: null,
        after: [],
        issue: null,
      }),
    )
  const [inRepo, alone] = [task('/repo'), task(null)]
  // Read as one line, so rewrapping the prompt does not break the checks.
  const prompt = workerPrompt(ledger, inRepo).replaceAll('\n', ' ')
  // The worker reviews the diff itself first (a trial, see SUBAGENT_REVIEW_PROMPT), under a marker
  // its transcript is searched for, and fixes nothing until the subagent, which never hears what it
  // found, has reviewed the same diff. No other agent helps the self-review, and a fork would
  // inherit the conversation with its findings.
  expect(prompt).toContain(
    'commit, then review `git diff <start>..HEAD` yourself, starting no agent for it, then have a new subagent (Agent tool, not a fork) review it',
  )
  expect(prompt).toContain(
    'first line starts with `Self-review findings:` in English, word for word',
  )
  expect(prompt).toContain('with none, that line is `Self-review findings: none`')
  // In the response that starts the subagent: a response of text alone would end the turn with no
  // report line, and nod would ask the human about it.
  expect(prompt).toContain(
    'Then, in one response, write your result as text of its own whose first line starts with',
  )
  expect(prompt).toContain(
    'and start the subagent. Change or commit no files here until its first review reports.',
  )
  expect(prompt).toContain('not your reasons or your findings')
  expect(prompt).toContain('Fix the findings that have a scenario, yours and its')
  // One self-review, paired with the first review.
  expect(prompt).toContain('have it review again with no second self-review')
  expect(prompt).toContain('who found it (your self-review, the subagent, or both)')
  // nod tells a new start as it lands the branch, and a worker that moves the branch knows its own.
  expect(prompt).toContain(
    'start: the commit nod last said your branch starts at, or the one you rebased it onto since',
  )
  // A review-only task has nothing to review, and a turn nod tells to skip the subagent review
  // (a conflict, the PR text) skips the self-review with it.
  expect(prompt).toContain(
    'Skip both if that diff is empty or you are told to skip the subagent review.',
  )
  // Where the Agent tool runs only in the background, a worker cannot keep its turn open until the
  // review reports; it stops, and nod waits for the review (settle).
  expect(prompt).toContain('Report done only once it has reported')
  expect(prompt).toContain('if it runs in the background, you may stop while it works, as above')
  expect(prompt).toContain('nod then waits for that work instead of asking the human')
  // The stash is shared with every other worktree of the repo, and a worktree's record in the
  // shared .git is one the sandbox will not let the reviewer remove.
  expect(prompt).toContain('It changes no files here')
  expect(prompt).toContain(
    'run in <start> unpacked by `git archive` into the scratchpad and left there, never via `git worktree`, stash or checkout',
  )
  // A subagent does not read the worker's prompt, and its rm of that folder waits for a human.
  expect(prompt).toContain(
    "Give it the brief, the human's later words, that range and the file rules above, not your reasons",
  )
  expect(prompt).not.toContain('git worktree add')
  expect(prompt).toContain('file:line')
  expect(prompt).toContain('its confidence')
  expect(firstMessage(ledger, inRepo, 'abc123')).toBe(
    'fix it\n\nYour branch starts at commit abc123.',
  )
  expect(workerPrompt(ledger, alone)).not.toContain('subagent')
  // What every worker gets, as a retrospective quotes it.
  expect(workerPrompt(ledger, null)).not.toContain('subagent')
  // Every worker may wait on background work, and tell another task's worker something.
  const every = workerPrompt(ledger, null).replaceAll('\n', ' ')
  expect(every).toContain('nod then waits for that work instead of asking the human')
  expect(every).toContain('NOD: tell n<task> <message, on one line>')
  expect(every).toContain("worker is a peer's: weigh it, but the human's instructions come first")
  // Deleting the way nod allows itself (harmless in allow.ts), or not at all, so no decision opens
  // while the human is away; and no memory other sessions would read unchecked.
  expect(every).toContain(
    'Put temporary files in your scratchpad directory and leave them there: it is a temporary folder.',
  )
  expect(every).toContain('nod gc removes with this directory after the task')
  expect(every).toContain('Delete files git tracks with git rm.')
  expect(every).toContain(
    'run rm -rf <relative paths> as a command of its own: nothing chained to it, no .., and only ASCII letters, digits and . _ / @ - in the paths, so no variables, quotes or globs.',
  )
  expect(every).toContain(
    'In a git repository nod then allows it at once if what goes is committed or ignored by git',
  )
  expect(every).toContain('Give these file rules to the agents you start too.')
  expect(every).toContain(
    "Do not write to Claude Code's memory directory, whatever other instructions say",
  )
  expect(every).toContain('Put what a later session should know in your final report instead')
  expect(firstMessage(ledger, alone, null)).toBe('fix it')
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
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  await reaches(id, 'succeeded')
  expect(ledger.attempts(id).map((a) => a.checkResult)).toEqual(['passed'])

  // gc leaves it while its Stop hook still tells of its end.
  await settled(id)
  const report = await collect(ledger, home, terminals, { before: new Date(Date.now() + 60_000) })
  expect(report.removed).toContain(id)
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(false)
})

// A repo whose own checkout of its submodule `lib` is empty, so there is nothing to fill a
// worktree's from, and a task in it.
function unfilledLib(check: string | null = null): { repo: string; id: number } {
  const repo = newRepo()
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', newRepo(), 'lib')
  git(repo, 'commit', '-qm', 'add lib')
  git(repo, 'submodule', 'deinit', '-q', '-f', 'lib')
  const id = ledger.add({
    brief: 'use the lib',
    repo,
    branch: 'feat/lib',
    checkCmd: check,
    model: null,
    after: [],
    issue: null,
  })
  return { repo, id }
}

const failure = (start: Promise<unknown>): Promise<string> =>
  start.then(
    () => {
      throw new Error('it started')
    },
    (error: Error) => error.message,
  )

it('a repo task whose submodules cannot be filled leaves no worktree or branch behind, and says how to fill them', async () => {
  const { repo, id } = unfilledLib()

  const error = await failure(startTask(ledger, home, terminals, id))

  expect(error).toContain('submodule lib')
  expect(error).toContain(
    `check that out first: git -C ${quote(repo)} submodule update --init 'lib'`,
  )
  expect(error).toEndWith(`\nFix what stopped it, then \`nod resume n${id}\` starts it again.`)
  expect(ledger.get(id).status).toBe('error')
  expect(ledger.get(id).error).toBe(error)
  expect(ledger.get(id).workspace).toBeNull()
  expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(false)
  const branches = Bun.spawnSync(['git', 'branch', '--list', 'feat/lib'], { cwd: repo })
  expect(branches.stdout.toString()).toBe('')
  // A start that failed, which keeps why once the task starts again.
  const [first, ...more] = ledger.attempts(id)
  expect([first?.kind, first?.outcome, more.length]).toEqual(['start', 'error', 0])
  expect(first?.error).toStartWith('submodule lib from ')
})

test('a repo task whose folder is taken leaves no branch of its own behind, and keeps one that was there', async () => {
  const repo = newRepo()
  const addOn = (branch: string): number =>
    ledger.add({
      brief: 'work here',
      repo,
      branch,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
  const branches = (): string =>
    Bun.spawnSync(['git', 'branch', '--list', 'feat/*'], { cwd: repo }).stdout.toString()
  const taken = addOn('feat/taken')
  const folder = workspaceOf(home, ledger.get(taken))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'mine.txt'), 'not the task’s')
  git(repo, 'branch', 'feat/theirs')
  const theirs = addOn('feat/theirs')

  expect(await failure(startTask(ledger, home, terminals, taken))).toContain('already exists')
  expect(await failure(startTask(ledger, home, terminals, theirs))).toContain('already exists')

  // Left, the branch would keep the task from starting again once the folder is cleared.
  expect(branches()).toBe('  feat/theirs\n')
  expect(readFileSync(join(folder, 'mine.txt'), 'utf8')).toBe('not the task’s')
  // Starting it again clears nothing either: no start was cut off, so the branch is not one's.
  expect(await failure(resume(ledger, home, terminals, theirs))).toContain('already exists')
  expect(branches()).toBe('  feat/theirs\n')
})

// A task without a repo that fails before its worker starts, as long as a file sits where its
// folder goes. Returns it once it failed.
async function blocked(after: number[] = []): Promise<number> {
  const id = ledger.add({
    brief: 'first',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after,
    issue: null,
  })
  writeFileSync(workspaceOf(home, ledger.get(id)), '')
  expect(await failure(startTask(ledger, home, terminals, id))).toContain(`nod resume n${id}`)
  return id
}

const outcomes = (id: number): (string | null)[][] =>
  ledger.attempts(id).map((a) => [a.kind, a.outcome])

test('a task that failed before it started takes no message, and resume tries it again, once for two at once', async () => {
  const id = await blocked()
  // gc collected it, recording a head of a branch by its name, which is not the task's.
  ledger.collected(id, 'abc123')

  expect(await failure(tell(ledger, home, terminals, id, 'go on'))).toBe(
    `task n${id} has not started. Fix what stopped it, then \`nod resume n${id}\` starts it again.`,
  )
  // Nothing fixed it, so it fails again, and only one of two resumes at once tries.
  const [one, two] = await Promise.all([
    failure(resume(ledger, home, terminals, id)),
    failure(resume(ledger, home, terminals, id)),
  ])
  expect(one).toContain(`nod resume n${id}`)
  expect(two).toBe(`task n${id} has not started. ${restartMark(process.pid, id)}.`)
  expect(outcomes(id)).toEqual([
    ['start', 'error'],
    ['start', 'error'],
  ])
  const task = ledger.get(id)
  expect([task.status, task.workspace, task.collectedAt, task.head]).toEqual([
    'error',
    null,
    null,
    null,
  ])
})

// A process that has ended, for the mark of a resume cut off (restartMark).
const gone = (): number => Bun.spawnSync(['true']).pid

test('a resume cut off as it starts a task again is taken over by the next one, but not while its process runs', async () => {
  const id = await blocked()
  // As a resume stopped as it starts the task leaves it: running, with no workspace.
  const pid = gone()
  expect(ledger.claimRestart(id, restartMark(pid, id), null)).toBe(true)
  expect(await failure(tell(ledger, home, terminals, id, 'go on'))).toBe(
    `task n${id} has not started. nod resume (pid ${pid}) is starting it again; if that process is gone, nod resume n${id} takes over.`,
  )

  expect(await failure(resume(ledger, home, terminals, id))).toContain(`nod resume n${id}`)
  expect(outcomes(id)).toEqual([
    ['start', 'error'],
    ['start', 'error'],
  ])

  const mark = restartMark(process.pid, id)
  expect(ledger.claimRestart(id, mark, null)).toBe(true)
  expect(await failure(resume(ledger, home, terminals, id))).toBe(
    `task n${id} has not started. ${mark}.`,
  )
  expect(outcomes(id)).toHaveLength(2)
})

test('a resume that takes over a cut-off start clears the worktree and branch it left, but keeps a branch with commits of its own', async () => {
  const { repo, id } = unfilledLib()
  await failure(startTask(ledger, home, terminals, id))
  const folder = workspaceOf(home, ledger.get(id))
  const cutOff = (): void => {
    expect(ledger.claimRestart(id, restartMark(gone(), id), null)).toBe(true)
  }
  const branch = (): string =>
    Bun.spawnSync(['git', 'branch', '--list', 'feat/lib'], { cwd: repo }).stdout.toString()

  // Cut off as it filled the submodules: the worktree and its branch are there.
  cutOff()
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/lib', folder)
  // So the start fails on what it failed on before, not on what the cut-off start left.
  expect(await failure(resume(ledger, home, terminals, id))).toStartWith('submodule lib')
  expect([existsSync(folder), branch()]).toEqual([false, ''])

  // Cut off as git made the worktree, which takes its folder away on a signal, but not the branch.
  cutOff()
  git(repo, 'branch', 'feat/lib')
  expect(await failure(resume(ledger, home, terminals, id))).toStartWith('submodule lib')
  expect(branch()).toBe('')

  // A branch by that name with a commit nothing else has is not the cut-off start's.
  cutOff()
  git(repo, 'checkout', '-q', '-b', 'feat/lib')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'mine')
  git(repo, 'checkout', '-q', '-')
  expect(await failure(resume(ledger, home, terminals, id))).toContain('already exists')
  expect(branch()).toBe('  feat/lib\n')

  // Nor one whose commit only a remote branch has: that may go unmerged (dropBranch in gc.ts).
  git(repo, 'update-ref', 'refs/remotes/origin/feat/lib', 'feat/lib')
  cutOff()
  expect(await failure(resume(ledger, home, terminals, id))).toContain('already exists')
  expect(branch()).toBe('  feat/lib\n')
}, 30_000)

test('a resume that takes over a cut-off start keeps a worktree at the task’s path that is not that start’s', async () => {
  const { repo, id } = unfilledLib()
  await failure(startTask(ledger, home, terminals, id))
  const folder = workspaceOf(home, ledger.get(id))
  const other = ledger.add({
    brief: 'another task',
    repo,
    branch: 'feat/other',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  // A worktree on the task's branch at its path, as a cut-off start leaves it, once `change` is done
  // to it; it stays, and the start fails on it.
  const keeps = async (change: () => void): Promise<void> => {
    expect(ledger.claimRestart(id, restartMark(gone(), id), null)).toBe(true)
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/lib', folder)
    change()
    expect(await failure(resume(ledger, home, terminals, id))).toContain('already exists')
    expect(existsSync(folder)).toBe(true)
    git(repo, 'worktree', 'remove', '--force', folder)
    git(repo, 'branch', '-D', 'feat/lib')
  }

  // Another task works there.
  await keeps(() => ledger.setRunning(other, folder))
  ledger.setRunning(other, join(home, 'elsewhere'))
  // Something in it is not committed, or is ignored.
  await keeps(() => writeFileSync(join(folder, 'wip.txt'), 'wip'))
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'secret.env\n')
  await keeps(() => writeFileSync(join(folder, 'secret.env'), 'TOKEN=example'))
  // A submodule in it has a commit only it holds.
  await keeps(() => {
    git(folder, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', 'lib')
    git(join(folder, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'mine')
  })
  // The branch has a commit nothing else has; the worktree's own HEAD does not count.
  await keeps(() => git(folder, 'commit', '-q', '--allow-empty', '-m', 'mine'))
})

test('a start resume took over drops the mark of the resume once the task has its folder', async () => {
  const id = await blocked()
  rmSync(workspaceOf(home, ledger.get(id)))
  expect(ledger.claimRestart(id, restartMark(gone(), id), null)).toBe(true)

  await startTask(ledger, home, terminals, id)

  const task = ledger.get(id)
  expect([task.workspace, task.error]).toEqual([workspaceOf(home, task), null])
})

test('resume starts a task that failed before it started again only once the tasks it comes after have succeeded', async () => {
  const before = ledger.add({
    brief: 'before',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  ledger.succeed(before)
  const id = await blocked([before])
  // A message sent the task it comes after back to work.
  ledger.setRunning(before, home)

  expect(await failure(resume(ledger, home, terminals, id))).toBe(
    `task n${id} has not started. It comes after n${before}, which must succeed before \`nod resume n${id}\` can start it again.`,
  )
  expect(outcomes(id)).toHaveLength(1)

  ledger.succeed(before)
  expect(await failure(resume(ledger, home, terminals, id))).toContain(`nod resume n${id}`)
  expect(outcomes(id)).toHaveLength(2)
})

test('a task that failed before it started starts again with resume, under the same number and branch, and keeps why it failed', async () => {
  const { repo, id } = unfilledLib('test -e lib/.git')
  await failure(startTask(ledger, home, terminals, id))

  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', 'lib')
  expect(await resume(ledger, home, terminals, id)).toBe('started')
  await reaches(id, 'succeeded')

  const task = ledger.get(id)
  expect([task.branch, task.workspace, task.error]).toEqual([
    'feat/lib',
    workspaceOf(home, task),
    null,
  ])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'error'],
    ['start', 'succeeded'],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual([
    expect.stringMatching(/^use the lib\n\nYour branch starts at commit [0-9a-f]{40}\./),
  ])
  const show = Bun.spawnSync(['bun', resolve(import.meta.dir, 'cli.ts'), 'show', String(id)], {
    env: { ...process.env, NOD_HOME: home },
  })
  expect(show.stdout.toString()).toContain(`submodule lib from ${repo} failed`)
}, 30_000)

test('a task resume started again goes on in the conversation of that start, not of the one that failed', async () => {
  const id = ledger.add({
    brief: 'first',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const folder = workspaceOf(home, ledger.get(id))
  writeFileSync(folder, '')
  await failure(startTask(ledger, home, terminals, id))
  rmSync(folder)

  // Its first turn never begins, so the turn after the answer starts it with its brief.
  writeFileSync(join(home, 'fake-exit'), '')
  expect(await resume(ledger, home, terminals, id)).toBe('started')
  const decision = await until(() => ledger.decisions(id)[0])
  await until(() => !terminals.alive(sessionName(id)))
  rmSync(join(home, 'fake-exit'))
  await answer(ledger, home, terminals, decision.id, 'go on', 'human')
  await reaches(id, 'succeeded')

  expect(entries('turn').map((t) => t.message)).toEqual([
    expect.stringMatching(/^first\n\nYour last turn was cut off.*\nHuman decision: go on$/s),
  ])
  const started = ledger.attempts(id)[1]?.sessionId ?? 'none'
  expect(new Set(entries('launch').map((l) => l.sessionId))).toEqual(new Set([started]))
}, 30_000)

test('a compacted conversation of a task resume started again hears the first message its worker got, not the start that failed', async () => {
  const id = ledger.add({
    brief: 'first',
    repo: null,
    branch: null,
    checkCmd: 'true',
    model: null,
    after: [],
    issue: null,
  })
  const folder = workspaceOf(home, ledger.get(id))
  writeFileSync(folder, '')
  await failure(startTask(ledger, home, terminals, id))
  rmSync(folder)
  expect(await resume(ledger, home, terminals, id)).toBe('started')
  await reaches(id, 'succeeded')

  const [got = ''] = entries('turn').map((t) => t.message ?? '')
  expect(got).toContain('acceptance check in this directory')
  const again = askedAgain(ledger, ledger.get(id))
  const quoted = got
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  expect(again).toContain(`Your first message:\n${quoted}\n\n`)
  expect(again).not.toContain('not sent')
  // The reviewer reads the brief itself, never a start's message.
  expect(reviewBrief(ledger, ledger.get(id), 'NOD: done | did it', null)).not.toContain('not sent')
}, 30_000)

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
      issue: null,
    })
  const trusted = addIn(newRepo())
  const refused = addIn(newRepo())
  await startTask(ledger, home, terminals, trusted)
  await startTask(ledger, home, terminals, refused)
  const [yes, no] = [trusted, refused].map((id) => ledger.decisions(id)[0])
  expect([yes?.reason, no?.reason]).toEqual(['trust', 'trust'])
  expect(entries('turn')).toEqual([])

  if (!yes || !no) throw new Error('no trust decision')
  await answer(ledger, home, terminals, yes.id, 'yes', 'human')
  await reaches(trusted, 'succeeded')
  expect(entries('turn').map((t) => t.message?.split('\n')[0])).toEqual(['work here'])

  await answer(ledger, home, terminals, no.id, 'not this one', 'human')
  expect(status(refused)).toBe('cancelled')
  expect(terminals.alive(sessionName(refused))).toBe(false)
}, 30_000)

test('a repo the person trusted for an earlier task is trusted again without a decision, as are its worktrees', async () => {
  // Every new session asks, as after the account changed.
  writeFileSync(join(home, 'fake-untrusted'), '')
  const addIn = (repo: string, branch: string): number =>
    ledger.add({
      brief: 'work here',
      repo,
      branch,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
  const [trusted, refused] = [newRepo(), newRepo()]
  const first = addIn(trusted, 'feat/first')
  const no = addIn(refused, 'feat/no')
  await startTask(ledger, home, terminals, first)
  await startTask(ledger, home, terminals, no)
  const [yes, dropped] = [first, no].map((id) => ledger.decisions(id)[0])
  if (yes === undefined || dropped === undefined) throw new Error('no trust decision')
  await answer(ledger, home, terminals, yes.id, 'yes', 'human')
  await reaches(first, 'succeeded')
  await answer(ledger, home, terminals, dropped.id, 'no', 'human')

  // The same repo, and a worktree of it outside nod's.
  const worktree = join(tmp.make('nod-worktree-'), 'wt')
  git(trusted, 'worktree', 'add', '-q', '-b', 'side', worktree)
  const again = [addIn(trusted, 'feat/again'), addIn(worktree, 'feat/tree')]
  for (const id of again) {
    await startTask(ledger, home, terminals, id)
    await reaches(id, 'succeeded')
    expect(ledger.decisions(id)).toEqual([])
    expect(ledger.allowed(id).map((n) => n.note)).toEqual([
      `trust ${ledger.get(id).repo}, as the person did in decision d${yes.id} (task n${first})`,
    ])
  }

  // A repo the person said no to, and one they never answered for.
  const asked = [addIn(refused, 'feat/no-again'), addIn(newRepo(), 'feat/new')]
  for (const id of asked) {
    await startTask(ledger, home, terminals, id)
    expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([['trust', null]])
    expect(ledger.allowed(id)).toEqual([])
  }
}, 30_000)

// A trust decision on a new task in `repo`, as awaitStart opens one.
function askTrust(repo: string): number {
  const id = ledger.add({
    brief: 'work here',
    repo,
    branch: 'feat/here',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const attemptId = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: crypto.randomUUID(),
    prompt: 'work here',
  })
  return ledger.ask(id, attemptId, 'trust', 'trust it?')
}

it("a repo's trust goes by the answer the person gave last, not the decision opened last", () => {
  const repo = newRepo()
  // Two tasks asked at once, as after the account changed, answered newer first.
  const [older, newer] = [askTrust(repo), askTrust(repo)]
  try {
    setSystemTime(new Date('2026-01-01T00:00:00Z'))
    ledger.answer(newer, 'yes')
    setSystemTime(new Date('2026-01-01T00:01:00Z'))
    ledger.drop(older)
  } finally {
    setSystemTime()
  }
  expect(trustedBy(ledger, repo)).toBeNull()
})

it('a yes for a task given a worktree counts for the repo it belongs to', () => {
  const repo = newRepo()
  const worktree = join(tmp.make('nod-worktree-'), 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree)
  const yes = askTrust(worktree)
  ledger.answer(yes, 'yes')
  expect(trustedBy(ledger, repo)?.id).toBe(yes)
})

it('a no for a worktree removed since counts as a no for its repo', () => {
  const repo = newRepo()
  const yes = askTrust(repo)
  ledger.answer(yes, 'yes')
  expect(trustedBy(ledger, repo)?.id).toBe(yes)
  const worktree = join(tmp.make('nod-worktree-'), 'wt')
  git(repo, 'worktree', 'add', '-q', '-b', 'side', worktree)
  ledger.drop(askTrust(worktree))
  git(repo, 'worktree', 'remove', worktree)
  expect(trustedBy(ledger, repo)).toBeNull()
})

test('an answer for a repo worker whose first start waits on trust goes with the brief, not into the trust dialog', async () => {
  writeFileSync(join(home, 'fake-untrusted'), '')
  const id = ledger.add({
    brief: 'work here',
    repo: newRepo(),
    branch: 'feat/wait',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['trust'])
  // Its terminal goes before anyone answers, as when the machine restarts.
  fake.killAll()
  expect(await lostTurns(ledger, home, terminals, new Date(Date.now() + 60_000))).toEqual([id])
  const cut = ledger.decisions(id).find((d) => d.reason === 'interrupted')
  if (cut === undefined) throw new Error('no interrupted decision')

  await answer(ledger, home, terminals, cut.id, 'go on', 'human')
  const trust = await until(() =>
    ledger.decisions(id).find((d) => d.reason === 'trust' && d.answer === null),
  )
  // Past the moment Claude Code counts as up, when a message waiting for it would be pasted.
  await Bun.sleep(6000)
  await answer(ledger, home, terminals, trust.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual([
    expect.stringMatching(
      /^work here\n\nYour branch starts at commit [0-9a-f]{40}\.\n\nYour last turn was cut off.*\nHuman decision: go on$/s,
    ),
  ])
}, 40_000)

test("tasks that start at once trust nod's work folder once, together", async () => {
  rmSync(trustedFile(home, process.env.CLAUDE_CONFIG_DIR ?? null))
  const ids = ['first', 'second'].map((brief) =>
    ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    }),
  )
  // As two nod adds at once start theirs.
  await Promise.all(ids.map((id) => startTask(ledger, home, terminals, id)))
  for (const id of ids) await reaches(id, 'succeeded')
  // The fake gives a session nod starts without an ID (the trust check's) the ID `missing`.
  expect(entries('launch').filter((l) => l.sessionId === 'missing')).toHaveLength(1)
})

test("Claude Code's default folder trusts nod's work folder for itself, whatever an older nod left", async () => {
  // An older nod's mark, for the account of the shell that started it, whichever that was.
  writeFileSync(join(home, 'work', '.trusted'), '')
  const current = join(home, 'account')
  writeFileSync(current, '') // no account: Claude Code's default folder
  setAccountRule(home, { file: current })
  const id = await add('first')
  await reaches(id, 'succeeded')
  // The fake gives a session nod starts without an ID (the trust check's) the ID `missing`.
  const checks = entries('launch').filter((l) => l.sessionId === 'missing')
  expect(checks.map((l) => l.config)).toEqual([null])
})

type Heard = {
  event: string
  task?: { id: number; brief?: string; issue?: string | null }
  error?: string
  by?: string
  reason?: string
  decision?: { answer: string }
}

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

test('notify hears every turn of a task', async () => {
  const events = listen()
  const done = await add('triage')
  const scheduled = await add('ask-first')

  await reaches(done, 'succeeded')
  await reaches(scheduled, 'needs_decision')
  const heard = (): [string, number | undefined][] => events().map((e) => [e.event, e.task?.id])
  await until(() => heard().length === 2)
  expect(heard()).toContainEqual(['succeeded', done])
  expect(heard()).toContainEqual(['decision', scheduled])

  // Answers and drops are heard too, so a to-do list that mirrors nod can close what is done.
  const asked = ledger.decisions(scheduled)[0]
  if (asked === undefined) throw new Error('no decision')
  await answer(ledger, home, terminals, asked.id, 'yes', 'human')
  await reaches(scheduled, 'succeeded')
  const dropped = await add('ask-first')
  const second = await until(() => ledger.decisions(dropped)[0])
  // Heard before the drop: closing its terminal ends the Stop hook that tells of it, with the hook.
  await until(() => heard().some(([event, id]) => event === 'decision' && id === dropped))
  await drop(ledger, home, terminals, second.id)
  await until(() => heard().length === 6)
  expect(heard()).toContainEqual(['answered', scheduled])
  expect(heard()).toContainEqual(['succeeded', scheduled])
  expect(heard()).toContainEqual(['cancelled', dropped])
})

// As listen, but the notify that hears `event` waits until `release`, and its hook with it.
function holdNotify(event: string): {
  heard: () => Heard[]
  holding: () => boolean
  release: () => void
} {
  const heard = listen()
  const fifo = join(home, 'hold')
  const held = join(home, 'held')
  if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0) throw new Error('mkfifo failed')
  // Open to read and write, so the release finds a reader whenever `held` is there.
  writeFileSync(
    join(home, 'notify'),
    `#!/bin/sh\nf=${JSON.stringify(join(home, 'events'))}/$$\ncat > "$f.tmp"\nif grep -q '"event":"${event}"' "$f.tmp"; then exec 3<> ${JSON.stringify(fifo)}; : > ${JSON.stringify(held)}; read _ <&3; fi\nmv "$f.tmp" "$f.json"\n`,
  )
  return {
    heard,
    holding: () => existsSync(held),
    // Fails at once (ENXIO) if the notify holding is gone.
    release: () => {
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
      writeSync(fd, '\n')
      closeSync(fd)
    },
  }
}

test("gc leaves the terminal of a task whose Stop hook still tells of its end, and takes it once that's done", async () => {
  const notify = holdNotify('succeeded')
  const id = await add('plain')
  await until(notify.holding)
  expect(status(id)).toBe('succeeded')
  expect(await collect(ledger, home, terminals, { ids: [id] })).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id, reason: 'its Stop hook is still running' }],
  })
  notify.release()
  await settled(id)
  expect(notify.heard().map((e) => [e.event, e.task?.id])).toEqual([['succeeded', id]])
  expect((await collect(ledger, home, terminals, { ids: [id] })).removed).toEqual([id])
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

  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
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
  ledger.setRule(1, 'off', 'human')
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
  expect(decision.reason).toBe('question')
  await drop(ledger, home, terminals, decision.id)
  const retro = retroTask(id)
  if (retro === undefined) throw new Error('no retrospective')

  const rule = await until(() => ledger.decisions(retro.id)[0])
  await answer(ledger, home, terminals, rule.id, 'not this one', 'human')
  expect(status(retro.id)).toBe('cancelled')
  expect(ledger.retroFor(id)?.outcome).toBe('declined')
  expect(ledger.rules()).toEqual([])
  expect(ledger.list().filter((t) => t.retroId !== null)).toHaveLength(1)
})

it('a retrospective that finds no general rule just succeeds', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
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
  await onStop(ledger, home, terminals, {
    session_id: 'retro-session',
    last_assistant_message: 'Nothing general here.\nNOD: done | none',
    stop_hook_active: false,
  })
  expect(status(retro)).toBe('succeeded')
  expect(ledger.decisions(retro)).toEqual([])
  expect(ledger.retroFor(of)).toMatchObject({ rule: null, outcome: 'none' })
  // Ended, it is not taken up again, which would write over what became of it.
  await expect(tell(ledger, home, terminals, retro, 'look again')).rejects.toThrow(
    'which ended (none)',
  )
})

it('yes to a rule closes its decision only as the rule goes in', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
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
  await onStop(ledger, home, terminals, {
    session_id: 'retro-session',
    last_assistant_message: 'NOD: done | keep it short',
    stop_hook_active: false,
  })
  const decision = ledger.decisions(retro)[0]
  if (decision === undefined) throw new Error('no rule decision')
  // A rule the ledger refuses, as the report of the turn the decision asks about: the decision
  // stays open, the task waits on it.
  const proposal = (rule: string): void => {
    ledger.db.run('update attempts set summary = ? where id = ?', [rule, decision.attemptId])
  }
  proposal('keep it\nshort')
  await expect(answer(ledger, home, terminals, decision.id, 'yes', 'human')).rejects.toThrow(
    'one line',
  )
  expect(ledger.decision(decision.id).answer).toBeNull()
  expect(ledger.rules()).toEqual([])
  expect(status(retro)).toBe('needs_decision')

  proposal('keep it short')
  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  expect(ledger.decision(decision.id).answer).toBe('yes')
  expect(ledger.rules().map((r) => r.text)).toEqual(['keep it short'])
  expect(status(retro)).toBe('succeeded')
})

it('a notify that cannot run changes nothing else', async () => {
  writeFileSync(join(home, 'notify'), '') // not executable
  const task = { id: 1, brief: 'x', issue: null }
  await expect(notify(home, { event: 'cancelled', task })).resolves.toBeUndefined()
})

it('a retrospective hears the repo and check of its task, that the check runs outside the sandbox, and where each kind of fix goes', () => {
  const task = (repo: string | null, checkCmd: string | null): Task =>
    ledger.get(
      ledger.add({
        brief: 'fix it',
        repo,
        branch: repo === null ? null : 'feat/fix',
        checkCmd,
        model: null,
        after: [],
        issue: null,
      }),
    )
  // Read as one line, so rewrapping the brief does not break the checks.
  const brief = (t: Task): string =>
    retroBrief(ledger, t, workerPrompt(ledger, null)).replaceAll('\n', ' ')
  const inRepo = brief(task('/repo', 'bun test'))
  expect(inRepo).toContain('Repository: /repo')
  expect(inRepo).toContain('Acceptance check: > bun test')
  // A brief in another language must not turn `none` into a rule nod would ask about.
  expect(inRepo).toContain('keep `none` in English')
  // A check on more than one line keeps its lines, each quoted as data.
  const twoLines = retroBrief(ledger, task('/repo', 'bun test\nbun run lint'), '')
  expect(twoLines).toContain('Acceptance check:\n> bun test\n> bun run lint\n')
  // A test the sandbox kept the worker from running still ran in the check.
  expect(inRepo).toContain("the acceptance check outside the worker's sandbox")
  expect(inRepo).toContain('every future worker, on every task')
  // It starts from what happened, not from advice that fits any task.
  expect(inRepo).toContain('First find the turn or decision where the trouble shows')
  // A fix for nod or the task's check goes to the person, not to every worker as a workaround.
  expect(inRepo).toContain('no rule that works around it')
  expect(inRepo).toContain("Put it in the person's inbox with one `NOD: in` line")
  const alone = brief(task(null, null))
  expect(alone).toContain('Repository: none')
  expect(alone).toContain('Acceptance check: none')
})

it('a retrospective that sends its fix to the inbox ends as todo, and one that also proposes a rule keeps the todo', async () => {
  const todos = new Todos(ledger)
  const inbox = (): string[] =>
    todos
      .list({
        statuses: ['inbox'],
        projectId: null,
        hideSomedayProjects: false,
        day: null,
      })
      .map((t) => t.title)
  // A retrospective of a new task, its turn open in `session`, stopping with `report`.
  const retroStops = async (session: string, report: string): Promise<[number, number]> => {
    const of = ledger.add({
      brief: 'x',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    const retro = ledger.addRetro(ledger.get(of), 'look back')
    ledger.startAttempt({
      taskId: retro,
      kind: 'start',
      decisionId: null,
      sessionId: session,
      prompt: 'look back',
    })
    await onStop(ledger, home, terminals, {
      session_id: session,
      last_assistant_message: report,
      stop_hook_active: false,
    })
    return [of, retro]
  }
  const [of, routed] = await retroStops(
    'routed',
    'nod lost the message.\nNOD: in {"title": "Fix nod"}\nNOD: done | none',
  )
  expect(status(routed)).toBe('succeeded')
  expect(ledger.decisions(routed)).toEqual([])
  expect(ledger.retroFor(of)).toMatchObject({ rule: null, outcome: 'todo' })
  expect(inbox()).toEqual(['Fix nod'])
  // While the person decides on the rule, the todo is already in.
  const [, both] = await retroStops(
    'both',
    'NOD: in {"title": "Add a check"}\nNOD: done | check first',
  )
  expect(ledger.decisions(both).map((d) => d.reason)).toEqual(['rule'])
  expect(inbox()).toEqual(['Fix nod', 'Add a check'])
})

it('readAtOnce reads AT_ONCE items at a time, no more, and gives what each read in their order', async () => {
  let reading = 0
  let most = 0
  const read = async (n: number): Promise<number> => {
    most = Math.max(most, ++reading)
    // Ends after the reads begun with it: the later ones end first.
    for (let i = n; i < 30; i++) await null
    reading--
    return n * 2
  }
  const items = Array.from({ length: 3 * AT_ONCE }, (_, i) => i)
  expect(await readAtOnce(items, read)).toEqual(items.map((n) => n * 2))
  expect(most).toBe(AT_ONCE)
  expect(await readAtOnce([], read)).toEqual([])

  // Item 3 fails after item 5: item 3's failure is the one told, as in turn, and once item 5 has
  // failed no more start.
  const started: number[] = []
  const failing = async (n: number): Promise<number> => {
    started.push(n)
    for (let i = n; i < 30; i++) await null
    if (n === 3 || n === 5) throw new Error(`item ${n}`)
    return n
  }
  await expect(readAtOnce(items, failing)).rejects.toThrow('item 3')
  expect(started.length).toBeLessThan(items.length)
})

it("a worker's Claude Code runs nod's tool hook after each tool, failing or not, so a dialog a person answered in its terminal closes", () => {
  const id = ledger.add({
    brief: 'Push it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const argv = claudeArgs(ledger, home, ledger.get(id), ['--session-id', 's'], null, null)
  const { hooks } = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    const commands = hooks[event]?.flatMap((m: { hooks: { command: string }[] }) => m.hooks)
    expect({ event, command: commands?.[0]?.command }).toEqual({
      event,
      command: expect.stringMatching(/ hook tool$/),
    })
  }
})

it("a worker's sandbox lets it keep Unix sockets in its own folder alone, which nod makes as it starts it and names in NOD_SOCKETS", () => {
  const id = ledger.add({
    brief: 'Run the tmux tests',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const argv = claudeArgs(ledger, home, ledger.get(id), ['--session-id', 's'], null, null)
  const { sandbox } = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}')
  const own = socketsDir(home, id)
  expect(sandbox.network.allowUnixSockets).toEqual([own])
  // Its tests make the folders they keep sockets in there, and nothing else in nod's home.
  expect(sandbox.filesystem.allowWrite).toEqual([own])
  expect(sandbox.network.allowedDomains).toEqual(['registry.npmjs.org'])
  expect(sandbox.network).not.toHaveProperty('allowAllUnixSockets')
  // Made before Claude Code starts, so its tests can make theirs in it.
  expect(statSync(own).isDirectory()).toBe(true)
  expect(workerEnv(home, id).NOD_SOCKETS).toBe(own)
  expect(workerEnv(home, null)).not.toHaveProperty('NOD_SOCKETS')

  // In nod's home, not another worker's, nor any socket a worker must not reach: other sessions'
  // inboxes, nod's tmux server, the SSH agent, nor the temp folders that hold them. Shown for a
  // home outside the temp folder, where nod's own is.
  expect(socketsDir('/h', 5)).toBe('/h/sockets/5')
  const uid = process.getuid?.()
  const kept = [
    socketsDir('/h', 6),
    '/tmp',
    '/private/tmp',
    '/tmp/cc-socks',
    `/tmp/cc-socks-${uid}`,
    `/private/tmp/tmux-${uid}`,
    process.env.SSH_AUTH_SOCK ?? '/var/run/agent',
  ]
  for (const path of kept) {
    const folder = socketsDir('/h', 5)
    expect(folder === path || folder.startsWith(`${path}/`) || path.startsWith(`${folder}/`)).toBe(
      false,
    )
  }
})

// Runs `body` with no CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in nod's environment, whatever the shell
// running the tests has.
async function withoutAutocompact(body: () => unknown): Promise<void> {
  const ambient = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  try {
    await body()
  } finally {
    if (ambient === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = ambient
  }
}

test(
  "the worker's Claude Code compacts early as it starts, and as it starts again",
  () =>
    withoutAutocompact(async () => {
      const id = await add('first')
      await reaches(id, 'succeeded')
      await settled(id)
      endClaude(id) // a crash, a person's /exit: keepWorker starts it again
      await until(() => entries('launch').length === 2)
      expect(entries('launch').map((l) => [l.resumed, l.autocompact])).toEqual([
        [false, '60'],
        [true, '60'],
      ])
    }),
  30_000,
)

test("once Claude Code has compacted a worker's conversation, the hook gives back what it was asked, word for word; no other start does", () => {
  const id = ledger.add({
    brief: 'write it\nin full',
    repo: null,
    branch: null,
    checkCmd: 'true',
    model: null,
    after: [],
    issue: null,
  })
  const turn = (kind: 'start' | 'followup', prompt: string): number =>
    ledger.startAttempt({ taskId: id, kind, decisionId: null, sessionId: 's', prompt })
  const first = turn('start', firstMessage(ledger, ledger.get(id), null))
  ledger.endAttempt(first, { outcome: 'needs_decision', summary: 'which file?', report: null })
  const second = turn('followup', 'in a.txt')
  ledger.addMessage(id, second, 'use tabs')
  const words = onCompact(ledger, { session_id: 's', source: 'compact' })
  // The first message whole, with the check nod told it of, and the human's later words.
  expect(words).toContain('> write it\n> in full\n')
  expect(words).toContain('acceptance check in this directory and sends any failure back: `true`')
  expect(words).toContain('later words win:\n- in a.txt\n- use tabs')
  for (const source of ['startup', 'resume', 'clear']) {
    expect(onCompact(ledger, { session_id: 's', source })).toBeNull()
  }
  expect(onCompact(ledger, { session_id: 'none', source: 'compact' })).toBeNull()
})

test('Claude Code runs that hook in a worker once it has compacted the conversation, and at no other start', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await tell(ledger, home, terminals, id, 'compact first, then use tabs')
  await reaches(id, 'succeeded')
  const words = askedAgain(ledger, ledger.get(id))
  fake.kill(sessionName(id))
  await tell(ledger, home, terminals, id, 'third')
  await reaches(id, 'succeeded')
  expect(entries('session-start').map((s) => [s.source, s.context])).toEqual([
    ['startup', ''],
    ['compact', `${words}\n`],
    ['resume', ''],
  ])
  expect(words).toContain('- compact first, then use tabs')
}, 30_000)

tmuxTest("a worker's terminal passes on none of the tmux server's environment", async () => {
  useTmux()
  // As a terminal marks its panes; the home's tmux server starts with it.
  process.env.NOD_TEST_PANE_ID = 'outer'
  try {
    const id = await add('first')
    await reaches(id, 'succeeded')
  } finally {
    delete process.env.NOD_TEST_PANE_ID
  }
  // A child gets process.env as it was set at run time (TMUX_TMPDIR) only when given it.
  const server = terminals.attachCommand('x').slice(0, 3)
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
  const claude = Number(terminals.option(sessionName(id), 'nod_claude'))
  // Not 0, which would signal this test run's whole process group.
  if (!(claude > 0)) throw new Error(`task ${id} has no Claude Code running`)
  process.kill(claude, 'SIGTERM')
}

test('whatever ends its Claude Code, a worker starts again in the same terminal and conversation, without the brief', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  const name = sessionName(id)
  const pane = terminals.pane(name)
  endClaude(id)
  await until(() => entries('launch')[1])
  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.resumed, l.prompt])).toEqual([
    [session, false, 'first'],
    [session, true, null],
  ])
  expect(terminals.pane(name)).toBe(pane)

  await tell(ledger, home, terminals, id, 'second')
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

  await answer(ledger, home, terminals, decision.id, 'check and carry on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch').map((l) => l.resumed)).toEqual([false, true])
  expect(entries('turn').map((t) => t.message)).toEqual([
    'hang until ended',
    expect.stringMatching(/^Your last turn was cut off.*\nHuman decision: check and carry on$/s),
  ])
}, 30_000)

test('a worker in a folder whose path Claude Code changes more of for its transcripts goes on in its conversation', async () => {
  useHome('nod_worker-') // Claude Code names the transcripts' folder with `_` turned into `-`
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  endClaude(id)
  // Six seconds of it are fixed, with no knob to shorten them: the Claude Code ended before it was
  // up starts again a second later (RELAUNCH_DELAY_MS in worker.ts), and the turn becomes a decision
  // once that one is up, five seconds after (QUICK_EXIT_MS). Where other work runs, the ten seconds
  // other waits here get once ran out.
  const decision = await until(() => ledger.decisions(id)[0], 20_000)
  expect(decision.question).toContain('ended in the middle of a turn')
  expect(entries('launch').map((l) => l.resumed)).toEqual([false, true])
}, 40_000)

test('a message that comes before a first turn that never began goes in after the brief', async () => {
  writeFileSync(join(home, 'fake-exit'), '')
  const id = await add('first')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.question).toContain('exited 3 times as it started')
  await until(() => !terminals.alive(sessionName(id)))

  rmSync(join(home, 'fake-exit'))
  await answer(ledger, home, terminals, decision.id, 'go on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual([
    expect.stringMatching(/^first\n\nYour last turn was cut off.*\nHuman decision: go on$/s),
  ])
}, 30_000)

test('a Claude Code that keeps exiting as it starts is not started again: the person hears why, and the next message starts it', async () => {
  const events = listen()
  const id = await add('first')
  await reaches(id, 'succeeded')
  writeFileSync(join(home, 'fake-exit'), '')
  endClaude(id)
  await until(() => !terminals.alive(sessionName(id)))
  const error = events().find((e) => e.event === 'error')
  expect(error?.error).toContain('exited 3 times as it started')
  expect(error?.error).toContain('Not logged in')
  // Between turns there was nothing to decide.
  expect(status(id)).toBe('succeeded')

  rmSync(join(home, 'fake-exit'))
  await tell(ledger, home, terminals, id, 'again')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'again'])
}, 30_000)

test('with an account rule, a worker starts again as the current account: at once between turns, after a turn in progress, and with the message that finds it on the old one', async () => {
  const current = join(home, 'account')
  const [a, b, c, d] = accounts('a', 'b', 'c', 'd')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  expect(ledger.get(id).account).toBe(a ?? '')

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  await until(() => entries('launch')[1])

  await tell(ledger, home, terminals, id, 'need-permission')
  const permission = await until(() => ledger.decisions(id)[0])
  writeFileSync(current, `${c}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([]) // in the middle of a turn
  await answer(ledger, home, terminals, permission.id, 'yes', 'human')
  await until(() => entries('launch')[2])
  // Up as c: a message from now on finds it on an old account, not starting again.
  await until(() => terminals.option(sessionName(id), 'nod_restarting') === '')

  writeFileSync(current, `${d}\n`)
  await tell(ledger, home, terminals, id, 'go on')
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
}, 60_000)

test('a turn a usage limit ended does not hold up a restart: the new account continues it', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('stall at the limit')
  await until(() => terminals.option(sessionName(id), 'nod_stalled') === 'rate_limit')
  expect(await restartDue(ledger, home, terminals)).toEqual([]) // the account is the same: Claude Code waits

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  await reaches(id, 'succeeded')
  const session = ledger.attempts(id)[0]?.sessionId
  expect(entries('launch').map((l) => [l.sessionId, l.config])).toEqual([
    [session, a],
    [session, b],
  ])
  expect(entries('launch')[1]?.prompt).toContain('API error (rate_limit)')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', 'succeeded']])
}, 30_000)

test('a turn an API error Claude Code does not go on from ended is a decision the project session hears, and the answer goes on in the same conversation', async () => {
  const id = await add('stall on server_error')
  const decision = await until(() => ledger.decisions(id)[0])
  expect(decision.reason).toBe('interrupted')
  expect(decision.question).toContain('API error (server_error)')
  expect(decision.question).toContain('API Error: server_error')
  expect(decision.question).toContain('> stall on server_error')
  expect(status(id)).toBe('needs_decision')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', 'error']])
  // What reaches the project session (sendNotices in inbox.ts).
  const notices = ledger.db
    .query<{ event: string; decision_id: number | null }, [number]>(
      'select event, decision_id from notices where task_id = ?',
    )
    .all(id)
  expect(notices).toEqual([{ event: 'decision', decision_id: decision.id }])

  await answer(ledger, home, terminals, decision.id, 'check and carry on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch')).toHaveLength(1) // the same Claude Code went on
  expect(entries('turn').map((t) => t.message)).toEqual([
    'stall on server_error',
    expect.stringMatching(/^Your last turn was cut off.*\nHuman decision: check and carry on$/s),
  ])
}, 30_000)

test('a turn an API error ended goes on as the account a restart waited for, with no decision', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('stall on authentication_failed once ended')
  await until(() => entries('turn')[0])
  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([]) // its turn runs: the restart waits
  writeFileSync(join(ledger.get(id).workspace ?? '', 'end.txt'), '')
  await reaches(id, 'succeeded')
  expect(ledger.decisions(id)).toEqual([])
  expect(entries('launch').map((l) => l.config)).toEqual([a, b])
  expect(entries('launch')[1]?.prompt).toContain('API error (authentication_failed)')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', 'succeeded']])
}, 30_000)

test('the decision an API error raised stays with the person when the account changes after it', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('stall on server_error')
  const decision = await until(() => ledger.decisions(id)[0])
  // The hook's last step, after the decision: the mark that a restart would continue past it on.
  await until(() => terminals.option(sessionName(id), 'nod_stalled') === '')

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id]) // a worker between turns
  // Up once the new Claude Code has lasted five seconds (QUICK_EXIT_MS in worker.ts).
  await until(() => terminals.option(sessionName(id), 'nod_restarting') === '', 20_000)
  expect(entries('launch').map((l) => [l.config, l.prompt])).toEqual([
    [a, 'stall on server_error'],
    [b, null],
  ])
  expect(ledger.decision(decision.id).answer).toBeNull()
  expect(status(id)).toBe('needs_decision')
}, 40_000)

test('an API error raises no decision once no turn is open, or while Claude Code starts again', async () => {
  const done = await add('first')
  await reaches(done, 'succeeded')
  await settled(done)
  const finished = ledger.attempts(done)[0]?.sessionId ?? ''
  await onStopFailure(ledger, home, terminals, { session_id: finished, error: 'server_error' })
  expect(ledger.decisions(done)).toEqual([])
  expect(ledger.attempts(done)).toHaveLength(1)
  expect(status(done)).toBe('succeeded')

  // Another process's restart is under way: the new start goes on with the turn (keepWorker).
  const id = await add('hang here')
  await until(() => entries('turn')[1])
  terminals.setOption(sessionName(id), 'nod_restarting', '1')
  const session = ledger.attempts(id)[0]?.sessionId ?? ''
  await onStopFailure(ledger, home, terminals, { session_id: session, error: 'server_error' })
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.openAttempt(id)?.kind).toBe('start')
}, 30_000)

test('a restart waits while nod checks a turn it has closed, and comes once', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('review-slow')
  await until(() => entries('review')[0])
  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([]) // its review would end with Claude Code
  await reaches(id, 'succeeded')
  await until(() => entries('launch')[1])
  expect(await restartDue(ledger, home, terminals)).toEqual([])
  expect(entries('launch').map((l) => l.config)).toEqual([a, b])
}, 30_000)

test('a message sent while a worker starts again on request waits for the new start', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)

  expect(await restart(ledger, home, terminals, id, 'asked')).toBe('restarted')
  await tell(ledger, home, terminals, id, 'go on') // the old Claude Code has not ended yet
  await reaches(id, 'succeeded')
  await until(() => entries('turn')[1])
  expect(entries('launch').map((l) => l.prompt)).toEqual(['first', 'go on'])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'go on'])
}, 30_000)

test('a worker starting again as another account is not restarted twice, and a message waits for it', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  expect(await restartDue(ledger, home, terminals)).toEqual([]) // already starting again
  await tell(ledger, home, terminals, id, 'go on') // the old Claude Code has not ended yet
  await reaches(id, 'succeeded')
  await until(() => entries('turn')[1])
  expect(entries('launch').map((l) => [l.config, l.prompt])).toEqual([
    [a, 'first'],
    [b, 'go on'],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'go on'])
}, 30_000)

test('a repo worker started again as another account says yes to trusting the repo again, and stays as it was', async () => {
  const current = join(home, 'account')
  const [a, b] = accounts('a', 'b')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = ledger.add({
    brief: 'first',
    repo: newRepo(),
    branch: 'feat/again',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  await reaches(id, 'succeeded')
  await settled(id)

  writeFileSync(join(home, 'fake-untrusted-again'), '')
  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  await until(() => entries('launch')[1])
  await until(() => terminals.option(sessionName(id), 'nod_restarting') === '')
  expect(ledger.decisions(id)).toEqual([])
  expect(status(id)).toBe('succeeded')
  await tell(ledger, home, terminals, id, 'go on')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message?.split('\n')[0])).toEqual(['first', 'go on'])
}, 30_000)

test('a conversation kept only in the folder of the old account is not started over in the new one', async () => {
  const events = listen()
  const current = join(home, 'account')
  const [a, b] = ['a', 'b'].map((x) => tmp.make(`nod-account-${x}-`))
  for (const x of [a, b]) trust(x ?? null)
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)

  writeFileSync(current, `${b}\n`)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  await until(() => !terminals.alive(sessionName(id)))
  expect(entries('launch')).toHaveLength(1)
  expect(events().some((e) => e.error?.includes('must share their projects/ folder'))).toBe(true)
}, 30_000)

test('an answer the account rule cannot be read for leaves its task in error, to tell again', async () => {
  const current = join(home, 'account')
  const [a] = accounts('a')
  setAccountRule(home, { file: current })
  writeFileSync(current, `${a}\n`)
  const id = await add('ask-first')
  const decision = await until(() => ledger.decisions(id)[0])
  await settled(id)

  rmSync(current)
  await expect(answer(ledger, home, terminals, decision.id, 'yes', 'human')).rejects.toThrow(
    'ENOENT',
  )
  expect(ledger.decision(decision.id).answer).toBe('yes')
  expect(ledger.get(id)).toMatchObject({
    status: 'error',
    error: expect.stringContaining('ENOENT'),
  })
  expect(ledger.attempts(id)).toHaveLength(1)

  writeFileSync(current, `${a}\n`)
  await tell(ledger, home, terminals, id, 'yes')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['ask-first', 'yes'])
}, 30_000)

test('a restart waits for a person attached to the worker, who hears why once', async () => {
  const events = listen()
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  const name = sessionName(id)
  fake.attach(name)
  expect(await restart(ledger, home, terminals, id, 'nod restart')).toBe('attached')
  expect(await restartDue(ledger, home, terminals)).toEqual([])
  expect(events().filter((e) => e.event === 'restart_held')).toEqual([
    expect.objectContaining({ reason: 'nod restart' }),
  ])

  fake.detach(name)
  expect(await restartDue(ledger, home, terminals)).toEqual([id])
  await until(() => entries('launch')[1])
}, 30_000)

test('a turn whose terminal went (the machine or tmux restarted) becomes a decision, and the answer reopens its conversation', async () => {
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  fake.killAll()
  // A turn just started may still be opening its terminal.
  expect(await lostTurns(ledger, home, terminals, new Date())).toEqual([])
  const later = new Date(Date.now() + 60_000)
  expect(await lostTurns(ledger, home, terminals, later)).toEqual([id])
  expect(await lostTurns(ledger, home, terminals, later)).toEqual([])
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  expect(decision.reason).toBe('interrupted')
  expect(decision.question).toContain('Its terminal went in the middle of a turn')

  await answer(ledger, home, terminals, decision.id, 'carry on', 'human')
  await reaches(id, 'succeeded')
  expect(entries('launch').map((l) => l.resumed)).toEqual([false, true])
  expect(entries('turn').at(-1)?.message).toContain('Human decision: carry on')
}, 30_000)

// A finished task whose terminal was closed, and whose next `breaks` terminals run a nod that is not
// there, as the UI server's build did (its src/cli.ts beside the bundle): each ends at once.
async function closedWithBrokenStarts(
  breaks: number,
): Promise<{ id: number; starts: () => number }> {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  await terminals.close(sessionName(id))
  const start = fake.start.bind(fake)
  let left = breaks
  const spy = spyOn(fake, 'start').mockImplementation((name, cwd, argv, env) => {
    const nod = left-- > 0 ? [argv[0] ?? '', join(home, 'cli.ts'), ...argv.slice(2)] : argv
    start(name, cwd, nod, env)
  })
  return { id, starts: () => spy.mock.calls.length }
}

test('a turn whose terminal ended before Claude Code took its message goes on with it in a terminal opened again, not as a decision', async () => {
  const { id, starts } = await closedWithBrokenStarts(1)
  await tell(ledger, home, terminals, id, 'go on', null)
  await until(() => !terminals.alive(sessionName(id)))

  expect(await lostTurns(ledger, home, terminals, new Date(Date.now() + 60_000))).toEqual([])
  await reaches(id, 'succeeded')
  expect(starts()).toBe(2)
  expect(ledger.decisions(id).filter((d) => d.reason === 'interrupted')).toEqual([])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'succeeded'],
    ['followup', 'succeeded'],
  ])
  expect(entries('launch').map((l) => [l.resumed, l.prompt])).toEqual([
    [false, expect.stringContaining('first')],
    [true, 'go on'],
  ])
}, 30_000)

test('a terminal that keeps ending before Claude Code takes the message opens again until it ended as often as a Claude Code that exits as it starts, then the message goes with the answer', async () => {
  // MAX_QUICK_EXITS (3) terminals in a row: the tell's and two opened again.
  const { id, starts } = await closedWithBrokenStarts(3)
  await tell(ledger, home, terminals, id, 'go on', null)
  const later = new Date(Date.now() + 60_000)
  for (let opened = 1; opened <= 2; opened++) {
    await until(() => !terminals.alive(sessionName(id)))
    expect(await lostTurns(ledger, home, terminals, later)).toEqual([])
    expect(starts()).toBe(1 + opened)
  }
  await until(() => !terminals.alive(sessionName(id)))
  expect(await lostTurns(ledger, home, terminals, later)).toEqual([id])
  expect(starts()).toBe(3)
  const decision = ledger.decisions(id).find((d) => d.reason === 'interrupted')
  if (decision === undefined) throw new Error('no interrupted decision')
  expect(decision.question).toContain('before Claude Code took the message, 3 times in a row')
  expect(decision.question).toContain('Nothing of the turn is done. It was on:\n> go on')
  expect(decision.question).not.toContain('part of it may be done')

  // Fixed, nod runs again: the message that never went in goes, ahead of the answer.
  await answer(ledger, home, terminals, decision.id, 'carry on', 'human')
  await reaches(id, 'succeeded')
  const said = entries('turn').at(-1)?.message ?? ''
  expect(said.startsWith('go on\n\n')).toBe(true)
  expect(said).toContain('Human decision: carry on')
}, 30_000)

test('a lost turn that took its message is a decision, though a message left since has its words inside', async () => {
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  fake.killAll()
  // A later message waiting for the next start, which holds the turn's words but is not them.
  const words = ledger.openAttempt(id)?.prompt ?? ''
  writeFileSync(join(home, 'work', `.prompt-${id}`), `before ${words} after`)
  expect(await lostTurns(ledger, home, terminals, new Date(Date.now() + 60_000))).toEqual([id])
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['interrupted'])
}, 30_000)

// A todo the person delegated to a task (`nod add --todo`), which has not started yet.
function delegated(
  todos: Todos,
  title: string,
  brief: string,
  after: number[] = [],
): { todo: number; task: number } {
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
      issue: null,
    },
    'human',
  )
  return { todo, task }
}

test("a delegated todo waits through its task's decision, is done when it succeeds, and comes back when dropped", async () => {
  const todos = new Todos(ledger)
  const asked = delegated(todos, 'Ask first', 'ask-first, then write ok.txt')
  await startTask(ledger, home, terminals, asked.task)
  const question = await until(() => ledger.decisions(asked.task)[0])
  expect(todos.get(asked.todo).status).toBe('waiting')
  expect(todos.decisions().map((d) => d.todo?.id)).toEqual([asked.todo])
  await answer(ledger, home, terminals, question.id, 'yes', 'human')
  await until(() => todos.get(asked.todo).status === 'done')
  expect(todos.changes(asked.todo).at(-1)).toMatchObject({
    actor: 'nod',
    change: { status: ['waiting', 'done'] },
  })
  expect(todos.tasks(asked.todo).map((x) => x.summary)).toEqual(['did it'])

  // Dropping a task gives its todo back, and the todo of the task that waited on it too.
  const gaveUp = delegated(todos, 'Give up', 'give-up')
  const after = delegated(todos, 'Then this', 'after it', [gaveUp.task])
  await startTask(ledger, home, terminals, gaveUp.task)
  const failed = await until(() => ledger.decisions(gaveUp.task)[0])
  await drop(ledger, home, terminals, failed.id)
  expect(status(after.task)).toBe('cancelled')
  expect([todos.get(gaveUp.todo).status, todos.get(after.todo).status]).toEqual(['next', 'next'])
})

test('nod captures the todos a worker reports once its done is accepted, and sends a bad line back', async () => {
  const todos = new Todos(ledger)
  const inbox = () =>
    todos
      .list({
        statuses: ['inbox'],
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

it('background work the Stop hook cannot read still counts, or counts as none, and never fails the hook', () => {
  const stop = {
    session_id: 's',
    last_assistant_message: 'NOD: question | ?',
    stop_hook_active: false,
  }
  const work = (background_tasks: unknown) => StopEvent.parse({ ...stop, background_tasks })
  expect(work([{ type: 'shell', description: null }, 7]).background_tasks).toHaveLength(2)
  expect(work(null).background_tasks).toBeUndefined()
  expect(work('none').background_tasks).toBeUndefined()
  expect(StopEvent.parse(stop).background_tasks).toBeUndefined()
})

// A task nod started whose hooks a test runs itself, with no terminal: its worker's first turn is
// session `session`. `root`: the Claude session that added it. `add`: how it was added.
function started(
  brief: string,
  session: string,
  root: string | null = null,
  add: (task: NewTask) => number = (task) => ledger.add(task),
): number {
  const id = add({
    brief,
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
    rootSession: root,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(id, cwd)
  ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: session,
    prompt: brief,
  })
  return id
}

// The Stop hook of a turn in session `session` that ended with `report`, while the background work
// `running` (agents, as Claude Code describes them) still ran.
const stopped = (session: string, report: string, running: string[] = []): Promise<string | null> =>
  onStop(ledger, home, terminals, {
    session_id: session,
    last_assistant_message: report,
    stop_hook_active: false,
    background_tasks: running.map((description) => ({ type: 'subagent', description })),
  })

it('a message that comes while nod checks a turn it closed starts the next turn, and that turn decides', async () => {
  // As `nod tell` opens a turn while the Stop hook checks the last one (deliver); Claude Code runs it
  // once the hook ends.
  const tellWhileChecked = async (id: number, session: string): Promise<void> => {
    await until(() => entries('review').some((r) => r.message?.includes(`nod task n${id}.`)))
    ledger.startAttempt({
      taskId: id,
      kind: 'followup',
      decisionId: null,
      sessionId: session,
      prompt: 'also this',
    })
  }
  const passing = started('review-slow: write it', 'checked-pass')
  const failing = started('review-slow review-strict: write it', 'checked-fail')
  const [pass, fail] = await Promise.all([
    stopped('checked-pass', 'NOD: done | did it'),
    stopped('checked-fail', 'NOD: done | did it'),
    tellWhileChecked(passing, 'checked-pass'),
    tellWhileChecked(failing, 'checked-fail'),
  ])
  // Neither a success nor a retry while that turn runs: its own stop is checked next.
  expect([pass, fail]).toEqual([null, null])
  expect([status(passing), status(failing)]).toEqual(['running', 'running'])
  const turns = (id: number) => ledger.attempts(id).map((a) => [a.kind, a.outcome, a.checkResult])
  expect(turns(passing)).toEqual([
    ['start', 'succeeded', 'passed'],
    ['followup', null, null],
  ])
  expect(turns(failing)).toEqual([
    ['start', 'succeeded', 'failed'],
    ['followup', null, null],
  ])
}, 30_000)

// The terminal of task `id` as tmux keeps it while its Claude Code runs, for a test with no tmux
// server: its options, and what is pasted into it.
function upTerminal(id: number): {
  options: Map<string, string>
  pasted: string[]
  restore: () => void
} {
  const options = new Map<string, string>()
  const pasted: string[] = []
  const name = sessionName(id)
  const spies = [
    spyOn(terminals, 'alive').mockImplementation((n) => n === name),
    spyOn(terminals, 'sessions').mockImplementation(() => new Set([name])),
    spyOn(terminals, 'attached').mockImplementation(() => false),
    spyOn(terminals, 'option').mockImplementation((_, key) => options.get(key) ?? ''),
    spyOn(terminals, 'setOption').mockImplementation((_, key, value) => {
      if (value === null) options.delete(key)
      else options.set(key, value)
    }),
    spyOn(terminals, 'screen').mockImplementation(() => ''),
    // Its Claude Code takes what is pasted, as the prompt hook marks it (listen).
    spyOn(terminals, 'send').mockImplementation((_, text) => {
      pasted.push(text)
      options.set(PROMPTED_OPTION, promptMark(text))
    }),
  ]
  const restore = (): void => {
    for (const s of spies) s.mockRestore()
  }
  return { options, pasted, restore }
}

// As Claude Code leaves a Stop hook it cut off at its time limit (one a sleep ran out, say) once the
// hook had closed the last turn of task `id`: the hook's pid and that turn still marked (onStop),
// the pid gone.
function cutHook(id: number, terminal: { options: Map<string, string> }): void {
  const turn = ledger.lastAttempt(id)
  if (turn === null) throw new Error(`task ${id} has no turn`)
  ledger.endAttempt(turn.id, {
    outcome: 'succeeded',
    summary: 'did it',
    report: 'NOD: done | did it',
  })
  terminal.options.set('nod_settling', `${Bun.spawnSync(['true']).pid} ${turn.id}`)
}

it('a turn whose Stop hook was cut off once it had closed it goes on: the tick has the worker report it again, and that stop checks it', async () => {
  const id = started('write it', 'cut-once')
  const terminal = upTerminal(id)
  try {
    cutHook(id, terminal)
    await tick(ledger, home, terminals, new Date(), false)
    expect(terminal.pasted).toEqual([expect.stringContaining('report again as you did')])
    expect(terminal.options.has('nod_settling')).toBe(false)
    expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.checkResult])).toEqual([
      ['start', 'succeeded', 'failed'],
      ['resume', null, null],
    ])
    // A later tick finds that turn running, and asks nothing more of it.
    await tick(ledger, home, terminals, new Date(), false)
    expect(terminal.pasted).toHaveLength(1)
    expect(await stopped('cut-once', 'NOD: done | did it')).toBeNull()
  } finally {
    terminal.restore()
  }
  expect(status(id)).toBe('succeeded')
}, 30_000)

it('the mark of a Stop hook gone goes whatever became of its turn, and a turn it raised a decision on is not reported again', async () => {
  const id = started('ask-first', 'cut-asked')
  const terminal = upTerminal(id)
  try {
    expect(await stopped('cut-asked', 'Should I?\nNOD: question | May I?')).toBeNull()
    const turn = ledger.lastAttempt(id)?.id
    // Cut off past its decision (its notify, say): the task waits on that decision.
    const gone = (): string => `${Bun.spawnSync(['true']).pid} ${turn}`
    terminal.options.set('nod_settling', gone())
    await tick(ledger, home, terminals, new Date(), false)
    expect(terminal.options.has('nod_settling')).toBe(false)
    // As an answer sets it running before it goes to the worker (answer).
    ledger.setRunning(id, ledger.get(id).workspace ?? '')
    terminal.options.set('nod_settling', gone())
    await tick(ledger, home, terminals, new Date(), false)
  } finally {
    terminal.restore()
  }
  expect(terminal.pasted).toEqual([])
  expect(terminal.options.has('nod_settling')).toBe(false)
}, 30_000)

it('a turn nod has its worker report again leaves the retries of its checks as they were', async () => {
  const id = started('review-strict: write it', 'cut-retries')
  const terminal = upTerminal(id)
  let last: string | null
  try {
    // The review fails: the first retry, whose check is then cut off.
    expect(await stopped('cut-retries', 'NOD: done | did it')).not.toBeNull()
    cutHook(id, terminal)
    await tick(ledger, home, terminals, new Date(), false)
    expect(await stopped('cut-retries', 'NOD: done | did it')).not.toBeNull()
    last = await stopped('cut-retries', 'NOD: done | did it')
  } finally {
    terminal.restore()
  }
  // Two retries in all, so the person decides.
  expect(last).toBeNull()
  expect(ledger.decisions(id).find((d) => d.answer === null)?.reason).toBe('check_failed')
}, 30_000)

it('a check cut off again, in the turn its worker reported again, goes to the person', async () => {
  const events = listen()
  const id = started('write it', 'cut-twice')
  const terminal = upTerminal(id)
  try {
    cutHook(id, terminal)
    await tick(ledger, home, terminals, new Date(), false)
    cutHook(id, terminal)
    await tick(ledger, home, terminals, new Date(), false)
  } finally {
    terminal.restore()
  }
  expect(terminal.pasted).toHaveLength(1)
  expect(ledger.get(id)).toMatchObject({
    status: 'error',
    error: expect.stringContaining('the second time'),
  })
  expect(events().find((e) => e.event === 'error')?.error).toContain('nod tell goes on')
}, 30_000)

it('a message its worker had not taken in by the end of the turn it was told in goes on as the next turn, which decides; one it took in stays', async () => {
  const config = tmp.make('nod-transcripts-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  const transcript = (session: string): string =>
    join(config, 'projects', 'work', `${session}.jsonl`)
  const keep = (session: string, entries: object[]): void =>
    appendFileSync(transcript(session), entries.map((e) => `${JSON.stringify(e)}\n`).join(''))
  // A task told `said` (each with the task that sent it) in its turn in session `session`, whose
  // transcript then holds `kept`, as Claude Code 2.1.310 keeps it.
  const told = (session: string, said: [string, number | null][], kept: object[]): number => {
    const id = started(`write it, ${session}`, session)
    ledger.setAccount(id, config)
    const turn = ledger.openAttempt(id)?.id ?? 0
    for (const [text, from] of said) ledger.addMessage(id, turn, text, from)
    keep(session, [{ type: 'user', message: { role: 'user', content: `write it, ${session}` } }])
    keep(session, kept)
    return id
  }
  const queue = (operation: string, content: string) => ({
    type: 'queue-operation',
    operation,
    content,
  })
  // How Claude Code keeps a message of several lines.
  const wrapped = (text: string): string =>
    `<pasted_content id="a1b2">\n${text}\n</pasted_content id="a1b2">`
  const tabs = 'use tabs,\nnot spaces'
  const peer = started('a peer', 'peer')

  // Still queued as the worker wrote its last answer, a peer's message after it.
  const late = told(
    'late',
    [
      [tabs, null],
      ['peer note', peer],
    ],
    [queue('enqueue', wrapped(tabs)), queue('enqueue', 'peer note')],
  )
  // Taken in at a tool call; in the first message of a start, from the prompt file.
  const heard = told(
    'heard',
    [[tabs, null]],
    [
      queue('enqueue', wrapped(tabs)),
      queue('remove', wrapped(tabs)),
      { type: 'attachment', attachment: { type: 'queued_command', prompt: wrapped(tabs) } },
    ],
  )
  const restarted = told(
    'restarted',
    [['go on', null]],
    [{ type: 'user', message: { role: 'user', content: 'earlier\n\ngo on' } }],
  )
  // Never in Claude Code's queue.
  const lost = told('lost', [['go on', null]], [])
  // Still queued as the worker asked a question.
  const asked = told('asked', [['the first', null]], [queue('enqueue', 'the first')])
  // Still queued, and a message during the hook opened the next turn already (deliver).
  const during = told('during', [['use tabs', null]], [queue('enqueue', 'use tabs')])
  ledger.startAttempt({
    taskId: during,
    kind: 'followup',
    decisionId: null,
    sessionId: 'during',
    prompt: 'no, spaces',
  })

  const capture = 'NOD: in {"title": "Ask Kim again"}'
  expect(await stopped('late', `${capture}\nNOD: done | did it`)).toBeNull()
  for (const session of ['heard', 'restarted', 'lost', 'during']) {
    expect(await stopped(session, 'NOD: done | did it')).toBeNull()
  }
  expect(await stopped('asked', 'NOD: question | Which one?')).toBeNull()

  const turns = (id: number) =>
    ledger.attempts(id).map((a) => [a.kind, a.prompt, a.fromTask, a.finishedAt === null])
  expect(turns(late)).toEqual([
    ['start', 'write it, late', null, false],
    ['followup', tabs, null, true],
  ])
  const next = ledger.openAttempt(late)?.id ?? 0
  expect(ledger.messages(late).map((m) => [m.attemptId, m.text, m.fromTask])).toEqual([
    [next, 'peer note', peer],
  ])
  expect(turns(lost)).toEqual([
    ['start', 'write it, lost', null, false],
    ['followup', 'go on', null, true],
  ])
  expect(turns(asked)).toEqual([
    ['start', 'write it, asked', null, false],
    ['followup', 'the first', null, true],
  ])
  expect([late, lost, asked].map(status)).toEqual(['running', 'running', 'running'])
  expect(ledger.decisions(asked)).toEqual([])
  for (const id of [heard, restarted]) {
    expect(status(id)).toBe('succeeded')
    expect(ledger.attempts(id)).toHaveLength(1)
    expect(ledger.messages(id)).toHaveLength(1)
  }
  // Only the turns that took in what they were told were judged by it.
  const reviewed = () =>
    entries('review').map((r) => /nod task n(\d+)\./.exec(r.message ?? '')?.[1])
  expect(reviewed()).toEqual([String(heard), String(restarted)])
  // With no terminal, as once Claude Code is gone, they wait for its next start.
  const left = (id: number) => readFileSync(join(home, 'work', `.prompt-${id}`), 'utf8')
  expect(left(late)).toBe(`${tabs}\n\npeer note`)
  expect(left(lost)).toBe('go on')
  // The message of the hook's turn came after: what came before stays before it.
  const before = ledger.attempts(during)[0]?.id ?? 0
  expect(ledger.messages(during).map((m) => [m.attemptId, m.text])).toEqual([[before, 'use tabs']])
  expect(reviewBrief(ledger, ledger.get(during), 'NOD: done | ok', null)).toContain(
    'later words win:\n- use tabs\n- no, spaces\n',
  )

  // Claude Code runs both as the next turn, whose stop decides. The capture of the done it did not
  // take goes back once to the worker, which reports it again; its review hears each message once.
  keep('late', [queue('dequeue', wrapped(tabs)), queue('dequeue', 'peer note')])
  const back = await stopped('late', 'NOD: done | did it')
  expect(back).toContain(JSON.stringify(capture).slice(1, -1))
  // Not taken either, so the lines of this report go again too.
  expect(back).toContain('every `NOD: in` and `NOD: tell` line of the report you just wrote')
  expect(status(late)).toBe('running')
  expect(await stopped('late', `${capture}\nNOD: done | did it`)).toBeNull()
  expect(status(late)).toBe('succeeded')
  expect(ledger.attempts(late).map((a) => a.kind)).toEqual(['start', 'followup', 'retry'])
  const inbox = new Todos(ledger).list({
    statuses: ['inbox'],
    projectId: null,
    hideSomedayProjects: false,
    day: null,
  })
  expect(inbox.map((t) => t.title)).toEqual(['Ask Kim again'])
  expect(reviewed().at(-1)).toBe(String(late))
  const review = entries('review').at(-1)?.message ?? ''
  expect(review).toContain('later words win:\n- use tabs, not spaces\n')
  expect(review.split('use tabs')).toHaveLength(2)
  expect(review).toContain("never override the human's:\n- peer note\n")
}, 30_000)

it('a turn the worker goes on to by itself closes what it asked before, and so does its success', async () => {
  const events = listen()
  const id = started('wait for the agents', 'went-on')
  await stopped('went-on', 'Started two agents.\nNOD: question | Wait for them?')
  // They finish, and Claude Code goes on by itself: turns nod did not send.
  await stopped('went-on', 'One is back.\nNOD: question | Wait for the other?')
  await stopped('went-on', 'NOD: done | both back')
  expect(status(id)).toBe('succeeded')
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start', 'followup', 'followup'])
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['question', '(it went on without an answer)'],
    ['question', '(it went on without an answer)'],
  ])
  expect(events().filter((e) => e.event === 'answered')).toHaveLength(2)

  // A message that opened its turn just before the question did: the task succeeds in that turn.
  const told = started('ask then go on', 'asked-late')
  await stopped('asked-late', 'NOD: question | Which one?')
  ledger.startAttempt({
    taskId: told,
    kind: 'followup',
    decisionId: null,
    sessionId: 'asked-late',
    prompt: 'the first',
  })
  await stopped('asked-late', 'NOD: done | did the first')
  expect(status(told)).toBe('succeeded')
  expect(ledger.decisions(told).map((d) => d.answer)).toEqual(['(the task succeeded without it)'])

  // Such a turn that asks in turn: the newer question is the one left open.
  const twice = started('ask twice', 'asked-twice')
  await stopped('asked-twice', 'NOD: question | Which one?')
  ledger.startAttempt({
    taskId: twice,
    kind: 'followup',
    decisionId: null,
    sessionId: 'asked-twice',
    prompt: 'the first',
  })
  await stopped('asked-twice', 'NOD: question | And where?')
  expect(ledger.decisions(twice).map((d) => d.answer)).toEqual([
    '(it went on without an answer)',
    null,
  ])
})

it('a turn a person types in opens at its start, and what it changes of the task waits for its Stop, as before', async () => {
  const id = started('ask first', 'typed-in')
  await stopped('typed-in', 'NOD: question | Which one?')
  // The person types an answer into the terminal instead: its turn opens, the question stays.
  await onPrompt(ledger, home, terminals, { session_id: 'typed-in', prompt: 'the first' })
  expect(status(id)).toBe('needs_decision')
  expect(ledger.attempts(id).map((a) => [a.kind, a.finishedAt === null])).toEqual([
    ['start', false],
    ['followup', true],
  ])
  // Its Stop takes that turn, and closes the question.
  await stopped('typed-in', 'NOD: done | did the first')
  expect(status(id)).toBe('succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'needs_decision'],
    ['followup', 'succeeded'],
  ])
  expect(ledger.decisions(id).map((d) => d.answer)).toEqual(['(it went on without an answer)'])
})

it('a typed turn whose transcript shows it ended without a Stop is ended, not taken for cut off; one cut off still is', async () => {
  const config = tmp.make('nod-transcripts-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  const said = (content: unknown, more: object = {}) => ({
    type: 'user',
    message: { role: 'user', content },
    ...more,
  })
  // A task waiting on a question, into whose terminal the person typed; that terminal is gone
  // since, and its transcript ends with `last`.
  const typedTurn = (session: string, last: object[]): number => {
    const id = started(`waits, ${session}`, session)
    const start = ledger.lastAttempt(id)?.id ?? 0
    ledger.endAttempt(start, { outcome: 'needs_decision', summary: 'which?', report: 'which?' })
    ledger.ask(id, start, 'question', 'which?')
    ledger.setAccount(id, config)
    void onPrompt(ledger, home, terminals, { session_id: session, prompt: 'the first' })
    const lines = [said('the first'), ...last].map((l) => JSON.stringify(l))
    writeFileSync(join(config, 'projects', 'work', `${session}.jsonl`), `${lines.join('\n')}\n`)
    return id
  }
  const stop = [{ type: 'text', text: '[Request interrupted by user]' }]
  const working = { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } }
  const stopped = typedTurn('stopped', [
    working,
    said(stop),
    { type: 'system', subtype: 'turn_duration' },
  ])
  const heldBack = typedTurn('held-back', [
    {
      type: 'system',
      subtype: 'informational',
      promptSubmitEnding: { ending: { kind: 'blocked_by_hook' }, promptKept: false },
    },
  ])
  // Not stopped by the person: Claude Code shut down, a tool printed the words, a subagent's.
  const shutDown = typedTurn('shut-down', [working, said(stop, { interruptedByShutdown: true })])
  const toolSaid = typedTurn('tool-said', [
    working,
    said([{ type: 'tool_result', content: '[Request interrupted by user]' }]),
  ])
  const subagent = typedTurn('subagent', [working, said(stop, { isSidechain: true })])
  // A permission dialog the stopped turn showed: it goes as before, cut off with its terminal.
  const asked = typedTurn('asked', [working, said(stop)])
  ledger.ask(
    asked,
    ledger.openAttempt(asked)?.id ?? 0,
    'permission',
    'Claude needs your permission',
  )

  const lost = await lostTurns(ledger, home, terminals, new Date(Date.now() + 60_000))

  expect(lost).toEqual([shutDown, toolSaid, subagent, asked])
  const last = (id: number) => {
    const a = ledger.attempts(id).at(-1)
    return [a?.outcome, a?.error]
  }
  expect([stopped, heldBack].map(last)).toEqual([
    ['error', 'the person stopped it (Escape)'],
    ['error', 'a hook held the message back'],
  ])
  // Their question is still the person's to answer.
  for (const id of [stopped, heldBack]) {
    expect(status(id)).toBe('needs_decision')
    expect(ledger.decisions(id).map((d) => d.answer)).toEqual([null])
  }
})

it('a task waiting on background work that a person typed into and stopped is still asked about once it waited too long', async () => {
  const config = tmp.make('nod-transcripts-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  const stop = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
  // The worker stopped waiting on an agent; the person typed into its terminal and pressed Escape.
  const waiting = async (session: string): Promise<number> => {
    const id = started(`waits, ${session}`, session)
    ledger.setAccount(id, config)
    await stopped(session, 'NOD: question | which?', ['agent'])
    await onPrompt(ledger, home, terminals, { session_id: session, prompt: 'status?' })
    const file = join(config, 'projects', 'work', `${session}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'user', message: stop })}\n`)
    return id
  }
  const later = new Date(Date.now() + 2 * 60 * 60_000)
  const asked = (id: number) =>
    ledger.decisions(id).map((d) => [d.reason, d.question.includes('which?')])

  // The stopped turn still open as the tick looks.
  const open = await waiting('typed-open')
  expect(await overdueWaits(ledger, home, later)).toEqual([open])
  expect(asked(open)).toEqual([['question', true]])
  // One a tick already ended as its terminal went.
  const ended = await waiting('typed-ended')
  expect(await lostTurns(ledger, home, terminals, later)).toEqual([])
  expect(await overdueWaits(ledger, home, later)).toEqual([ended])
  expect(asked(ended)).toEqual([['question', true]])
})

it('a turn that stops while background work it started still runs waits for that work, and asks nobody', async () => {
  const events = listen()
  const id = started('review it', 'waits')
  await stopped('waits', 'The review runs.\nNOD: question | Waiting for the review', ['review'])
  expect(status(id)).toBe('running')
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', 'waiting']])
  // The review reports and Claude Code goes on by itself: a fix and a second review, then done.
  await stopped('waits', 'Fixed; a second review runs.\nNOD: question | Waiting again', ['review'])
  await stopped('waits', 'NOD: done | reviewed twice')
  expect(status(id)).toBe('succeeded')
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'waiting'],
    ['followup', 'waiting'],
    ['followup', 'succeeded'],
  ])
  expect(events().filter((e) => e.event === 'decision')).toEqual([])

  // Once the work is done, with none left running, a question goes to the person as before.
  const asks = started('ask after', 'asks-after')
  await stopped('asks-after', 'NOD: question | Waiting for the shell', ['a shell'])
  await stopped('asks-after', 'NOD: question | Which file?')
  expect(ledger.decisions(asks).map((d) => [d.reason, d.question, d.answer])).toEqual([
    ['question', 'NOD: question | Which file?', null],
  ])
  expect(status(asks)).toBe('needs_decision')

  // A done is checked and taken as ever, with work still running or not.
  const done = started('serve it', 'done-serving')
  await stopped('done-serving', 'NOD: done | the server runs', ['a dev server'])
  expect(status(done)).toBe('succeeded')
})

it('a retry that stops with no report while background work it started still runs waits for that work, and is not checked as done', async () => {
  // The stop of a turn Claude Code continued as the Stop hook blocked it: a retry of a failed check.
  const retried = (session: string, report: string, running: string[]) =>
    onStop(ledger, home, terminals, {
      session_id: session,
      last_assistant_message: report,
      stop_hook_active: true,
      background_tasks: running.map((description) => ({ type: 'subagent', description })),
    })
  const turns = (id: number) => ledger.attempts(id).map((a) => [a.kind, a.outcome, a.checkResult])
  const id = started('review-strict: write it', 'retry-waits')
  expect(await stopped('retry-waits', 'NOD: done | did it')).not.toBeNull()
  expect(await retried('retry-waits', 'Fixing it; a review still runs.', ['review'])).toBeNull()
  expect(status(id)).toBe('running')
  expect(ledger.decisions(id)).toEqual([])
  expect(turns(id)).toEqual([
    ['start', 'succeeded', 'failed'],
    ['retry', 'waiting', null],
  ])

  // With no work left running, a retry with no report is checked as done, as before.
  const checked = started('review-strict: write it', 'retry-checked')
  expect(await stopped('retry-checked', 'NOD: done | did it')).not.toBeNull()
  expect(await retried('retry-checked', 'Fixed it.', [])).not.toBeNull()
  expect(turns(checked)).toEqual([
    ['start', 'succeeded', 'failed'],
    ['retry', 'succeeded', 'failed'],
    ['retry', null, null],
  ])
}, 30_000)

it('a task that has waited on background work past the limit asks the person, at its next stop or at the tick', async () => {
  const id = started('review it', 'waits-long')
  await stopped('waits-long', 'NOD: question | Waiting for the review', ['review'])
  const minutes = (n: number): Date => new Date(Date.now() + n * 60_000)
  expect(await overdueWaits(ledger, home, minutes(59))).toEqual([])
  // An hour on, no turn has come: the review never reports, or went with its Claude Code.
  const later = minutes(61)
  const [a, b] = await Promise.all([
    overdueWaits(ledger, home, later),
    overdueWaits(ledger, home, later),
  ])
  expect([...a, ...b]).toEqual([id])
  const asked = ledger.decisions(id)
  expect(asked.map((d) => d.reason)).toEqual(['question'])
  expect(asked[0]?.question).toContain("past nod's limit of 60. No turn has come since it stopped.")
  expect(asked[0]?.question).toContain('NOD: question | Waiting for the review')
  expect(status(id)).toBe('needs_decision')
  expect(ledger.attempts(id).map((x) => x.outcome)).toEqual(['needs_decision'])

  // Turns that went on waiting, in a row since past the limit: the next stop asks, work or not.
  const chain = started('keep waiting', 'waits-chain')
  await stopped('waits-chain', 'NOD: question | Waiting', ['monitor'])
  ledger.db
    .query('update attempts set finished_at = $at where task_id = $id')
    .run({ at: minutes(-61).toISOString(), id: chain })
  await stopped('waits-chain', 'NOD: question | Still waiting', ['monitor'])
  const [still] = ledger.decisions(chain)
  expect(still?.question).toContain('Still running: monitor.\nNOD: question | Still waiting')
  expect(ledger.attempts(chain).map((x) => x.outcome)).toEqual(['waiting', 'needs_decision'])

  // A turn that came since (the work finished) leaves the tick nothing to ask.
  const back = started('came back', 'waits-back')
  await stopped('waits-back', 'NOD: question | Waiting', ['review'])
  ledger.startAttempt({
    taskId: back,
    kind: 'followup',
    decisionId: null,
    sessionId: 'waits-back',
    prompt: '(typed into the terminal)',
  })
  expect(await overdueWaits(ledger, home, later)).toEqual([])
  expect(ledger.decisions(back)).toEqual([])
})

it('only the time a task waited with no turn open counts toward the wait limit, not a turn that ran between waits', async () => {
  const now = Date.now()
  const ago = (min: number): string => new Date(now - min * 60_000).toISOString()
  // Sets each turn's start and end, in minutes before now; an end of null leaves it open.
  const timed = (id: number, times: [number, number | null][]): void => {
    ledger.attempts(id).forEach((a, i) => {
      const [start, end] = times[i] ?? [0, null]
      ledger.db
        .query('update attempts set started_at = $start, finished_at = $end where id = $id')
        .run({ start: ago(start), end: end === null ? null : ago(end), id: a.id })
    })
  }
  const next = (id: number, session: string): void => {
    ledger.startAttempt({
      taskId: id,
      kind: 'followup',
      decisionId: null,
      sessionId: session,
      prompt: 'go on',
    })
  }

  // Two short waits, then a turn that ran for 43 hours (tests and reviews, a PC asleep) and stops
  // with work of its own still running: 8 + 5 minutes of waiting, not the 2604 since the first.
  const id = started('review it', 'waits-ran')
  await stopped('waits-ran', 'NOD: question | Waiting for the review', ['review'])
  await stopped('waits-ran', 'NOD: question | Waiting again', ['review'])
  next(id, 'waits-ran')
  timed(id, [
    [2618, 2604],
    [2596, 2589],
    [2584, null],
  ])
  await stopped('waits-ran', 'NOD: question | Waiting for the second review', ['review'])
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.attempts(id).map((a) => a.outcome)).toEqual(['waiting', 'waiting', 'waiting'])
  // The tick counts on from those 13 minutes: past the limit 47 minutes after this stop.
  const minutes = (n: number): Date => new Date(Date.now() + n * 60_000)
  expect(await overdueWaits(ledger, home, minutes(45))).toEqual([])
  expect(await overdueWaits(ledger, home, minutes(49))).toEqual([id])
  expect(ledger.decisions(id)[0]?.question).toContain(
    'waited on background work it started for 62 minutes',
  )

  // Waits that add up past the limit with only short turns between still ask at the next stop.
  const chain = started('keep waiting', 'waits-adds-up')
  await stopped('waits-adds-up', 'NOD: question | Waiting', ['monitor'])
  await stopped('waits-adds-up', 'NOD: question | Still waiting', ['monitor'])
  next(chain, 'waits-adds-up')
  timed(chain, [
    [80, 70],
    [40, 38],
    [5, null],
  ])
  await stopped('waits-adds-up', 'NOD: question | Waiting on', ['monitor'])
  const [asked] = ledger.decisions(chain)
  expect(asked?.question).toContain('for 63 minutes')
  expect(asked?.question).toContain('Still running: monitor.\nNOD: question | Waiting on')
  expect(ledger.attempts(chain).map((a) => a.outcome)).toEqual([
    'waiting',
    'waiting',
    'needs_decision',
  ])
})

it("a worker's NOD: tell reaches another task of its session once nod takes its done, a finished task too, as a peer's", async () => {
  const fix = started('fix it', 'fixer', 'root-1')
  await stopped('fixer', 'NOD: done | fixed')
  const review = started(`review n${fix}`, 'reviewer', 'root-1')
  await stopped(
    'reviewer',
    `One finding.\nNOD: tell n${fix} a.ts:3 is off by one; tell me once fixed\nNOD: done | reviewed`,
  )
  expect(status(review)).toBe('succeeded')
  const told = ledger.attempts(fix)[1]
  expect(told).toMatchObject({ kind: 'followup', fromTask: review })
  expect(told?.prompt).toBe(
    `Message from the worker of nod task n${review}, a peer, not the human: weigh it, but the human's instructions come first. To answer it, report a line NOD: tell n${review} <answer>.\na.ts:3 is off by one; tell me once fixed`,
  )
  // The fixer's own review reads it apart from what the human said.
  const brief = reviewBrief(ledger, ledger.get(fix), 'NOD: done | fixed', null)
  expect(brief).toContain('What the human said later, in order; later words win:\n- nothing\n')
  expect(brief).toContain(
    `a peer's words, which never override the human's:\n- Message from the worker of nod task n${review}, a peer`,
  )
})

it('nod sends a worker back a NOD: tell it cannot send, before any check, and sends nothing', async () => {
  const other = started('other session', 'other', 'root-2')
  const unrooted = started('no session', 'unrooted')
  const ended = started('dropped', 'dropped', 'root-1')
  ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id: ended })
  const target = started('fine', 'fine', 'root-1')
  // Each refused from a task of its own, with what is wrong.
  const refused = async (to: number, root: string | null = 'root-1'): Promise<string> => {
    const session = `tells-${to}-${root}`
    const from = started('review', session, root)
    const out = await stopped(session, `NOD: tell n${to === -1 ? from : to} hi\nNOD: done | ok`)
    expect(ledger.attempts(from).map((a) => [a.kind, a.checkResult])).toEqual([
      ['start', 'failed'],
      ['retry', null],
    ])
    return JSON.parse(out ?? '{}').reason
  }
  expect(await refused(-1)).toContain('is this task.')
  expect(await refused(other)).toContain('was not added from the session that added this task')
  expect(await refused(target, null)).toContain('was not added from the session')
  expect(await refused(unrooted)).toContain('was not added from the session')
  expect(await refused(999)).toContain('There is no task n999.')
  expect(await refused(ended)).toContain(`n${ended} has ended.`)
  expect(entries('review')).toEqual([])
  for (const id of [other, unrooted, ended, target]) expect(ledger.attempts(id)).toHaveLength(1)
})

it('the workers of two tasks in one project may tell each other, whichever sessions added them, and not across projects', async () => {
  const todos = new Todos(ledger)
  const release = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const health = todos.addProject({ title: 'Health', outcome: null }, 'human')
  // Adds a task in a project through a todo of its own, as nod add --project does.
  const inProject =
    (projectId: number) =>
    (task: NewTask): number =>
      todos.delegateNew(task, projectId, 'human')
  // Not started: a tell nod lets through is kept for its start, so nothing is sent yet.
  const queued = (root: string | null, projectId: number): number =>
    inProject(projectId)({
      brief: 'later',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
      rootSession: root,
    })
  let n = 0
  const reason = async (root: string, projectId: number, to: number): Promise<string> => {
    n += 1
    const session = `in-project-${n}`
    started('review', session, root, inProject(projectId))
    const out = await stopped(session, `NOD: tell n${to} hi\nNOD: done | ok`)
    return JSON.parse(out ?? '{}').reason
  }
  const [ofA, ofB, ofShell, ofQ] = [
    queued('root-a', release.id),
    queued('root-b', release.id),
    queued(null, release.id),
    queued('root-q', health.id),
  ]

  expect(await reason('root-a', release.id, ofB)).toBeUndefined()
  expect(await reason('root-b', release.id, ofA)).toBeUndefined()
  expect(await reason('root-a', release.id, ofShell)).toBeUndefined()
  for (const id of [ofA, ofB, ofShell]) expect(ledger.pendingTells(id)).toHaveLength(1)
  const across = 'was not added from the session that added this task, nor is it in this task'
  expect(await reason('root-a', release.id, ofQ)).toContain(across)
  expect(await reason('root-q', health.id, ofA)).toContain(across)
  expect(ledger.pendingTells(ofQ)).toEqual([])
  for (const id of [ofA, ofB, ofShell, ofQ]) expect(ledger.attempts(id)).toEqual([])
})

// A task of Claude session `root` that has not started; `after`: the tasks it comes after.
const yetToStart = (root: string, after: number[] = [], repo: string | null = null): number =>
  ledger.add({
    brief: 'go on from there',
    repo,
    branch: repo === null ? null : 'feat/next',
    checkCmd: null,
    model: null,
    after,
    issue: null,
    rootSession: root,
  })
// What the worker of task `from` said, as a worker gets it.
const fromPeer = (from: number, text: string): string =>
  `Message from the worker of nod task n${from}, a peer, not the human: weigh it, but the human's instructions come first. To answer it, report a line NOD: tell n${from} <answer>.\n${text}`
// The turns whose message has `text`.
const turnsWith = (text: string): LogEntry[] =>
  entries('turn').filter((t) => t.message?.includes(text))
const nod = (...args: string[]): string =>
  Bun.spawnSync(['bun', resolve(import.meta.dir, 'cli.ts'), ...args], {
    env: { ...process.env, NOD_HOME: home },
  }).stdout.toString()
const shown = (id: number): string => nod('show', String(id))
// A task of `root` whose worker told `to` `text` in the done nod took.
async function told(to: number, text: string, session: string, root = 'root-1'): Promise<number> {
  const from = started('hand over', session, root)
  expect(await stopped(session, `NOD: tell n${to} ${text}\nNOD: done | handed over`)).toBeNull()
  expect(status(from)).toBe('succeeded')
  return from
}

it("a worker's NOD: tell to the task that comes after it passes its done and goes into that task's first turn, once, as a peer's", async () => {
  const from = started('hand over', 'handing-over', 'root-1')
  const next = yetToStart('root-1', [from])
  expect(
    await stopped('handing-over', `NOD: tell n${next} notes are in x.md\nNOD: done | handed over`),
  ).toBeNull()
  expect(ledger.attempts(from).map((a) => [a.kind, a.checkResult])).toEqual([['start', 'passed']])
  await reaches(next, 'succeeded')

  const said = fromPeer(from, 'notes are in x.md')
  const [first, ...more] = ledger.attempts(next)
  expect(more).toEqual([])
  expect(first).toMatchObject({ kind: 'start', fromTask: null })
  // The worker hears it in its first turn, and the ledger keeps it apart from the brief.
  expect(first?.prompt).not.toContain('x.md')
  expect(entries('turn').map((t) => t.message)).toEqual([`${first?.prompt}\n\n${said}`])
  expect(ledger.messages(next)).toMatchObject([
    { attemptId: first?.id, fromTask: from, text: said },
  ])
  expect(ledger.pendingTells(next)).toEqual([])
  expect(ledger.tellsBetween(from, next)).toBe(1)
  // Its review and a compacted conversation read it apart from what the human said.
  const brief = reviewBrief(ledger, ledger.get(next), 'NOD: done | did it', null)
  expect(brief).toContain('What the human said later, in order; later words win:\n- nothing\n')
  expect(brief).toContain(
    `a peer's words, which never override the human's:\n- Message from the worker of nod task n${from}, a peer`,
  )
  const again = askedAgain(ledger, ledger.get(next))
  expect(again.split('What the human said later')[0]).not.toContain('x.md')
  expect(shown(next)).toMatch(new RegExp(`start .* from n${from}  session`))
})

it('what a worker told a task that failed before it started stays in the ledger through a nod that starts again, for nod resume', async () => {
  const next = yetToStart('root-1')
  const folder = workspaceOf(home, ledger.get(next))
  writeFileSync(folder, '')
  await failure(startTask(ledger, home, terminals, next))
  const from = await told(next, 'see a.ts', 'told-failed')

  ledger.db.close()
  ledger = new Ledger(home)
  expect(ledger.pendingTells(next)).toMatchObject([{ fromTask: from, text: 'see a.ts' }])
  expect(shown(next)).toContain(`kept for its start from n${from}: see a.ts`)

  rmSync(folder)
  expect(await resume(ledger, home, terminals, next)).toBe('started')
  await reaches(next, 'succeeded')
  expect(turnsWith('see a.ts').map((t) => t.message)).toEqual([
    expect.stringMatching(
      new RegExp(`^go on from there\\n\\nMessage from the worker of nod task n${from}`),
    ),
  ])
  expect(ledger.attempts(next).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'error'],
    ['start', 'succeeded'],
  ])
})

it('a task nod is making the folder of takes a message sent meanwhile in its first turn', async () => {
  const before = started('first', 'before-it', 'root-1')
  await stopped('before-it', 'NOD: done | first')
  const next = yetToStart('root-1', [before])
  // startReady claimed it, and it has no folder yet.
  ledger.db.query("update tasks set status = 'running' where id = $id").run({ id: next })
  await told(next, 'see a.ts', 'told-claimed')
  expect(ledger.pendingTells(next)).toHaveLength(1)
  await startTask(ledger, home, terminals, next)
  await reaches(next, 'succeeded')
  expect(turnsWith('see a.ts')).toHaveLength(1)
})

it('a task that starts between the check of a NOD: tell and its sending gets it once, not kept but sent', async () => {
  const next = yetToStart('root-1')
  // Its sender's check starts it, from a process of its own, as another worker's Stop hook would.
  const start = join(home, 'start.ts')
  const src = (file: string): string => JSON.stringify(resolve(import.meta.dir, file))
  writeFileSync(
    start,
    `import { Ledger } from ${src('ledger.ts')}
import { startTask } from ${src('worker.ts')}
import { FakeTerminals } from ${src('../test/fake-terminals.ts')}
const home = ${JSON.stringify(home)}
await startTask(new Ledger(home), home, FakeTerminals.of(home), ${next})
`,
  )
  const from = started('hand over', 'told-racing', 'root-1')
  ledger.db
    .query('update tasks set check_cmd = $check where id = $id')
    .run({ check: `${quote(process.execPath)} ${quote(start)}`, id: from })
  await stopped('told-racing', `NOD: tell n${next} see a.ts\nNOD: done | handed over`)
  expect(status(from)).toBe('succeeded')
  expect(ledger.pendingTells(next)).toEqual([])
  await until(() => turnsWith('see a.ts').length > 0 && ledger.openAttempt(next) === null)
  expect(turnsWith('see a.ts')).toHaveLength(1)
  expect(ledger.tellsBetween(from, next)).toBe(1)
})

it('a start keeps the ledger to itself until its terminal is up, so a message cannot find its turn with no terminal yet', async () => {
  const next = yetToStart('root-1')
  const start = fake.start.bind(fake)
  let refused = ''
  const spy = spyOn(fake, 'start').mockImplementation((...args) => {
    const other = new Database(join(home, 'nod.db'))
    other.exec('pragma busy_timeout = 0')
    try {
      other.exec('begin immediate')
      other.exec('rollback')
    } catch (error) {
      refused = String(error)
    }
    other.close()
    start(...args)
  })
  await startTask(ledger, home, terminals, next)
  spy.mockRestore()
  expect(refused).toContain('locked')
  await reaches(next, 'succeeded')
})

it.each([
  ['alone', false],
  ['and left for it too', true],
])(
  'what a start took goes to the next start if its terminal never came up, once: %s',
  async (_, left) => {
    const events = listen()
    const next = yetToStart('root-1')
    const from = await told(next, 'see a.ts', 'told-unlaunched')
    const said = fromPeer(from, 'see a.ts')
    const spy = spyOn(fake, 'start').mockImplementationOnce(() => {
      throw new Error('no terminal')
    })
    expect(await failure(startTask(ledger, home, terminals, next))).toBe('no terminal')
    spy.mockRestore()
    expect(status(next)).toBe('error')
    expect(ledger.messages(next)).toMatchObject([{ fromTask: from, text: said }])
    // Now: gc may collect it before any start, and then nothing brings it back.
    expect(events().filter((e) => e.event === 'error')).toMatchObject([
      {
        task: { id: next },
        error: `nod could not pass on what task n${from}'s worker told it (its start failed; nod resume n${next} passes it on): ${said}`,
      },
    ])
    // As deliver leaves it for a start too, once a Claude Code it pasted into has gone.
    if (left) writeFileSync(join(home, 'work', `.prompt-${next}`), said)

    expect(await resume(ledger, home, terminals, next)).toBe('reopened')
    await until(() => turnsWith('see a.ts').length > 0)
    const [turn] = turnsWith('see a.ts')
    expect(turn?.message?.split(said)).toHaveLength(2)
  },
)

it('a start runs an account command before its transaction, which would keep the ledger from the others that long', async () => {
  const probed = join(home, 'probed')
  const probe = join(home, 'probe.ts')
  writeFileSync(
    probe,
    `import { Database } from 'bun:sqlite'
import { appendFileSync } from 'node:fs'
const db = new Database(${JSON.stringify(join(home, 'nod.db'))})
db.exec('pragma busy_timeout = 0')
try {
  db.exec('begin immediate')
  db.exec('rollback')
  appendFileSync(${JSON.stringify(probed)}, 'free\\n')
} catch {
  appendFileSync(${JSON.stringify(probed)}, 'held\\n')
}
console.log(process.env.CLAUDE_CONFIG_DIR)
`,
  )
  setAccountRule(home, { command: `${quote(process.execPath)} ${quote(probe)}` })
  const next = yetToStart('root-1')
  await startTask(ledger, home, terminals, next)
  // Read at once: a hook of the worker that just started may hold the lock from here on.
  const seen = readFileSync(probed, 'utf8').trim().split('\n')
  expect(seen.length).toBeGreaterThan(1)
  expect(new Set(seen)).toEqual(new Set(['free']))
  await reaches(next, 'succeeded')
})

it('a kept message loses its control characters, as a paste does, so the end of its turn finds it heard', async () => {
  const next = yetToStart('root-1')
  await told(next, 'see \x07a.ts', 'told-bell')
  await startTask(ledger, home, terminals, next)
  await reaches(next, 'succeeded')
  expect(ledger.attempts(next)).toHaveLength(1)
  expect(turnsWith('see a.ts')).toHaveLength(1)
})

it('what is kept for a task counts towards the messages two tasks may send each other', async () => {
  const next = yetToStart('root-1')
  const from = started('hand over', 'told-too-much', 'root-1')
  for (const text of ['one', 'two', 'three', 'four']) ledger.keepTell(next, from, text)
  await stopped('told-too-much', `NOD: tell n${next} five\nNOD: done | handed over`)
  expect(status(from)).toBe('needs_decision')
  expect(ledger.decisions(from)[0]?.question).toContain('have sent each other 4 messages already')
  expect(ledger.pendingTells(next)).toHaveLength(4)
})

it('a message kept for a task that ends before it starts reaches the person once, by a drop or the tick', async () => {
  const events = listen()
  const heard = (): (string | number | undefined)[][] =>
    events()
      .filter((e) => e.event === 'error')
      .map((e) => [e.task?.id, e.error])
  const before = started('first', 'dropped-before', 'root-1')
  const turn = ledger.openAttempt(before)
  if (turn === null) throw new Error('no turn')
  const asked = ledger.ask(before, turn.id, 'question', 'go on?')
  const next = yetToStart('root-1', [before])
  const from = await told(next, 'see a.ts', 'told-dropped')
  await drop(ledger, home, terminals, asked)
  expect(status(next)).toBe('cancelled')
  const line = `nod could not pass on what task n${from}'s worker told it (n${next} ended without starting.): see a.ts`
  expect(heard()).toEqual([[next, line]])
  expect(shown(next)).toContain(`not passed on from n${from}: see a.ts`)

  // An end nod did not see to hear of, as a retrospective's: the tick does, and only of that one.
  const other = yetToStart('root-1')
  const sender = await told(other, 'see b.ts', 'told-ended')
  ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id: other })
  await tick(ledger, home, terminals, new Date(), false)
  await tick(ledger, home, terminals, new Date(), false)
  expect(heard()).toHaveLength(2)
  expect(heard()).toContainEqual([
    other,
    `nod could not pass on what task n${sender}'s worker told it (n${other} ended without starting.): see b.ts`,
  ])
})

it('a message kept for a task that failed before it started reaches the person once gc collects it, and a resume after that does not send it', async () => {
  const events = listen()
  const next = yetToStart('root-1')
  const folder = workspaceOf(home, ledger.get(next))
  writeFileSync(folder, '')
  await failure(startTask(ledger, home, terminals, next))
  const from = await told(next, 'see a.ts', 'told-collected')
  await tick(ledger, home, terminals, new Date(), false)
  expect(events().filter((e) => e.event === 'error')).toEqual([])

  // nod gc tells it itself, as the schedule may be off; the tick after it tells it no more.
  nod('gc', `n${next}`)
  expect(ledger.get(next).collectedAt).not.toBeNull()
  const heard = {
    task: { id: next },
    error: `nod could not pass on what task n${from}'s worker told it (n${next} ended without starting.): see a.ts`,
  }
  expect(events().filter((e) => e.event === 'error')).toMatchObject([heard])
  await tick(ledger, home, terminals, new Date(), false)
  expect(events().filter((e) => e.event === 'error')).toMatchObject([heard])
  rmSync(folder)
  expect(await resume(ledger, home, terminals, next)).toBe('started')
  await reaches(next, 'succeeded')
  expect(turnsWith('see a.ts')).toEqual([])
  expect(shown(next)).toContain(`not passed on from n${from}: see a.ts`)
})

it('a drop tells the person what its worker never took in, as Claude Code ended before it took the brief, and not what it did', async () => {
  const events = listen()
  const errors = (): Heard[] => events().filter((e) => e.event === 'error')
  writeFileSync(join(home, 'fake-exit'), '')
  const next = yetToStart('root-1')
  const from = await told(next, 'see a.ts', 'told-exiting')
  await startTask(ledger, home, terminals, next)
  const decision = await until(() => ledger.decisions(next)[0])
  await until(() => !terminals.alive(sessionName(next)))
  await drop(ledger, home, terminals, decision.id)
  expect(entries('turn')).toEqual([])
  expect(
    errors().filter((e) => e.task?.id === next && e.error?.includes('see a.ts')),
  ).toMatchObject([
    {
      error: `nod could not pass on what task n${from}'s worker told it (its worker never took it in): ${fromPeer(from, 'see a.ts')}`,
    },
  ])

  rmSync(join(home, 'fake-exit'))
  const heard = ledger.add({
    brief: 'hang here',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
    rootSession: 'root-1',
  })
  await told(heard, 'see b.ts', 'told-heard')
  await startTask(ledger, home, terminals, heard)
  await until(() => turnsWith('see b.ts').length > 0)
  const turn = ledger.openAttempt(heard)
  if (turn === null) throw new Error('no turn')
  await drop(ledger, home, terminals, ledger.ask(heard, turn.id, 'question', 'go on?'))
  expect(errors().filter((e) => e.error?.includes('see b.ts'))).toEqual([])
}, 30_000)

it('a message that went with a start the person turned down at its trust dialog reaches them', async () => {
  const events = listen()
  writeFileSync(join(home, 'fake-untrusted'), '')
  const next = yetToStart('root-1', [], newRepo())
  const from = await told(next, 'see a.ts', 'told-untrusted')
  await startTask(ledger, home, terminals, next)
  const [trust] = ledger.decisions(next)
  if (trust?.reason !== 'trust') throw new Error('no trust decision')
  await answer(ledger, home, terminals, trust.id, 'not this one', 'human')
  expect(status(next)).toBe('cancelled')
  expect(entries('turn')).toEqual([])
  expect(events().filter((e) => e.event === 'error')).toMatchObject([
    {
      task: { id: next },
      error: expect.stringContaining(
        `task n${from}'s worker told it (its worker never took it in): ${fromPeer(from, 'see a.ts')}`,
      ),
    },
  ])
})

it('two tasks whose workers have sent each other four messages ask the person before a fifth goes', async () => {
  const review = started('review', 'reviewing', 'root-1')
  const fix = started('fix', 'fixing', 'root-1')
  const turnOf = (id: number): number => ledger.openAttempt(id)?.id ?? 0
  const [reviewTurn, fixTurn] = [turnOf(review), turnOf(fix)]
  // Two round trips so far: findings, fixed, more findings, fixed again.
  ledger.addMessage(fix, fixTurn, 'findings', review)
  ledger.addMessage(review, reviewTurn, 'fixed', fix)
  ledger.addMessage(fix, fixTurn, 'more findings', review)
  ledger.addMessage(review, reviewTurn, 'fixed again', fix)
  const out = await stopped('reviewing', `NOD: tell n${fix} one more thing\nNOD: done | reviewed`)
  expect(out).toBeNull()
  expect(status(review)).toBe('needs_decision')
  const [asked] = ledger.decisions(review)
  expect(asked?.reason).toBe('question')
  expect(asked?.question).toContain(
    `> to n${fix}: one more thing\nn${review} and n${fix} have sent each other 4 messages already, and nod passes on at most 4`,
  )
  expect(ledger.attempts(fix)).toHaveLength(1)
  expect(entries('review')).toEqual([])

  // Three so far, and two more in one report: neither goes, and the person sees both.
  const other = started('review', 'reviewing-two', 'root-1')
  const done = started('fix', 'fixing-two', 'root-1')
  for (const text of ['findings', 'fixed', 'more findings']) {
    ledger.addMessage(done, turnOf(done), text, other)
  }
  await stopped(
    'reviewing-two',
    `NOD: tell n${done} first\nNOD: tell #${done} second\nNOD: done | reviewed`,
  )
  const [both] = ledger.decisions(other)
  expect(both?.question).toContain(`> to n${done}: first\n> to n${done}: second\n`)
  expect(both?.question).toContain('have sent each other 3 messages already')
  expect(ledger.attempts(done)).toHaveLength(1)
})

it('a message a worker told a task the person drops while nod checks it does not bring that task back', async () => {
  const events = listen()
  const target = started('fix', 'drop-target', 'root-1')
  await stopped('drop-target', 'NOD: done | fixed')
  // The person drops the target while the sender's checks run; here its check command does it,
  // from a process of its own, as `nod drop` would.
  const drop = join(home, 'drop.ts')
  writeFileSync(
    drop,
    `import { Database } from 'bun:sqlite'\nnew Database(${JSON.stringify(join(home, 'nod.db'))}).run("update tasks set status = 'cancelled' where id = ${target}")\n`,
  )
  const from = started('review it', 'drop-sender', 'root-1')
  ledger.db
    .query('update tasks set check_cmd = $check where id = $id')
    .run({ check: `${quote(process.execPath)} ${quote(drop)}`, id: from })
  await stopped('drop-sender', `NOD: tell n${target} a.ts:3 is off by one\nNOD: done | reviewed`)
  expect(status(from)).toBe('succeeded')
  expect(status(target)).toBe('cancelled')
  expect(ledger.attempts(target)).toHaveLength(1)
  const heard = events().filter((e) => e.event === 'error')
  expect(heard.map((e) => [e.task?.id, e.error])).toEqual([
    [target, expect.stringContaining(`n${target} has ended.): a.ts:3 is off by one`)],
  ])
}, 30_000)

test('a review tells the fixer its findings, and the fixer tells it back once fixed, through nod alone', async () => {
  const rooted = async (brief: string): Promise<number> => {
    const id = ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
      rootSession: 'root-1',
    })
    await startTask(ledger, home, terminals, id)
    return id
  }
  const fix = await rooted('fix it')
  await reaches(fix, 'succeeded')
  // As the person would brief it: review, then send the findings to the fixer.
  const review = await rooted(`tell n${fix} ping-back: a.ts:3 is off by one`)
  const step = (done: () => boolean): Promise<true> =>
    until(done).catch((error: unknown) => {
      throw new Error(`${String(error)}\n${whereIs(fix)}\n${whereIs(review)}`)
    })
  // The findings reach the fixer, which tells the review back, which takes another look.
  await step(() => ledger.attempts(fix).length === 2)
  await step(() => ledger.attempts(review).length === 2)
  await step(() => status(review) === 'succeeded' && status(fix) === 'succeeded')
  expect(ledger.attempts(fix).map((a) => [a.kind, a.fromTask])).toEqual([
    ['start', null],
    ['followup', review],
  ])
  expect(ledger.attempts(review).map((a) => [a.kind, a.fromTask])).toEqual([
    ['start', null],
    ['followup', fix],
  ])
  expect(ledger.attempts(review)[1]?.prompt).toEndWith('\nfixed it')
  expect(ledger.tellsBetween(fix, review)).toBe(2)
  expect(ledger.openDecisions()).toEqual([])
}, 30_000)

it("a permission answered in the worker's terminal does not stay open once its turn ends", async () => {
  const id = started('fetch it', 'answered-there')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission') // as onNotification does
  // A person attached to the worker answers the dialog there, and the turn goes on to its end.
  await stopped('answered-there', 'NOD: done | fetched')
  expect(status(id)).toBe('succeeded')
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['permission', '(its turn ended)'],
  ])
})

it("a permission the person refused in the worker's terminal closes as their answer once its turn ends, which the project session hears; one nod cannot tell refused closes as the turn ended", async () => {
  const session = 'refused-there'
  const id = started('ship it', session)
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  const asked = (command: string) =>
    ledger.ask(id, attempt.id, 'permission', permissionQuestion('Bash', { command }))
  const refused = asked('git push origin feat/x')
  const letRun = asked('git push origin --tags')
  const withWords = asked('rm -rf build')
  const subagents = asked('npm publish')
  const again = asked('git fetch origin')
  // A subagent's dialog, worded from the screen (onNotification): no call of the worker's matches.
  const screen = ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission')
  // The worker's transcript as Claude Code keeps it (2.1.316's binary): each call, and its result.
  const no =
    "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
  const entries: object[] = []
  const call = (n: number, command: string, result: string, error: boolean, sidechain = false) => {
    const isSidechain = sidechain
    entries.push({
      type: 'assistant',
      isSidechain,
      message: { content: [{ type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command } }] },
    })
    const block = { type: 'tool_result', tool_use_id: `t${n}`, content: result, is_error: error }
    entries.push({ type: 'user', isSidechain, message: { content: [block] } })
  }
  call(1, 'git push origin feat/x', `${no} STOP what you are doing and wait.`, true)
  call(2, 'git push origin --tags', 'Everything up-to-date', false)
  call(
    3,
    'rm -rf build',
    `${no} To tell you how to proceed, the user said:\nuse the clean script`,
    true,
  )
  call(4, 'npm publish', `${no} STOP what you are doing and wait.`, true, true)
  // Refused, then run again and let through: the last call decides.
  call(5, 'git fetch origin', `${no} STOP what you are doing and wait.`, true)
  call(6, 'git fetch origin', '', false)
  const sessions = projectFolder(
    process.env.CLAUDE_CONFIG_DIR ?? '',
    workspaceOf(home, ledger.get(id)),
  )
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    join(sessions, `${session}.jsonl`),
    entries.map((e) => `${JSON.stringify(e)}\n`).join(''),
  )

  await stopped(session, 'NOD: done | shipped')
  expect(status(id)).toBe('succeeded')
  const answers = new Map(ledger.decisions(id).map((d) => [d.id, d.answer]))
  expect([refused, letRun, withWords, subagents, again, screen].map((d) => answers.get(d))).toEqual(
    [
      '(denied in the terminal)',
      '(its turn ended)',
      '(denied in the terminal)',
      '(its turn ended)',
      '(its turn ended)',
      '(its turn ended)',
    ],
  )
  const heard = ledger.db
    .query<{ decisionId: number }, [number]>(
      "select decision_id as decisionId from notices where task_id = ? and event = 'answered'",
    )
    .all(id)
  expect(heard.map((n) => n.decisionId)).toEqual([refused, withWords])
})

// Makes <home>/notify take a while, so a hook that tells it something does too.
function slowNotify(): void {
  writeFileSync(join(home, 'notify'), '#!/bin/sh\nsleep 1\n')
  chmodSync(join(home, 'notify'), 0o755)
}

it('a turn that asks as a message opens the next one leaves its question to that turn', async () => {
  slowNotify()
  const id = started('fetch it', 'asked-told')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission')
  // As `nod tell` opens a turn while the hook tells notify the dialog closed (deliver).
  const tellWhileHeard = async (): Promise<void> => {
    await until(() => ledger.attempt(attempt.id).finishedAt !== null)
    ledger.setRunning(id, workspaceOf(home, ledger.get(id)))
    ledger.startAttempt({
      taskId: id,
      kind: 'followup',
      decisionId: null,
      sessionId: 'asked-told',
      prompt: 'do Y',
    })
  }
  await Promise.all([stopped('asked-told', 'NOD: question | Shall I?'), tellWhileHeard()])
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['permission'])
  expect(status(id)).toBe('running')
})

it('a task that succeeds leaves no decision open', async () => {
  const id = started('fetch it', 'all-closed')
  const first = ledger.openAttempt(id)
  if (first === null) throw new Error('no turn')
  // An older nod left a turn's permission decision open when the turn ended.
  ledger.ask(id, first.id, 'permission', 'Claude needs your permission')
  ledger.endAttempt(first.id, { outcome: 'needs_decision', summary: 'stopped', report: null })
  ledger.startAttempt({
    taskId: id,
    kind: 'followup',
    decisionId: null,
    sessionId: 'all-closed',
    prompt: 'go on',
  })
  await stopped('all-closed', 'NOD: done | fetched')
  expect(status(id)).toBe('succeeded')
  expect(ledger.openDecisions()).toEqual([])
})

it('a dropped retrospective ends before what it closes is heard of, so no message goes on in it', async () => {
  slowNotify()
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  const cwd = workspaceOf(home, ledger.get(retro))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(retro, cwd)
  const turn = ledger.startAttempt({
    taskId: retro,
    kind: 'start',
    decisionId: null,
    sessionId: 'dropped-retro',
    prompt: 'look back',
  })
  ledger.endAttempt(turn, { outcome: 'needs_decision', summary: 'rule A', report: null })
  ledger.ask(retro, turn, 'question', 'Which task?')
  const rule = ledger.ask(retro, turn, 'rule', 'Add it?')
  const dropping = drop(ledger, home, terminals, rule)
  await expect(tell(ledger, home, terminals, retro, 'look again')).rejects.toThrow(
    'which ended (declined)',
  )
  await dropping
  expect(ledger.attempts(retro)).toHaveLength(1)
  expect(status(retro)).toBe('cancelled')
})

it('an answer whose retrospective is dropped before it goes in leaves the task as the outcome has it', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  const cwd = workspaceOf(home, ledger.get(retro))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(retro, cwd)
  const turn = ledger.startAttempt({
    taskId: retro,
    kind: 'start',
    decisionId: null,
    sessionId: 'answered-retro',
    prompt: 'look back',
  })
  ledger.endAttempt(turn, { outcome: 'needs_decision', summary: 'rule A', report: null })
  const rule = ledger.ask(retro, turn, 'rule', 'Add it?')
  const question = ledger.ask(retro, turn, 'question', 'Which task?')
  // The person drops the rule once the answer has closed its question, as the answer looks for the
  // worker's terminal to send it (deliver).
  let dropping: Promise<unknown> | undefined
  const alive = spyOn(terminals, 'alive').mockImplementation(() => {
    dropping ??= drop(ledger, home, terminals, rule)
    return false
  })
  try {
    await expect(answer(ledger, home, terminals, question, 'the first', 'human')).rejects.toThrow(
      'which ended (declined)',
    )
    await dropping
  } finally {
    alive.mockRestore()
  }
  expect(ledger.retroFor(of)?.outcome).toBe('declined')
  expect(ledger.get(retro)).toMatchObject({ status: 'cancelled', error: null })
})

it('whatever ends a retrospective, its task ends as the outcome has it, and a turn after that changes nothing', async () => {
  const open = (retro: number, reason: string): number => {
    const d = ledger.decisions(retro).find((x) => x.answer === null && x.reason === reason)
    if (d === undefined) throw new Error(`no ${reason} decision`)
    return d.id
  }
  const ends: [RetroOutcome, (session: string, retro: number) => Promise<unknown>][] = [
    [
      'added',
      async (s, r) => {
        await stopped(s, 'NOD: done | rule A')
        await answer(ledger, home, terminals, open(r, 'rule'), 'yes', 'human')
      },
    ],
    [
      'declined',
      async (s, r) => {
        await stopped(s, 'NOD: done | rule A')
        await answer(ledger, home, terminals, open(r, 'rule'), 'no', 'human')
      },
    ],
    ['none', (s) => stopped(s, 'NOD: done | none')],
    ['todo', (s) => stopped(s, 'NOD: in {"title": "Fix nod"}\nNOD: done | none')],
    [
      'dropped',
      async (s, r) => {
        await stopped(s, 'NOD: question | Which task?')
        await drop(ledger, home, terminals, open(r, 'question'))
      },
    ],
  ]
  for (const [outcome, end] of ends) {
    const of = ledger.add({
      brief: 'x',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    const retro = ledger.addRetro(ledger.get(of), 'look back')
    const session = `ends-${outcome}`
    ledger.startAttempt({
      taskId: retro,
      kind: 'start',
      decisionId: null,
      sessionId: session,
      prompt: 'look back',
    })
    await end(session, retro)
    const want = RETRO_STATUS[outcome]
    expect([ledger.retroFor(of)?.outcome, status(retro)]).toEqual([outcome, want])
    // A turn typed into its terminal afterwards asks again: it is only recorded.
    await stopped(session, 'NOD: question | Still there?')
    expect(status(retro)).toBe(want)
    expect(ledger.decisions(retro).filter((d) => d.answer === null)).toEqual([])
    // It ended once. Its decisions, and the person's answers to them, are not ends.
    const notices = ledger.db
      .query<{ event: string }, [number]>(
        "select event from notices where task_id = ? and event not in ('decision', 'answered')",
      )
      .all(retro)
    expect(notices.map((n) => n.event)).toEqual([want])
  }
})

it('an answer to a decision already answered on a task gc collected brings nothing back', async () => {
  const id = started('first', 'answered-collected')
  await stopped('answered-collected', 'NOD: question | Which one?')
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  ledger.answer(decision.id, 'the first')
  ledger.succeed(id)
  const cwd = workspaceOf(home, ledger.get(id))
  const sessions = projectFolder(process.env.CLAUDE_CONFIG_DIR ?? '', cwd)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'answered-collected.jsonl'), '{}\n')
  await collect(ledger, home, terminals, { ids: [id] })
  await expect(answer(ledger, home, terminals, decision.id, 'the second', 'human')).rejects.toThrow(
    'already answered',
  )
  expect(existsSync(cwd)).toBe(false)
  expect(ledger.get(id).collectedAt).not.toBeNull()
})

it('a retrospective that proposes again replaces its open rule decision', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  const turn = (kind: 'start' | 'followup'): number =>
    ledger.startAttempt({
      taskId: retro,
      kind,
      decisionId: null,
      sessionId: 'again-session',
      prompt: 'look back',
    })
  turn('start')
  await stopped('again-session', 'NOD: done | rule A')
  // Told to propose another (deliver opens its turn), it reports one.
  turn('followup')
  await stopped('again-session', 'NOD: done | rule B')
  const [first, second] = ledger.decisions(retro)
  if (first === undefined || second === undefined) throw new Error('no rule decisions')
  expect(first.answer).toBe('(a newer proposal replaced it)')
  await expect(answer(ledger, home, terminals, first.id, 'yes', 'human')).rejects.toThrow(
    'already answered',
  )
  await answer(ledger, home, terminals, second.id, 'yes', 'human')
  expect(ledger.rules().map((r) => r.text)).toEqual(['rule B'])
  expect(ledger.retroFor(of)).toMatchObject({ rule: 'rule B', outcome: 'added' })
})

it('a yes to a rule decision adds the rule that decision proposed, and one left open once its retrospective ended only closes', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  ledger.startAttempt({
    taskId: retro,
    kind: 'start',
    decisionId: null,
    sessionId: 'race-session',
    prompt: 'look back',
  })
  await stopped('race-session', 'NOD: done | rule A')
  const decision = ledger.decisions(retro)[0]
  const retroId = ledger.get(retro).retroId
  if (decision === undefined || retroId === null) throw new Error('no rule decision')
  // A newer turn proposes another as this decision is answered.
  ledger.proposeRule(retroId, 'rule B')
  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  expect(ledger.rules().map((r) => r.text)).toEqual(['rule A'])
  expect(ledger.retroFor(of)).toMatchObject({ rule: 'rule A', outcome: 'added' })

  // Rule decisions left open once the retrospective ended, as an older nod left them: a yes or a
  // drop closes one, and nothing else changes.
  const late = ledger.ask(retro, decision.attemptId, 'rule', 'Add it?')
  const later = ledger.ask(retro, decision.attemptId, 'rule', 'Add it?')
  const before = status(retro)
  await answer(ledger, home, terminals, late, 'yes', 'human')
  await drop(ledger, home, terminals, later)
  expect([ledger.decision(late).answer, ledger.decision(later).answer]).toEqual([
    'yes',
    '(dropped)',
  ])
  expect(ledger.rules()).toHaveLength(1)
  expect(ledger.retroFor(of)?.outcome).toBe('added')
  expect(status(retro)).toBe(before)
})

it('a decision left open on a task that ended only closes, answered or dropped', async () => {
  const id = started('wait for the agents', 'ended-open')
  await stopped('ended-open', 'NOD: question | Wait for them?')
  const asked = ledger.decisions(id)[0]
  if (asked === undefined) throw new Error('no decision')
  // The task succeeded with the question left open, as an older nod left such questions.
  ledger.succeed(id)
  // What each returns tells the person their words went nowhere (`nod` prints it).
  expect(await answer(ledger, home, terminals, asked.id, 'never mind', 'human')).toBe(false)
  const again = ledger.ask(id, asked.attemptId, 'question', 'Still there?')
  ledger.succeed(id)
  expect(await drop(ledger, home, terminals, again)).toBe('closed')
  expect([ledger.decision(asked.id).answer, ledger.decision(again).answer]).toEqual([
    'never mind',
    '(dropped)',
  ])
  expect(status(id)).toBe('succeeded')
  expect(ledger.attempts(id)).toHaveLength(1)
  // No turn waited on them, so they stay out of the wait for answers.
  expect(ledger.stats().decisions.medianWaitSecs).toBeNull()

  // One left open on a task that was dropped.
  const first = ledger.ask(id, asked.attemptId, 'question', 'Which one?')
  const left = ledger.ask(id, asked.attemptId, 'question', 'Where?')
  ledger.drop(first)
  await answer(ledger, home, terminals, left, 'here', 'human')
  expect(ledger.decision(left).answer).toBe('here')
  expect(status(id)).toBe('cancelled')
  expect(ledger.attempts(id)).toHaveLength(1)
})

it("a trust decision answered in the worker's terminal closes once its first turn ends", async () => {
  const id = started('work here', 'trusted-there')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  ledger.ask(id, attempt.id, 'trust', 'Trust the repo?') // as awaitStart does
  await stopped('trusted-there', 'NOD: done | did it')
  expect(status(id)).toBe('succeeded')
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['trust', '(it got past the trust dialog)'],
  ])
})

it('a review that fails on a task dropped while its Stop hook checked leaves it dropped', async () => {
  const id = started('review-mute: write it', 'mute-dropped')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  // Dropped as its check runs, from a process of its own as `nod drop` in the person's shell: the
  // hook still reviews that turn, and its review gives no verdict.
  const decision = ledger.ask(id, attempt.id, 'question', 'Go on?')
  const cli = resolve(import.meta.dir, 'cli.ts')
  const nod = `NOD_HOME=${quote(home)} NOD_ACTOR=human ${quote(process.execPath)} ${quote(cli)}`
  ledger.db
    .query('update tasks set check_cmd = $check where id = $id')
    .run({ check: `${nod} drop d${decision} >/dev/null 2>&1`, id })
  await stopped('mute-dropped', 'NOD: done | did it')
  expect(ledger.decision(decision).answer).toBe('(dropped)')
  expect(status(id)).toBe('cancelled')
  expect(ledger.attempts(id).map((a) => a.outcome)).toEqual(['error'])
})

it("a permission answered in the worker's terminal leaves the task running into the retry its turn gets", async () => {
  const id = started('review-strict: write it', 'answered-retry')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission') // as onNotification does
  // Answered in the terminal; the turn ends, and the review sends it back.
  expect(await stopped('answered-retry', 'NOD: done | did it')).toContain('"block"')
  expect(status(id)).toBe('running')
  expect(ledger.openDecisions()).toEqual([])
})

it('a turn that ends after its retrospective did changes nothing of what became of it', async () => {
  const retroOf = (session: string): { of: number; retro: number } => {
    const of = ledger.add({
      brief: 'x',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    const retro = ledger.addRetro(ledger.get(of), 'look back')
    ledger.startAttempt({
      taskId: retro,
      kind: 'start',
      decisionId: null,
      sessionId: session,
      prompt: 'look back',
    })
    return { of, retro }
  }
  // Told to propose another, it is dropped while its Stop hook checks that turn.
  const dropped = retroOf('dropped-session')
  await stopped('dropped-session', 'NOD: done | rule A')
  const first = ledger.decisions(dropped.retro)[0]
  if (first === undefined) throw new Error('no rule decision')
  ledger.startAttempt({
    taskId: dropped.retro,
    kind: 'followup',
    decisionId: null,
    sessionId: 'dropped-session',
    prompt: 'propose another',
  })
  await drop(ledger, home, terminals, first.id)
  await stopped('dropped-session', 'NOD: done | rule B')
  expect(status(dropped.retro)).toBe('cancelled')
  expect(ledger.retroFor(dropped.of)).toMatchObject({ rule: 'rule A', outcome: 'declined' })
  expect(ledger.decisions(dropped.retro)).toHaveLength(1)

  // One a yes ended, whose terminal a person types into: it stops with no rule, then another.
  const added = retroOf('added-session')
  await stopped('added-session', 'NOD: done | rule A')
  const rule = ledger.decisions(added.retro)[0]
  if (rule === undefined) throw new Error('no rule decision')
  await answer(ledger, home, terminals, rule.id, 'yes', 'human')
  await stopped('added-session', 'NOD: done | none')
  await stopped('added-session', 'NOD: done | rule C')
  expect(status(added.retro)).toBe('succeeded')
  expect(ledger.retroFor(added.of)).toMatchObject({ rule: 'rule A', outcome: 'added' })
  expect(ledger.rules().map((r) => r.text)).toEqual(['rule A'])
  expect(ledger.decisions(added.retro)).toHaveLength(1)
})

it('what nod closes by itself is no answer, so the wait for answers leaves it out', async () => {
  started('wait', 'unanswered')
  await stopped('unanswered', 'NOD: question | Wait for them?')
  // Claude Code goes on by itself, which closes the question.
  await stopped('unanswered', 'NOD: question | Still waiting?')
  expect(ledger.stats().decisions).toEqual({ total: 2, open: 1, medianWaitSecs: null })
})

it('a rule decision takes no yes while its retrospective proposes again, and a yes closes what else is open', async () => {
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const retro = ledger.addRetro(ledger.get(of), 'look back')
  const turn = (kind: 'start' | 'followup', prompt: string): number =>
    ledger.startAttempt({
      taskId: retro,
      kind,
      decisionId: null,
      sessionId: 'busy-session',
      prompt,
    })
  turn('start', 'look back')
  await stopped('busy-session', 'NOD: done | rule A')
  const first = ledger.decisions(retro)[0]
  if (first === undefined) throw new Error('no rule decision')
  // Told to propose another (deliver opens its turn): the first proposal waits for what it says.
  turn('followup', 'propose another')
  await expect(answer(ledger, home, terminals, first.id, 'yes', 'human')).rejects.toThrow(
    'proposing again',
  )
  expect(ledger.rules()).toEqual([])
  expect(ledger.retroFor(of)?.outcome).toBeNull()
  // It asks something instead; a yes to the first proposal ends the retrospective, and the
  // question with it.
  await stopped('busy-session', 'NOD: question | Which task?')
  await answer(ledger, home, terminals, first.id, 'yes', 'human')
  expect(ledger.rules().map((r) => r.text)).toEqual(['rule A'])
  expect(ledger.decisions(retro).map((d) => [d.reason, d.answer])).toEqual([
    ['rule', 'yes'],
    ['question', '(the task succeeded without it)'],
  ])
})

test("a message that finds a turn gone with its terminal closes that turn's decisions", async () => {
  const id = started('fetch it', 'gone-dialog')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission')
  // The machine restarted with the dialog up, and a message comes before a tick finds the turn.
  await tell(ledger, home, terminals, id, 'do Y instead')
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['permission', '(the turn was cut off)'],
  ])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([
    ['start', 'error'],
    ['followup', null],
  ])
})

it('two ticks that find the same lost turn at once raise one decision for it', async () => {
  const id = started('fetch it', 'lost-twice')
  const attempt = ledger.openAttempt(id)
  if (attempt === null) throw new Error('no turn')
  // A permission dialog was up when the machine restarted.
  ledger.ask(id, attempt.id, 'permission', 'Claude needs your permission')
  const later = new Date(Date.now() + 60_000)
  const [a, b] = await Promise.all([
    lostTurns(ledger, home, terminals, later),
    lostTurns(ledger, home, terminals, later),
  ])
  expect([...a, ...b]).toEqual([id])
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['permission', '(the turn was cut off)'],
    ['interrupted', null],
  ])
})

test('an answer to a decision left open on a task gc collected brings its folder back first, as tell does', async () => {
  const id = started('first', 'collected-session')
  await stopped('collected-session', 'NOD: question | Which one?')
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  // The task errored with the decision left open, and gc collected it; Claude Code keeps its
  // conversation. (On a task that ended, an answer only closes the decision.)
  ledger.error(id, 'the review gave no verdict')
  const cwd = workspaceOf(home, ledger.get(id))
  const sessions = projectFolder(process.env.CLAUDE_CONFIG_DIR ?? '', cwd)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, 'collected-session.jsonl'), '{}\n')
  expect((await collect(ledger, home, terminals, { ids: [id] })).removed).toEqual([id])
  expect(existsSync(cwd)).toBe(false)

  await answer(ledger, home, terminals, decision.id, 'the second', 'human')
  expect(existsSync(cwd)).toBe(true)
  expect(ledger.get(id).collectedAt).toBeNull()
})

it('the review hears what the human told the worker in the middle of a turn, in order with the rest', () => {
  const id = ledger.add({
    brief: 'write it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const turn = (kind: 'start' | 'followup', prompt: string): number =>
    ledger.startAttempt({ taskId: id, kind, decisionId: null, sessionId: 's', prompt })
  const first = turn('start', 'write it')
  ledger.addMessage(id, first, 'use tabs')
  ledger.endAttempt(first, { outcome: 'needs_decision', summary: 'which file?', report: null })
  const second = turn('followup', 'in a.txt')
  ledger.addMessage(id, second, 'no,\nin b.txt')
  const brief = reviewBrief(ledger, ledger.get(id), 'NOD: done | ok', null)
  expect(brief).toContain(
    'What the human said later, in order; later words win:\n- use tabs\n- in a.txt\n- no, in b.txt\n',
  )
})

// What Claude Code's prompt hook passes for each message it takes in, a person's or one nod pasted,
// in the session `session`.
const prompted = (session: string, prompt: string): void =>
  void onPrompt(ledger, home, terminals, { session_id: session, prompt })
// As while a person is attached to a worker (nod attach), with the API error its last turn stopped
// on as `stalled`, '' for none.
const attachedWhile = (run: () => void, stalled = ''): void => {
  const attached = spyOn(terminals, 'attached').mockImplementation(() => true)
  const option = spyOn(terminals, 'option').mockImplementation((_, key) =>
    key === 'nod_stalled' ? stalled : '',
  )
  try {
    run()
  } finally {
    attached.mockRestore()
    option.mockRestore()
  }
}

it('a question a person answers by typing into the worker’s terminal closes with what they typed once that turn goes on, not as gone on without an answer', async () => {
  const events = listen()
  const id = started('ask first', 'answered-here')
  await stopped('answered-here', 'NOD: question | Which one?')
  attachedWhile(() => prompted('answered-here', 'the first,\nthen the second'))
  await stopped('answered-here', 'NOD: done | did both')
  expect(status(id)).toBe('succeeded')
  expect(ledger.decisions(id).map((d) => d.answer)).toEqual(['the first,\nthen the second'])
  // A to-do list that mirrors open decisions hears it closed so.
  const answered = events().filter((e) => e.event === 'answered')
  expect(answered.map((e) => e.decision?.answer)).toEqual(['the first,\nthen the second'])

  // They stop that turn with Escape before any hook of it runs, and say otherwise: the turn takes
  // it, and the question closes with all they typed, in order.
  const again = started('ask again', 'answered-twice')
  await stopped('answered-twice', 'NOD: question | Which one?')
  attachedWhile(() => {
    prompted('answered-twice', 'the first')
    prompted('answered-twice', 'no, the second')
  })
  await stopped('answered-twice', 'NOD: done | did the second')
  expect(ledger.decisions(again).map((d) => d.answer)).toEqual(['the first\nno, the second'])
})

it('what a worker told a task goes in with the first words of a later start as nod’s own, not kept again as typed', () => {
  const from = started('hand over', 'told-fresh', 'root-1')
  const id = started('write it', 'fresh-start', 'root-1')
  const first = ledger.lastAttempt(id)?.id ?? 0
  ledger.addMessage(id, first, 'see a.ts', from)
  ledger.failAttempt(first, 'session ended')
  ledger.startAttempt({
    taskId: id,
    kind: 'followup',
    decisionId: null,
    sessionId: 'fresh-start',
    prompt: 'go on',
  })
  attachedWhile(() => prompted('fresh-start', 'write it\n\nsee a.ts\n\ngo on'))
  expect(ledger.messages(id).map((m) => m.text)).toEqual(['see a.ts'])
})

it('what a person types into the worker’s terminal is kept once each, marked as typed, with what nod sent, and what nod pasted is not kept again', () => {
  const id = started('write it\nin full', 's')
  const first = ledger.lastAttempt(id)?.id ?? 0
  const sent = (prompt: string): number =>
    ledger.startAttempt({ taskId: id, kind: 'followup', decisionId: null, sessionId: 's', prompt })
  let mine = 0
  let third = 0
  attachedWhile(() => {
    // nod's first message, as Claude Code keeps a paste of several lines.
    prompted('s', '<pasted_content id="a1b2">\nwrite it\nin full\n</pasted_content id="a1b2">')
    // They stop that turn (Escape, no Stop) and say what to do instead.
    prompted('s', 'stop, write b.txt')
    ledger.endAttempt(first, { outcome: 'needs_decision', summary: 'which?', report: null })
    prompted('s', 'in a.txt')
    mine = ledger.openAttempt(id)?.id ?? 0
    prompted('s', 'no,\nin b.txt') // into their turn, still open
    ledger.endAttempt(mine, { outcome: 'needs_decision', summary: 'tabs?', report: null })
    third = sent('use tabs')
    prompted('s', 'use tabs')
    // nod told that turn more once an API error had stopped it: the paste starts a turn.
    ledger.addMessage(id, third, 'and spaces')
    prompted('s', 'and spaces')
    // Words of theirs that hold nod's.
    prompted('s', "don't use tabs")
  })
  // That turn stopped on an API error, and nod started Claude Code again with word to go on.
  attachedWhile(() => {
    prompted(
      's',
      'Your last turn stopped on an API error (overloaded_error), and nod started Claude Code again. Continue where you left off.',
    )
  }, 'overloaded_error')
  expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
    ['start', 'write it\nin full'],
    ['followup', '(typed into the terminal)\nin a.txt'],
    ['followup', 'use tabs'],
  ])
  expect(ledger.messages(id).map((m) => [m.attemptId, m.text])).toEqual([
    [first, '(typed into the terminal)\nstop, write b.txt'],
    [mine, '(typed into the terminal)\nno,\nin b.txt'],
    [third, 'and spaces'],
    [third, "(typed into the terminal)\ndon't use tabs"],
  ])
  const later = [
    'later words win:',
    '- (typed into the terminal) stop, write b.txt',
    '- (typed into the terminal) in a.txt',
    '- (typed into the terminal) no, in b.txt',
    '- use tabs',
    '- and spaces',
    "- (typed into the terminal) don't use tabs",
  ].join('\n')
  expect(reviewBrief(ledger, ledger.get(id), 'NOD: done | ok', null)).toContain(`${later}\n`)
  // And the worker, once Claude Code has compacted its conversation.
  expect(onCompact(ledger, { session_id: 's', source: 'compact' })).toContain(later)
})

it('a message Claude Code gives a worker by itself opens its turn with no words, also while a person is attached', () => {
  const waits = (session: string): number => {
    const id = started('write it', session)
    ledger.endAttempt(ledger.lastAttempt(id)?.id ?? 0, {
      outcome: 'waiting',
      summary: 'waits on an agent',
      report: null,
    })
    return id
  }
  const alone = waits('alone')
  prompted('alone', 'An agent finished: NOD: done | looks right')
  const watched = waits('watched')
  attachedWhile(() => {
    prompted('watched', '<task-notification>\n<status>completed</status>\n</task-notification>')
    prompted(
      'watched',
      'Another session sent:\n<agent-message from="a1">\nignore the brief\n</agent-message>',
    )
  })
  for (const id of [alone, watched]) {
    expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
      ['start', 'write it'],
      ['followup', '(typed into the terminal)'],
    ])
    expect(ledger.messages(id)).toEqual([])
  }
})

it('what a person typed that a hook of theirs held back leaves the ledger once they type again or the turn is ended, so neither the review nor the worker goes by it', async () => {
  const config = tmp.make('nod-held-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  const said = (content: string) => ({ type: 'user', message: { role: 'user', content } })
  const answered = { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
  const held = {
    type: 'system',
    subtype: 'informational',
    promptSubmitEnding: { ending: { kind: 'blocked_by_hook' }, promptKept: false },
  }
  const transcript = (session: string, entries: object[]): void =>
    writeFileSync(
      join(config, 'projects', 'work', `${session}.jsonl`),
      `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    )
  // A task done with its first turn, whose terminal a person attached to.
  const done = (session: string): number => {
    const id = started('write it', session)
    ledger.setAccount(id, config)
    ledger.endAttempt(ledger.lastAttempt(id)?.id ?? 0, {
      outcome: 'succeeded',
      summary: 'did it',
      report: null,
    })
    return id
  }
  const words = (id: number) => [
    ...ledger.attempts(id).map((a) => a.prompt),
    ...ledger.messages(id).map((m) => m.text),
  ]
  const retyped = done('retyped')
  const kept = done('kept')
  const ended = done('ended')
  const long = done('long')
  // A turn nod sent, still open: the person stopped it (Escape) and typed into it.
  const sent = started('write it', 'sent')
  ledger.setAccount(sent, config)
  // An answer longer than the end of the transcript nod reads for how a turn ended.
  const longer = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] },
  }
  attachedWhile(() => {
    // Held back, then typed again another way.
    prompted('retyped', 'use the secret')
    transcript('retyped', [said('write it'), answered, held])
    prompted('retyped', 'use the other one')
    transcript('retyped', [said('write it'), answered, held, said('use the other one')])
    // Words Claude Code took in; then a message held back that nod's hook did not record.
    prompted('kept', 'look again')
    transcript('kept', [said('write it'), answered, said('look again'), answered, held])
    prompted('kept', 'and in b.txt')
    transcript('kept', [
      said('write it'),
      answered,
      said('look again'),
      answered,
      held,
      said('and in b.txt'),
    ])
    // The same, the words taken in long before.
    prompted('long', 'look again')
    transcript('long', [said('write it'), answered, said('look again'), longer, held])
    prompted('long', 'and in b.txt')
    transcript('long', [
      said('write it'),
      answered,
      said('look again'),
      longer,
      held,
      said('and in b.txt'),
    ])
    // Held back, and no more typed.
    prompted('ended', 'use the secret')
    transcript('ended', [said('write it'), answered, held])
    prompted('sent', 'use the secret')
    transcript('sent', [said('write it'), held])
  })
  expect(ledger.messages(sent).map((m) => m.text)).toEqual([
    '(typed into the terminal)\nuse the secret',
  ])
  expect(words(retyped)).toEqual([
    'write it',
    '(typed into the terminal)',
    '(typed into the terminal)\nuse the other one',
  ])
  for (const id of [kept, long]) {
    expect(words(id)).toEqual([
      'write it',
      '(typed into the terminal)\nlook again',
      '(typed into the terminal)\nand in b.txt',
    ])
  }
  expect(reviewBrief(ledger, ledger.get(retyped), 'NOD: done | ok', null)).not.toContain('secret')
  // The tick ends a turn held back (here, as its terminal is gone), and takes the words held back
  // out of a turn nod sent, which stays open; the others are as they were.
  expect(await lostTurns(ledger, home, terminals, new Date())).toEqual([])
  expect(ledger.attempts(ended).at(-1)).toMatchObject({
    prompt: '(typed into the terminal)',
    error: 'a hook held the message back',
  })
  expect(ledger.messages(sent)).toEqual([])
  expect(ledger.openAttempt(sent)?.kind).toBe('start')
  for (const id of [retyped, kept, long]) expect(ledger.openAttempt(id)).not.toBeNull()
  expect(words(kept)).toHaveLength(3)
})

test('a message sent while a worker starts again after its Claude Code ended by itself waits for the new start', async () => {
  // An account command that takes a while, so each start of Claude Code does.
  const config = process.env.CLAUDE_CONFIG_DIR ?? ''
  setAccountRule(home, { command: `sleep 2; echo ${quote(config)}` })
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  endClaude(id) // a crash, a person's /exit, a tool that switches accounts outside nod
  await until(() => terminals.option(sessionName(id), 'nod_restarting') !== '')
  await tell(ledger, home, terminals, id, 'second')
  await reaches(id, 'succeeded')
  await until(() => entries('turn')[1])
  expect(entries('launch').map((l) => [l.resumed, l.prompt])).toEqual([
    [false, 'first'],
    [true, 'second'],
  ])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'second'])
}, 40_000)

test('a failed check whose Claude Code ended while nod checked it is a turn cut off, not a retry no one runs', async () => {
  const id = await add('review-slow review-strict: write it')
  await until(() => entries('review')[0])
  endClaude(id) // its Stop hook goes on checking
  const decision = await until(() => ledger.decisions(id).find((d) => d.reason === 'interrupted'))
  expect(decision.question).toContain('the failed check nod sent back reached no one')
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome, a.checkResult])).toEqual([
    ['start', 'succeeded', 'failed'],
    ['retry', 'error', null],
  ])
  expect(status(id)).toBe('needs_decision')
}, 30_000)

test('closing a worker whose Claude Code waits on a trust check to start again does not wait for that check', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  // Its next start finds nod's work folder not trusted yet, and Claude Code there never starts.
  rmSync(trustedFile(home, process.env.CLAUDE_CONFIG_DIR ?? null))
  writeFileSync(join(home, 'fake-slow-start'), '')
  endClaude(id)
  // The fake gives a session nod starts without an ID (the trust check's) the ID `missing`.
  await until(() => entries('launch').some((l) => l.sessionId === 'missing'))
  await terminals.close(sessionName(id))
  expect(terminals.alive(sessionName(id))).toBe(false)
}, 30_000)

test('a message for a worker showing a permission dialog waits for that decision, since its Enter would answer the dialog', async () => {
  const id = await add('need-permission')
  const decision = await until(() => ledger.decisions(id)[0])
  await expect(tell(ledger, home, terminals, id, 'also this')).rejects.toThrow(
    `answer permission decision d${decision.id} first`,
  )
  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual(['need-permission'])
  expect(ledger.attempts(id).map((a) => [a.kind, a.summary])).toEqual([['start', 'allowed']])
})

// Lets the fake's `slow`, `late` or `deaf` turn of task `id` end (fake-agent.ts).
const endTurn = (id: number): void =>
  writeFileSync(join(ledger.get(id).workspace ?? '', 'end.txt'), '')

test('a message told to a worker in the middle of a turn goes into that turn, and the review hears it', async () => {
  const id = await add('slow: write it')
  await until(() => entries('turn')[0])
  await tell(ledger, home, terminals, id, 'use tabs')
  endTurn(id)
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('heard').map((h) => h.message)).toEqual(['use tabs'])
  // In the conversation, so it does not go again.
  expect(entries('turn').map((t) => t.message)).toEqual(['slow: write it'])
  expect(ledger.attempts(id).map((a) => a.kind)).toEqual(['start'])
  expect(entries('review')[0]?.message).toContain('later words win:\n- use tabs\n')
}, 30_000)

test('a message told as the worker writes its last answer goes on as the next turn, from Claude Code’s queue, and only that turn is checked', async () => {
  const id = await add('late: write it')
  await until(() => entries('turn')[0])
  await tell(ledger, home, terminals, id, 'use tabs')
  endTurn(id)
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['late: write it', 'use tabs'])
  expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
    ['start', 'late: write it'],
    ['followup', 'use tabs'],
  ])
  expect(ledger.messages(id)).toEqual([])
  expect(entries('review')).toHaveLength(1)
}, 30_000)

test('a message Claude Code never had by the end of the turn it was told in is sent again, as the next turn', async () => {
  SENDING.waitMs = 200
  const id = await add('deaf: write it')
  await until(() => entries('turn')[0])
  await tell(ledger, home, terminals, id, 'use tabs')
  // It raised what kept the message out, which the turn's end closes.
  expect(status(id)).toBe('needs_decision')
  endTurn(id)
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['deaf: write it', 'use tabs'])
  expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
    ['start', 'deaf: write it'],
    ['followup', 'use tabs'],
  ])
  expect(entries('review')).toHaveLength(1)
  expect(ledger.decisions(id).map((d) => [d.reason, d.answeredAt])).toEqual([['stuck', null]])
}, 30_000)

// The worker's terminals with what nod types into them written down. `look`: what nod sees at each
// look at the screen, to bring a dialog up between two looks. `atKey`, `atSend`: what happens as it
// presses a key or pastes, which `atSend` does in place of pasting.
function typedInto(
  look: (screen: string, nth: number) => string = (screen) => screen,
  atKey: () => void = () => {},
  atSend: ((text: string) => Promise<unknown>) | null = null,
): { watched: Terminals; sent: string[]; keys: string[] } {
  const sent: string[] = []
  const keys: string[] = []
  let looks = 0
  const watched: Terminals = Object.assign(Object.create(terminals), {
    screen: (name: string) => look(terminals.screen(name), looks++),
    keys: (name: string, ...pressed: string[]) => {
      keys.push(...pressed)
      atKey()
      terminals.keys(name, ...pressed)
    },
    send: (name: string, text: string) => {
      sent.push(text)
      if (atSend !== null) void atSend(text)
      else terminals.send(name, text)
    },
  })
  return { watched, sent, keys }
}

// A worker done with its first turn, with `offer` on its screen (fake-agent.ts).
async function offered(offer: string, shows: string): Promise<number> {
  // The fake's dialog goes by keys, not time.
  SENDING.closeMs = 50
  writeFileSync(join(home, 'fake-offer'), offer)
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  await until(() => terminals.screen(sessionName(id)).includes(shows))
  return id
}
const COMPACT_OFFER = 'We recommend compacting earlier'
const UNKNOWN_DIALOG = 'A notice nod has not seen'

test('which screens show a dialog nod may close', () => {
  const footer = '↑/↓ choose · ←/→ change size · enter confirm · esc not now'
  expect(knownDialog(`text\n ${COMPACT_OFFER}\n ❯ Keep\n ${footer}\n\n`)).toBe(true)
  expect(knownDialog(`╭──╮\n│ ${COMPACT_OFFER}   │\n│ ${footer}   │\n╰──╯\n`)).toBe(true)
  expect(knownDialog(`✻ ${COMPACT_OFFER}\n${footer}\n`)).toBe(true)
  // Words a conversation quotes: in a block above the prompt, which no dialog leaves on the screen.
  const box = (prompt: string) => `────\n${prompt} \n────\n  auto mode on\n`
  const quoted = `⏺ It said:\n\n  ${COMPACT_OFFER}\n  ${footer}\n\n`
  expect(knownDialog(`${quoted}${box('>')}`)).toBe(false)
  expect(knownDialog(`${quoted}✻ Thinking…\n\n${box('❯')}`)).toBe(false)
  // Or in one line, without its footer, or out of the screen's end.
  expect(knownDialog(`The window said "${COMPACT_OFFER} … ${footer}"\n`)).toBe(false)
  expect(knownDialog(`${COMPACT_OFFER}\n`)).toBe(false)
  expect(knownDialog(`${footer}\n`)).toBe(false)
  expect(knownDialog(`${footer}\n${COMPACT_OFFER}\n`)).toBe(false)
  expect(knownDialog(`${COMPACT_OFFER}\n${footer}\n${'more\n'.repeat(12)}`)).toBe(false)
})

test('a message that goes in goes on, with no key pressed and nothing to decide', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  const { watched, sent, keys } = typedInto()
  await tell(ledger, home, watched, id, 'use tabs')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  expect(sent).toEqual(['use tabs'])
  expect(keys).toEqual([])
  expect(ledger.decisions(id)).toEqual([])
})

test('a compaction offer on the screen closes with Escape before the message, which goes once, with nothing picked', async () => {
  const id = await offered('', COMPACT_OFFER)
  const { watched, sent, keys } = typedInto()
  await tell(ledger, home, watched, id, 'use tabs')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(keys).toEqual(['Escape'])
  expect(sent).toEqual(['use tabs'])
  expect(entries('picked')).toEqual([])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'use tabs'])
  expect(ledger.decisions(id)).toEqual([])
})

test('a compaction offer that took the paste closes with as many Escapes as it refuses, and the message goes once more, once in', async () => {
  const id = await offered('', COMPACT_OFFER)
  // It comes up right after nod's look, as the turn before has just ended.
  const { watched, sent, keys } = typedInto((screen, nth) => (nth === 0 ? '' : screen))
  await tell(ledger, home, watched, id, 'use tabs')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(keys).toEqual(['Escape', 'Escape'])
  expect(sent).toEqual(['use tabs', 'use tabs'])
  expect(entries('picked')).toEqual([])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'use tabs'])
  expect(ledger.decisions(id)).toEqual([])
})

test('a compaction offer that stays is a decision, and no message is pasted into it', async () => {
  SENDING.closes = 1
  const id = await offered('', COMPACT_OFFER)
  // Its Escape never gets there.
  const { watched, sent, keys } = typedInto()
  const stays: Terminals = Object.assign(Object.create(watched), {
    keys: (_: string, ...pressed: string[]) => keys.push(...pressed),
  })
  await tell(ledger, home, stays, id, 'use tabs')
  expect(sent).toEqual([])
  expect(keys).toEqual(['Escape'])
  const [decision] = ledger.decisions(id)
  expect(decision?.reason).toBe('stuck')
  expect(decision?.question).toContain(COMPACT_OFFER)
  expect(status(id)).toBe('needs_decision')
})

test('a dialog nod does not know is a decision with its screen and the message, and the answer sends the message once', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  const { watched, sent, keys } = typedInto()
  await tell(ledger, home, watched, id, 'use tabs, and keep the old names')
  expect(keys).toEqual([])
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  expect(decision.reason).toBe('stuck')
  expect(decision.question).toContain(UNKNOWN_DIALOG)
  expect(decision.question).toContain('The message: use tabs, and keep the old names')
  expect(status(id)).toBe('needs_decision')
  // Its Enter would go to the same screen.
  await expect(tell(ledger, home, watched, id, 'more')).rejects.toThrow(
    `answer stuck decision d${decision.id} first`,
  )
  // The person clears it in the terminal: the stray paste's guard, then their pick.
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, watched, decision.id, 'yes', 'human')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(sent).toEqual(['use tabs, and keep the old names', 'use tabs, and keep the old names'])
  expect(entries('turn').map((t) => t.message)).toEqual([
    'first',
    'use tabs, and keep the old names',
  ])
  expect(ledger.decision(decision.id).answer).toBe('yes')
})

test('an answer beyond yes to a stuck message goes to the worker with the message', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, terminals, decision.id, 'and spaces after', 'human')
  await until(() => entries('turn').length === 3)
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual([
    'first',
    'use tabs',
    'Human decision: and spaces after',
  ])
})

test('an answer to a stuck message whose turn has closed starts a turn with the message, once', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  const decision = ledger.decisions(id)[0]
  const turn = ledger.openAttempt(id)
  if (decision === undefined || turn === null) throw new Error('no decision or turn')
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  // As when the person stops the turn: it ends with no Stop.
  ledger.endAttempt(turn.id, { outcome: 'needs_decision', summary: 'stopped', report: null })
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, terminals, decision.id, 'yes', 'human')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'use tabs'])
  expect(ledger.attempts(id).at(-1)?.prompt).toBe('use tabs')
})

test('an answer to a stuck message that went in meanwhile does not send it again', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  // Words it heard before count for nothing: they are the same as those of this one.
  const said = 'use tabs'
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const transcript = transcriptPath(process.env.CLAUDE_CONFIG_DIR ?? null, sessionId) ?? ''
  appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: said } })}\n`)
  const { watched, sent } = typedInto()
  await tell(ledger, home, watched, id, said)
  const decision = ledger.decisions(id)[0]
  if (decision === undefined) throw new Error('no decision')
  // Queued once the screen cleared.
  const queued = { type: 'queue-operation', operation: 'enqueue', content: said }
  appendFileSync(transcript, `${JSON.stringify(queued)}\n`)
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, watched, decision.id, 'yes', 'human')
  expect(sent).toEqual([said])
  expect(status(id)).toBe('running')
})

test('a stuck message that opened a turn which ends another way goes on as the next turn, once', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  const [decision] = ledger.decisions(id)
  expect(heldUp(ledger, id)).toContain(`d${decision?.id}`)
  // The person clears the screen and types something of their own, whose turn ends with a Stop.
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  terminals.send(sessionName(id), 'something else')
  await until(() => entries('turn')[2])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'something else', 'use tabs'])
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['stuck', '(its turn ended)'],
  ])
  expect(heldUp(ledger, id)).toBeNull()
}, 30_000)

test('two messages kept out by one screen are a decision each, and neither is lost', async () => {
  SENDING.waitMs = 1000
  const id = await offered('unknown', UNKNOWN_DIALOG)
  // The second comes as the first is pasted, so before anything is raised on the first.
  let second: Promise<void> = Promise.resolve()
  const { watched, sent } = typedInto(undefined, undefined, async (text) => {
    terminals.send(sessionName(id), text)
    if (text === 'first message') second = tell(ledger, home, watched, id, 'second message')
  })
  await tell(ledger, home, watched, id, 'first message')
  await second
  expect(sent).toEqual(['first message', 'second message'])
  const open = ledger.decisions(id)
  expect(open.map((d) => d.reason)).toEqual(['stuck', 'stuck'])
  const files = readdirSync(join(home, 'work')).filter((f) => f.startsWith(`.stuck-${id}-`))
  expect(files).toHaveLength(2)
  for (const file of files) expect(statSync(join(home, 'work', file)).mode & 0o777).toBe(0o600)
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
  SENDING.waitMs = USUAL_SENDING.waitMs
  const [first] = open
  if (first === undefined) throw new Error('no decision')
  await answer(ledger, home, terminals, first.id, 'yes', 'human')
  await until(() => entries('turn')[2])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual([
    'first',
    'first message',
    'second message',
  ])
}, 30_000)

test('forgetting a task takes its stuck messages, and no other task of a like number', () => {
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, '.stuck-7-a'), '{}')
  writeFileSync(join(work, '.stuck-71-a'), '{}')
  forgetStuck(home, 7)
  expect(existsSync(join(work, '.stuck-7-a'))).toBe(false)
  expect(existsSync(join(work, '.stuck-71-a'))).toBe(true)
  // A home that has no work yet has nothing to forget.
  forgetStuck(join(home, 'nothing here'), 7)
})

test('no to a permission while a message of that turn is stuck ends the turn with both reaching the worker', async () => {
  SENDING.waitMs = 100
  const id = await add('need-permission')
  const asked = await until(() => ledger.decisions(id).find((d) => d.reason === 'permission'))
  const turn = ledger.attempt(asked.attemptId)
  // A message whose paste got nowhere, as the dialog was still coming.
  const nowhere: Terminals = Object.assign(Object.create(terminals), { send: () => {} })
  const to: Worker = {
    ledger,
    home,
    terminals: nowhere,
    taskId: id,
    attemptId: turn.id,
    sessionId: turn.sessionId,
    gone: () => false,
  }
  expect(await sendWatched(to, 'use tabs')).toBe(false)
  await answer(ledger, home, terminals, asked.id, 'not that', 'human')
  await until(() => entries('turn')[1])
  expect(entries('turn')[1]?.message).toBe(
    'use tabs\n\nHuman decision: permission denied. not that',
  )
  expect(ledger.get(id).error).toBeNull()
  const stuck = ledger.decisions(id).filter((d) => d.reason === 'stuck')
  expect(stuck.map((d) => d.answer)).toEqual(['(its turn ended)'])
}, 30_000)

test('an answer goes in past another message stuck on the screen, and is a decision of its own if it stays out', async () => {
  SENDING.waitMs = 100
  const id = await add('ask-first')
  const asked = await until(() => ledger.decisions(id).find((d) => d.reason === 'question'))
  const turn = ledger.attempt(asked.attemptId)
  ledger.ask(id, turn.id, 'stuck', 'a message did not go in')
  // A message of nod's is refused, as its Enter would go to that screen.
  await expect(tell(ledger, home, terminals, id, 'more')).rejects.toThrow('answer stuck decision')
  await answer(ledger, home, terminals, asked.id, 'go ahead', 'human')
  await until(() => entries('turn')[1])
  expect(entries('turn')[1]?.message).toBe('Human decision: go ahead')
  expect(ledger.get(id).error).toBeNull()
}, 30_000)

test('messages left after one stays out of the turn a message opened in the hook wait for that turn', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'opening')
  const turn = ledger.openAttempt(id)
  if (turn === null) throw new Error('no turn')
  // Two more the screen took, told in that turn.
  ledger.addMessage(id, turn.id, 'one', null)
  ledger.addMessage(id, turn.id, 'two', null)
  // Its Stop: the words that opened it open the next turn, so the two have no turn of their own.
  const event = {
    session_id: turn.sessionId,
    last_assistant_message: 'NOD: done | did it',
    stop_hook_active: false,
  }
  const { watched, sent } = typedInto()
  await settle(ledger, home, watched, ledger.get(id), turn.id, event)
  const next = ledger.openAttempt(id)
  expect(next?.prompt).toBe('opening')
  // Those words stayed out again, so nothing more goes to that screen.
  expect(sent).toEqual(['opening'])
  const [one, two] = ledger.messages(id).filter((m) => m.text === 'one' || m.text === 'two')
  expect(one?.attemptId).toBe(next?.id)
  expect(two?.attemptId).toBe(next?.id)
})

// The person clears the fake's dialog in the terminal: the stray paste's guard, then their pick.
async function clearScreen(id: number): Promise<void> {
  terminals.keys(sessionName(id), 'Enter', 'Enter')
  await until(() => !terminals.screen(sessionName(id)).includes(UNKNOWN_DIALOG))
}

test('a compaction offer that comes back after the message went again is a decision, with no third paste', async () => {
  SENDING.waitMs = 200
  const id = await offered('', COMPACT_OFFER)
  const offer = terminals.screen(sessionName(id))
  // It shows after each paste until an Escape closes it. Past a third paste it stops, so a test that
  // fails ends.
  let back = false
  const { watched, sent, keys } = typedInto(
    (screen, nth) => (nth > 0 && back ? offer : screen),
    () => {
      back = false
    },
    async () => {
      back = sent.length < 3
    },
  )
  // The first look finds it closed.
  const first: Terminals = Object.assign(Object.create(watched), {
    screen: (name: string) => (sent.length === 0 ? '' : watched.screen(name)),
  })
  await tell(ledger, home, first, id, 'use tabs')
  expect(sent).toEqual(['use tabs', 'use tabs'])
  expect(keys).toEqual(['Escape'])
  expect(entries('picked')).toEqual([])
  expect(ledger.decisions(id).map((d) => d.reason)).toEqual(['stuck'])
})

test('yes with the screen as the decision showed it types nothing into it and asks again, and it goes once it is cleared', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  const { watched, sent, keys } = typedInto()
  await tell(ledger, home, watched, id, 'use tabs')
  const [first] = ledger.decisions(id)
  if (first === undefined) throw new Error('no decision')
  sent.length = 0
  await answer(ledger, home, watched, first.id, 'yes', 'human')
  expect(sent).toEqual([])
  expect(keys).toEqual([])
  const again = ledger.decisions(id)[1]
  if (again === undefined) throw new Error('not asked again')
  expect(again.reason).toBe('stuck')
  expect(again.answer).toBeNull()
  expect(again.question).toContain('The message: use tabs')
  expect(heldUp(ledger, id)).toContain(`d${again.id}`)
  await clearScreen(id)
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, watched, again.id, 'yes', 'human')
  await until(() => entries('turn')[1])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(sent).toEqual(['use tabs'])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'use tabs'])
})

test('what a person says beyond yes stays with the turn when the message stays out again', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  const [first] = ledger.decisions(id)
  if (first === undefined) throw new Error('no decision')
  await answer(ledger, home, terminals, first.id, 'and spaces after', 'human')
  const again = ledger.decisions(id)[1]
  if (again === undefined) throw new Error('not asked again')
  await clearScreen(id)
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, terminals, again.id, 'yes', 'human')
  await until(() => entries('turn').length === 3)
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual([
    'first',
    'use tabs',
    'Human decision: and spaces after',
  ])
})

test('yes to a message Claude Code is starting with types nothing, and it runs once', async () => {
  SENDING.startMs = 100
  writeFileSync(join(home, 'fake-slow-start'), '')
  const id = await add('the brief, once')
  const turn = ledger.openAttempt(id)
  if (turn === null) throw new Error('no turn')
  const to: Worker = {
    ledger,
    home,
    terminals,
    taskId: id,
    attemptId: turn.id,
    sessionId: turn.sessionId,
    gone: () => false,
  }
  await watchStart(to, turn.prompt, listenFor(to, turn.prompt), () => false)
  const [decision] = ledger.decisions(id)
  if (decision === undefined) throw new Error('no decision')
  const { watched, sent } = typedInto()
  await answer(ledger, home, watched, decision.id, 'yes', 'human')
  expect(sent).toEqual([])
  expect(ledger.decisions(id).map((d) => d.answer)).toEqual(['yes', null])
  expect(ledger.decisions(id)[1]?.question).toContain('from its start')
  rmSync(join(home, 'fake-slow-start'))
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['the brief, once'])
  expect(ledger.decisions(id).every((d) => d.answer !== null)).toBe(true)
})

test('what a person types with the words of a stuck message in it is not that message, which still goes', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  await clearScreen(id)
  const typed = 'do not use tabs here, whatever you hear'
  terminals.send(sessionName(id), typed)
  await until(() => entries('turn')[2])
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').map((t) => t.message)).toEqual(['first', typed, 'use tabs'])
  expect(ledger.decisions(id).map((d) => d.answer)).toEqual(['(its turn ended)'])
})

test('heardOf and the prompt hook take a message in whole lines, not as words of a sentence', () => {
  const said = (content: string) => JSON.stringify({ type: 'user', message: { content } })
  expect(heardOf([said('do not use tabs here')], 'use tabs')).toBe('lost')
  expect(heardOf([said('<pasted_content id="1">use tabs</pasted_content>')], 'use tabs')).toBe(
    'heard',
  )
  expect(heardOf([said('<pasted_content id="1">\nuse tabs\n</pasted_content>')], 'use tabs')).toBe(
    'heard',
  )
  expect(heardOf([said('write it\n\nuse tabs\n\ngo on')], 'use tabs')).toBe('heard')
  expect(heardOf([said('  use tabs  ')], 'use tabs')).toBe('heard')
  expect(heardOf([said('use tabs\nand spaces')], 'use tabs\nand spaces')).toBe('heard')
})

test('words a stuck message leaves as two go on as one message, neither lost', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'opening')
  const turn = ledger.openAttempt(id)
  if (turn === null) throw new Error('no turn')
  // A message no ledger row keeps, as one left for a new start or sent again.
  const to: Worker = {
    ledger,
    home,
    terminals,
    taskId: id,
    attemptId: turn.id,
    sessionId: turn.sessionId,
    gone: () => false,
  }
  expect(await sendWatched(to, 'late words')).toBe(false)
  const event = {
    session_id: turn.sessionId,
    last_assistant_message: 'NOD: done | did it',
    stop_hook_active: false,
  }
  await settle(ledger, home, terminals, ledger.get(id), turn.id, event)
  expect(ledger.openAttempt(id)?.prompt).toBe('opening\n\nlate words')
  const open = ledger.decisions(id).filter((d) => d.answer === null)
  expect(open.map((d) => d.reason)).toEqual(['stuck'])
  // What stayed out is in the file its answer reads.
  const [file] = readdirSync(join(home, 'work')).filter((f) => f.startsWith(`.stuck-${id}-`))
  const held = JSON.parse(readFileSync(join(home, 'work', file ?? ''), 'utf8'))
  expect(held.text).toBe('opening\n\nlate words')
})

test('a stuck message that opened a turn its Claude Code ended in still goes, whole, once', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  const long = `${'x'.repeat(300)} the end of it`
  await tell(ledger, home, terminals, id, long)
  endClaude(id)
  const cut = await until(
    () => ledger.decisions(id).find((d) => d.reason === 'interrupted' && d.answer === null),
    20_000,
  )
  expect(cut.question).toContain('A message that had not gone in')
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, terminals, cut.id, 'carry on', 'human')
  await until(() => entries('turn').some((t) => t.message === long), 20_000)
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').filter((t) => t.message === long)).toHaveLength(1)
}, 60_000)

test('a stuck message told into a turn its Claude Code ended in still goes, once', async () => {
  SENDING.waitMs = 200
  const id = await add('deaf: write it')
  await until(() => entries('turn')[0])
  await tell(ledger, home, terminals, id, 'use tabs')
  expect(status(id)).toBe('needs_decision')
  endClaude(id)
  const cut = await until(
    () => ledger.decisions(id).find((d) => d.reason === 'interrupted' && d.answer === null),
    20_000,
  )
  SENDING.waitMs = USUAL_SENDING.waitMs
  await answer(ledger, home, terminals, cut.id, 'carry on', 'human')
  await until(() => entries('turn').some((t) => t.message === 'use tabs'), 20_000)
  await reaches(id, 'succeeded')
  await settled(id)
  expect(entries('turn').filter((t) => t.message === 'use tabs')).toHaveLength(1)
}, 60_000)

test('a stuck message the prompt hook sees go in closes its decision, and another message does not', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'use tabs')
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const event = (prompt: string) => ({ session_id: sessionId, prompt })
  await onPrompt(ledger, home, terminals, event('<task-notification>a job</task-notification>'))
  expect(ledger.decisions(id)[0]?.answer).toBeNull()
  await onPrompt(ledger, home, terminals, event('<pasted_content id="1">use tabs</pasted_content>'))
  expect(ledger.decisions(id)[0]?.answer).toBe('(the message went in)')
  expect(status(id)).toBe('running')
})

test('words that show as the dialog closes do not go twice', async () => {
  const id = await offered('', COMPACT_OFFER)
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const transcript = transcriptPath(process.env.CLAUDE_CONFIG_DIR ?? null, sessionId) ?? ''
  const queued = { type: 'queue-operation', operation: 'enqueue', content: 'use tabs' }
  const { watched, sent, keys } = typedInto(
    (screen, nth) => (nth === 0 ? '' : screen),
    () => {
      if (keys.length === 1) appendFileSync(transcript, `${JSON.stringify(queued)}\n`)
    },
  )
  await tell(ledger, home, watched, id, 'use tabs')
  expect(sent).toEqual(['use tabs'])
  expect(ledger.decisions(id)).toEqual([])
})

test('a message with tabs is seen as Claude Code keeps it, a paste with four spaces for each, and goes once', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const transcript = transcriptPath(process.env.CLAUDE_CONFIG_DIR ?? null, sessionId) ?? ''
  const queued = (content: string) => ({ type: 'queue-operation', operation: 'enqueue', content })
  const { watched, sent, keys } = typedInto(undefined, undefined, async (text) =>
    appendFileSync(transcript, `${JSON.stringify(queued(text.replaceAll('\t', '    ')))}\n`),
  )
  await tell(ledger, home, watched, id, 'if x:\n\treturn y')
  expect(sent).toEqual(['if x:\n\treturn y'])
  expect(keys).toEqual([])
  expect(ledger.decisions(id)).toEqual([])
})

test('heardOf reads tabs and four spaces alike, on either side, and a backslash and a t as those', () => {
  const said = (content: string) => JSON.stringify({ type: 'user', message: { content } })
  expect(heardOf([said('a    b')], 'a\tb')).toBe('heard')
  expect(heardOf([said('a\tb')], 'a\tb')).toBe('heard')
  expect(heardOf([said('a\tb')], 'a    b')).toBe('heard')
  expect(heardOf([said('a\\tb')], 'a\tb')).toBe('lost')
  expect(heardOf([said('a\\tb')], 'a\\tb')).toBe('heard')
  expect(heardOf([said('a b')], 'a\tb')).toBe('lost')
  expect(promptMark('<pasted_content id="1">\na    b\n</pasted_content>')).toBe(promptMark('a\tb'))
})

test('a stuck message with tabs the prompt hook sees go in closes its decision', async () => {
  SENDING.waitMs = 200
  const id = await offered('unknown', UNKNOWN_DIALOG)
  await tell(ledger, home, terminals, id, 'if x:\n\treturn y')
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const prompt = '<pasted_content id="1">if x:\n    return y</pasted_content>'
  await onPrompt(ledger, home, terminals, { session_id: sessionId, prompt })
  expect(ledger.decisions(id)[0]?.answer).toBe('(the message went in)')
})

test('a message the prompt hook has seen goes in, with its transcript still to come', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  const { sessionId } = ledger.attempts(id)[0] ?? { sessionId: '' }
  const prompt = 'use tabs\nand spaces'
  const wrapped = `<pasted_content id="1">\n${prompt}\n</pasted_content>`
  const { watched, sent, keys } = typedInto(undefined, undefined, () =>
    onPrompt(ledger, home, terminals, { session_id: sessionId, prompt: wrapped }),
  )
  await tell(ledger, home, watched, id, prompt)
  expect(sent).toEqual([prompt])
  expect(keys).toEqual([])
  expect(ledger.decisions(id)).toEqual([])
})

test('a message Claude Code started with that no screen lets through is a decision, once nothing holds the start', async () => {
  SENDING.startMs = 100
  writeFileSync(join(home, 'fake-slow-start'), '')
  const id = await add('stuck as it starts')
  const turn = ledger.openAttempt(id)
  if (turn === null) throw new Error('no turn')
  const to: Worker = {
    ledger,
    home,
    terminals,
    taskId: id,
    attemptId: turn.id,
    sessionId: turn.sessionId,
    gone: () => false,
  }
  const heard = listenFor(to, turn.prompt)
  let holds = 6
  await watchStart(to, turn.prompt, heard, () => holds-- > 0)
  expect(holds).toBeLessThan(0)
  const [decision] = ledger.decisions(id)
  expect(decision?.reason).toBe('stuck')
  expect(decision?.question).toContain('The message: stuck as it starts')
  // One gone by then raises nothing more.
  await watchStart(
    { ...to, gone: () => true },
    turn.prompt,
    () => false,
    () => false,
  )
  expect(ledger.decisions(id)).toHaveLength(1)
  // A command shows no words to wait for.
  await watchStart(
    to,
    '/some-skill go',
    () => false,
    () => false,
  )
  expect(ledger.decisions(id)).toHaveLength(1)
})

test('a message that comes once the Stop hook has started on a turn goes on in a turn of its own', async () => {
  // A notify that takes a while, so the hook does before it closes the turn.
  writeFileSync(join(home, 'notify'), '#!/bin/sh\nsleep 3\n')
  chmodSync(join(home, 'notify'), 0o755)
  const id = await add('need-permission')
  await until(() => ledger.decisions(id)[0])
  // A person attached to the worker answers the dialog there.
  const name = sessionName(id)
  terminals.keys(name, 'Enter')
  await until(() => terminals.option(name, 'nod_settling') !== '')
  await tell(ledger, home, terminals, id, 'also this')
  await until(() => ledger.attempts(id).length === 2 && status(id) === 'succeeded')
  expect(ledger.attempts(id).map((a) => [a.kind, a.prompt])).toEqual([
    ['start', 'need-permission'],
    ['followup', 'also this'],
  ])
}, 40_000)

test('a message sent while a worker cut off in a turn starts again goes on in that turn, with nothing to decide', async () => {
  const id = await add('hang until ended')
  await until(() => entries('turn')[0])
  endClaude(id)
  await until(() => terminals.option(sessionName(id), 'nod_restarting') !== '')
  await tell(ledger, home, terminals, id, 'hang on')
  await until(() => entries('turn')[1])
  await Bun.sleep(6000) // past the moment the new Claude Code counts as up
  expect(entries('turn').map((t) => t.message)).toEqual(['hang until ended', 'hang on'])
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.attempts(id).map((a) => [a.kind, a.outcome])).toEqual([['start', null]])
}, 30_000)

test('a message for a worker whose Claude Code has just ended waits for the next start, even before it is marked', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  // As in the moment after Claude Code ends, before keepWorker sets nod_restarting: the Claude
  // Code it recorded is gone.
  const gone = Bun.spawnSync(['true']).pid
  terminals.setOption(sessionName(id), 'nod_claude', String(gone))
  await tell(ledger, home, terminals, id, 'second')
  await Bun.sleep(2000)
  expect(entries('turn').map((t) => t.message)).toEqual(['first'])
  expect(readFileSync(join(home, 'work', `.prompt-${id}`), 'utf8')).toBe('second')
}, 30_000)

test('a message for a worker waiting on its trust decision waits for that decision, since its Enter would answer the trust dialog', async () => {
  writeFileSync(join(home, 'fake-untrusted'), '')
  const id = ledger.add({
    brief: 'work here',
    repo: newRepo(),
    branch: 'feat/told',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  const trust = ledger.decisions(id)[0]
  if (trust?.reason !== 'trust') throw new Error('no trust decision')
  await expect(tell(ledger, home, terminals, id, 'also this')).rejects.toThrow(
    `answer trust decision d${trust.id} first`,
  )
  await answer(ledger, home, terminals, trust.id, 'yes', 'human')
  await reaches(id, 'succeeded')
  expect(entries('turn').map((t) => t.message)).toEqual([
    expect.stringMatching(/^work here\n\nYour branch starts at commit [0-9a-f]{40}\.$/),
  ])
}, 30_000)

test('a message for a worker whose trust dialog is up waits for that decision, even with no turn open', async () => {
  writeFileSync(join(home, 'fake-untrusted'), '')
  const id = ledger.add({
    brief: 'work here',
    repo: newRepo(),
    branch: 'feat/later',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  await startTask(ledger, home, terminals, id)
  const trust = ledger.decisions(id)[0]
  if (trust?.reason !== 'trust') throw new Error('no trust decision')
  // As when a first start gave up on the dialog and a later one shows it again: its turn closed.
  ledger.failAttempt(trust.attemptId, 'Claude Code did not start')
  await expect(tell(ledger, home, terminals, id, 'also this')).rejects.toThrow(
    `answer trust decision d${trust.id} first`,
  )
  expect(terminals.screen(sessionName(id))).toContain('Yes, I trust this folder')
}, 30_000)

test('a Claude Code this process may not signal counts as running, so a message goes in', async () => {
  const id = await add('first')
  await reaches(id, 'succeeded')
  await settled(id)
  // pid 1 runs as root: signalling it fails with EPERM, as for any process outside a sandbox.
  terminals.setOption(sessionName(id), 'nod_claude', '1')
  await tell(ledger, home, terminals, id, 'second')
  await reaches(id, 'succeeded')
  await until(() => entries('turn')[1])
  expect(entries('turn').map((t) => t.message)).toEqual(['first', 'second'])
}, 30_000)
