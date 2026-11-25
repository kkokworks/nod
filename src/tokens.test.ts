import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { reviewBrief } from './review'
import { taskTokens, tokenLines, tokensSince } from './tokens'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')
const DAY = 86_400_000
const SECRET = 'words of the conversation'
const NEW = {
  brief: 'some task',
  repo: null,
  branch: null,
  checkCmd: null,
  model: null,
  after: [],
  issue: null,
}

// A nod home of its own, with the account its workers run as.
function setup() {
  const home = tmp.make('nod-tokens-')
  const config = tmp.make('nod-tokens-claude-')
  const ledger = new Ledger(home)
  // A task in a turn of the session `session-<task>`.
  const start = (): number => {
    const id = ledger.add(NEW)
    ledger.setRunning(id, home)
    ledger.setAccount(id, config)
    const turn = { kind: 'start' as const, decisionId: null, prompt: 'some task' }
    ledger.startAttempt({ ...turn, taskId: id, sessionId: `session-${id}` })
    return id
  }
  // Writes a transcript, its path from the folder Claude Code keeps those of the workspace in.
  const keep = (path: string, ...rows: object[]): string => {
    const file = join(config, 'projects', 'work', path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
    return file
  }
  const count = (id: number) => taskTokens(ledger, home, ledger.get(id))
  return { home, config, ledger, start, keep, count }
}

// A row of a response, as Claude Code keeps one for each of its blocks. `size` gives its usage:
// input 1, output 10, cache write 100 and cache read 1000 times it.
function says(id: string, model: string, size: number, at = new Date()): object {
  return {
    type: 'assistant',
    timestamp: at.toISOString(),
    message: {
      id,
      model,
      content: [{ type: 'text', text: SECRET }],
      usage: {
        input_tokens: size,
        output_tokens: 10 * size,
        cache_creation_input_tokens: 100 * size,
        cache_read_input_tokens: 1000 * size,
      },
    },
  }
}
const user = (content: unknown): object => ({ type: 'user', message: { role: 'user', content } })
// The result of the tool call that started a subagent.
const started = (agentId: string): object => ({
  ...user([{ type: 'tool_result', tool_use_id: 't', content: SECRET }]),
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
})
const use = (calls: number, size: number) => ({
  calls,
  output: 10 * size,
  cacheWrite: 100 * size,
  cacheRead: 1000 * size,
  input: size,
})

test('a task’s tokens are counted by part and model: a response once for its ID, what Claude Code wrote in place of one not at all, the subagents in inner folders too, and the reviews beside the worker’s transcript', () => {
  const { ledger, start, keep, count } = setup()
  const id = start()
  const s = `session-${id}`
  keep(
    `${s}.jsonl`,
    user(SECRET),
    says('m1', 'big', 1),
    says('m1', 'big', 1),
    started('a1'),
    started('a2'),
    says('m2', 'big', 2),
    says('m3', 'small', 4),
    says('m4', '<synthetic>', 8),
    // A server's tool that gives something like a subagent's ID.
    started('\x1b[2Ja9'),
    // No response of the model's, whatever it holds.
    { type: 'attachment', attachment: { usage: { input_tokens: 7 } }, message: { id: 'm9' } },
  )
  // A subagent's own, one of them in a folder further in, and one that holds a response of the
  // worker's, which stays the worker's.
  keep(`${s}/subagents/agent-a1.jsonl`, says('m2', 'big', 2), says('m5', 'small', 16))
  keep(`${s}/subagents/workflows/w1/agent-a2.jsonl`, says('m6', 'big', 32))
  keep(`${s}/subagents/agent-a1.meta.json`, says('m7', 'big', 64))
  // Beside it: its reviews, one as nod wrote task numbers before and one with a subagent; another
  // task's review, another session that talks about one, and a review a hook blocked.
  const brief = reviewBrief(ledger, ledger.get(id), 'the report', null)
  keep('r1.jsonl', { type: 'queue-operation', content: brief }, user(brief), says('m8', 'big', 128))
  keep(
    'r2.jsonl',
    user(`Independent review of nod task #${id}. Someone else`),
    says('m9', 'big', 256),
    started('a3'),
  )
  keep('r2/subagents/agent-a3.jsonl', says('m10', 'small', 512))
  keep('r3.jsonl', user(`Independent review of nod task n${id}1. Someone`), says('x1', 'big', 1024))
  keep('r4.jsonl', user([{ type: 'text', text: 'hi' }]), user(brief), says('x2', 'big', 1024))
  keep('r5.jsonl', { type: 'system', content: brief })

  expect(count(id)).toEqual({
    tokens: {
      worker: { big: use(2, 3), small: use(1, 4) },
      subagents: { small: use(1, 16), big: use(1, 32) },
      review: { big: use(2, 384), small: use(1, 512) },
    },
    missing: [],
  })
  expect(tokenLines(count(id))).toEqual([
    'tokens worker big: calls 2, output 30, cache write 300, cache read 3,000, input 3',
    'tokens worker small: calls 1, output 40, cache write 400, cache read 4,000, input 4',
    'tokens subagents small: calls 1, output 160, cache write 1,600, cache read 16,000, input 16',
    'tokens subagents big: calls 1, output 320, cache write 3,200, cache read 32,000, input 32',
    'tokens review big: calls 2, output 3,840, cache write 38,400, cache read 384,000, input 384',
    'tokens review small: calls 1, output 5,120, cache write 51,200, cache read 512,000, input 512',
  ])
})

test('a model named as what every object has is counted as any other', () => {
  const { start, keep, count } = setup()
  const id = start()
  keep(`session-${id}.jsonl`, says('m1', 'constructor', 1), says('m2', '__proto__', 2))
  expect(tokenLines(count(id)).slice(0, 2)).toEqual([
    'tokens worker constructor: calls 1, output 10, cache write 100, cache read 1,000, input 1',
    'tokens worker __proto__: calls 1, output 20, cache write 200, cache read 2,000, input 2',
  ])
  expect(Object.keys(Object.prototype)).toEqual([])
})

test('what no transcript is left of is said, never counted as 0', () => {
  const { ledger, start, keep, count, config } = setup()
  const id = start()
  const s = `session-${id}`
  const gone = [
    'tokens worker: no transcript',
    'tokens subagents: no transcript',
    'tokens review: no transcript',
  ]
  // Claude Code has deleted it all.
  expect(count(id).tokens).toEqual({ worker: null, subagents: null, review: null })
  expect(tokenLines(count(id))).toEqual([...gone, `tokens: no transcript of session ${s}`])
  // Only a worker that started no subagent and was not reviewed, or not left one.
  keep(`${s}.jsonl`, user(SECRET), { ...says('m1', 'big', 1), timestamp: 'cut' })
  expect(tokenLines(count(id))).toEqual([
    'tokens worker big: calls 1, output 10, cache write 100, cache read 1,000, input 1',
    'tokens subagents: no calls',
    'tokens review: no transcript',
  ])
  // It started two, and one, then both, are gone.
  const subagent = keep(`${s}/subagents/agent-a1.jsonl`, says('m2', 'big', 2))
  keep(`${s}.jsonl`, user(SECRET), started('a1'), started('a2'), started('a2'))
  expect(tokenLines(count(id))).toEqual([
    'tokens worker: no calls',
    'tokens subagents big: calls 1, output 20, cache write 200, cache read 2,000, input 2',
    'tokens review: no transcript',
    'tokens: no transcript of subagent a2',
  ])
  // One a subagent started is told as well.
  keep(`${s}/subagents/agent-a1.jsonl`, says('m2', 'big', 2), started('a3'))
  expect(count(id).missing).toEqual(['subagent a2', 'subagent a3'])
  rmSync(subagent)
  expect(tokenLines(count(id))).toEqual([
    'tokens worker: no calls',
    'tokens subagents: no transcript',
    'tokens review: no transcript',
    'tokens: no transcript of subagent a1, subagent a2',
  ])
  // A review's is gone, the review's own still there.
  const brief = reviewBrief(ledger, ledger.get(id), 'the report', null)
  keep('r1.jsonl', user(brief), started('a4'), says('m3', 'big', 4))
  keep(`${s}.jsonl`, user(SECRET))
  expect(tokenLines(count(id))).toEqual([
    'tokens worker: no calls',
    'tokens subagents: no calls',
    'tokens review big: calls 1, output 40, cache write 400, cache read 4,000, input 4',
    'tokens: no transcript of subagent a4',
  ])
  // A task of two sessions, one of which is left: the other may have started subagents.
  const attempt = ledger.openAttempt(id)?.id ?? 0
  ledger.endAttempt(attempt, { outcome: 'succeeded', summary: 'did it', report: null })
  const turn = { kind: 'start' as const, decisionId: null, prompt: 'again' }
  ledger.startAttempt({ ...turn, taskId: id, sessionId: 'session-2nd' })
  expect(tokenLines(count(id))).toEqual([
    'tokens worker: no calls',
    'tokens subagents: no transcript',
    'tokens review big: calls 1, output 40, cache write 400, cache read 4,000, input 4',
    'tokens: no transcript of session session-2nd, subagent a4',
  ])
  // No account's folder at all.
  rmSync(join(config, 'projects'), { recursive: true })
  expect(tokenLines(count(id)).slice(0, 3)).toEqual(gone)
})

test('the last days’ tokens are those of the calls made then, of every task together, with the tasks of a turn then that some transcript is missing of', () => {
  const { home, config, ledger, start, keep } = setup()
  const since = new Date(Date.now() - 7 * DAY)
  const before = new Date(since.getTime() - 1)
  const turnAt = (id: number, startedAt: Date, finishedAt: Date | null): void => {
    ledger.db
      .query('update attempts set started_at = $start, finished_at = $end where task_id = $id')
      .run({ id, start: startedAt.toISOString(), end: finishedAt?.toISOString() ?? null })
  }
  // A turn that began before then and goes on, and one of then.
  const one = start()
  turnAt(one, before, null)
  const s = `session-${one}`
  keep(`${s}.jsonl`, says('m1', 'big', 1, before), says('m2', 'big', 2, since), started('a1'))
  keep(`${s}/subagents/agent-a1.jsonl`, says('m3', 'small', 4, before), says('m4', 'small', 8))
  const two = start()
  turnAt(two, before, since)
  keep(`session-${two}.jsonl`, says('m5', 'big', 16))
  // A turn that ended before then, reviewed since, and the task ended with it.
  const reviewed = start()
  turnAt(reviewed, before, before)
  ledger.succeed(reviewed)
  keep(`session-${reviewed}.jsonl`, says('m6', 'big', 32, before))
  const brief = reviewBrief(ledger, ledger.get(reviewed), 'the report', null)
  keep('r1.jsonl', user(brief), says('m7', 'small', 64, since))
  // With no transcript: a task of then, and three with no turn then: an earlier one, one whose turn
  // was left open as it ended, and one that has not started.
  const gone = start()
  turnAt(start(), before, before)
  const left = start()
  turnAt(left, before, null)
  ledger.succeed(left)
  ledger.db
    .query('update tasks set finished_at = $at where id = $id')
    .run({ id: left, at: before.toISOString() })
  ledger.add({ ...NEW, after: [one] })
  // One that cannot be read.
  const broken = start()
  mkdirSync(join(config, 'projects', 'other', `session-${broken}.jsonl`), { recursive: true })

  const said: unknown[] = []
  const stderr = spyOn(console, 'error').mockImplementation((line) => void said.push(line))
  try {
    expect(tokensSince(ledger, home, since)).toEqual({
      since: since.toISOString(),
      worker: { big: use(2, 18) },
      subagents: { small: use(1, 8) },
      review: { small: use(1, 64) },
      missing: [`n${gone}`, `n${broken}`],
    })
  } finally {
    stderr.mockRestore()
  }
  expect(said).toEqual([
    expect.stringContaining(`nod: could not read the transcripts of task n${broken}: EISDIR`),
  ])
})

test('nod show and nod stats print the tokens and none of the conversation, and show the rest with a transcript it cannot read', () => {
  const { home, config, ledger, start, keep } = setup()
  const id = start()
  keep(`session-${id}.jsonl`, user(SECRET), says('m1', 'big', 1), says('m1', 'big', 1))
  const {
    CLAUDECODE: _,
    CLAUDE_CODE_SESSION_ID: __,
    NOD_TASK: ___,
    NOD_ACTOR: ____,
    CLAUDE_CODE_MESSAGING_SOCKET: _____,
    ...shell
  } = process.env
  const nod = (...args: string[]): string => {
    const run = Bun.spawnSync(['bun', cli, ...args], { env: { ...shell, NOD_HOME: home } })
    expect(run.exitCode).toBe(0)
    return run.stdout.toString()
  }
  const show = nod('show', `n${id}`)
  expect(show).toContain(
    '  tokens worker big: calls 1, output 10, cache write 100, cache read 1,000, input 1\n  tokens subagents: no calls\n  tokens review: no transcript\n  start ',
  )
  expect(show).not.toContain(SECRET)
  const stats = nod('stats')
  expect(JSON.parse(stats)).toMatchObject({
    tasks: { running: 1 },
    tokens: { worker: { big: use(1, 1) }, subagents: {}, review: null, missing: [] },
  })
  expect(stats).not.toContain(SECRET)
  // A task that has not started has none to say.
  expect(nod('show', `n${ledger.add({ ...NEW, after: [id] })}`)).not.toContain('tokens')

  const broken = start()
  mkdirSync(join(config, 'projects', 'other', `session-${broken}.jsonl`), { recursive: true })
  expect(nod('show', `n${broken}`)).toMatch(
    /\n {2}tokens: could not read the transcripts: EISDIR.*\n {2}start /,
  )
}, 20_000)
