import { afterAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { calls, clonedRepo, fakeService, git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { land } from './land'
import { type LandLevel, Ledger } from './ledger'
import { Terminals } from './tmux'
import { tick } from './triggers'
import { answer, drop, onStop, type Send, tell, workspaceOf } from './worker'

// Landing runs without a terminal here: what nod hands the worker (`send`) starts its turn as
// deliver does, and each test ends that turn itself through the Stop hook, as the worker would.
const tmp = tempDirs()
process.env.TMUX_TMPDIR = tmp.make('nod-tmux-')
const bin = tmp.make('nod-land-bin-')
// The independent reviewer is `claude -p`: the fake, never the real one.
const fake = resolve(import.meta.dir, '../test/fake-agent.ts')
writeFileSync(
  join(bin, 'claude'),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
)
chmodSync(join(bin, 'claude'), 0o755)
const state = tmp.make('nod-land-service-')
fakeService(bin, state)
if (Bun.which('claude', { PATH: process.env.PATH }) !== join(bin, 'claude')) {
  throw new Error('fake claude is not first on PATH')
}
process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-land-claude-')
const homes: string[] = []
afterAll(() => {
  for (const h of homes) Terminals.of(h).killServer()
  tmp.removeAll()
})

let home: string
let ledger: Ledger
let repo: string
let origin: string
let service: string
let handed: { id: number; text: string }[]
let n = 0

// As deliver does with no terminal: the landing turn starts, and the worker's stop comes later.
const send: Send = async (id, text) => {
  handed.push({ id, text })
  const task = ledger.get(id)
  ledger.setRunning(id, task.workspace ?? '')
  ledger.startAttempt({
    taskId: id,
    kind: 'land',
    decisionId: null,
    sessionId: `s${id}`,
    prompt: text,
  })
}

beforeEach(() => {
  home = tmp.make('nod-land-')
  homes.push(home)
  process.env.NOD_HOME = home
  ledger = new Ledger(home)
  service = join(state, String(n++))
  process.env.FAKE_SERVICE = service
  ;({ repo, origin } = clonedRepo(tmp.make, service, 'https://github.com/o/r'))
  handed = []
})

const setRepo = (land: LandLevel, more: { checkCmd?: string; gateCmd?: string } = {}) =>
  ledger.setRepo(repo, { land, ...more }, 'human')

// A repo task that succeeded with a commit of `files` on `branch`, after `after` if given, on whose
// branch it then starts.
function finished(branch: string, files: Record<string, string>, after?: number): number {
  const id = ledger.add({
    brief: `work on ${branch}`,
    repo,
    branch,
    checkCmd: null,
    model: null,
    after: after === undefined ? [] : [after],
    triggerId: null,
    issue: null,
  })
  const ws = workspaceOf(home, ledger.get(id))
  const from = after === undefined ? [] : [ledger.get(after).branch ?? '']
  git(repo, 'worktree', 'add', '-q', '-b', branch, ws, ...from)
  for (const [file, text] of Object.entries(files)) writeFileSync(join(ws, file), text)
  git(ws, 'add', '-A')
  git(ws, 'commit', '-qm', `change ${Object.keys(files).join(' ')}`)
  ledger.setRunning(id, ws)
  const a = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: `s${id}`,
    prompt: `work on ${branch}`,
  })
  ledger.endAttempt(a, { outcome: 'succeeded', summary: 'did it', report: 'NOD: done | did it' })
  ledger.succeed(id)
  return id
}

// Someone else's commit on the remote's default branch.
function mainMoves(file: string, text: string): string {
  const other = tmp.make('nod-other-')
  git(other, 'clone', '-q', origin, '.')
  writeFileSync(join(other, file), text)
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', `main changes ${file}`)
  git(other, 'push', '-q', 'origin', 'main')
  return git(other, 'rev-parse', 'HEAD')
}

// The worker's turn ends with `reply`.
const stops = (id: number, reply: string, continuing = false) =>
  onStop(ledger, home, {
    session_id: `s${id}`,
    last_assistant_message: reply,
    stop_hook_active: continuing,
  })
const ws = (id: number): string => ledger.get(id).workspace ?? ''
const head = (id: number): string => git(ws(id), 'rev-parse', 'HEAD')
const reviews = (): string[] => {
  const log = join(home, 'agent.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'review')
    .map((e) => e.message)
}

test('at pr, nod rebases onto the moved default branch, has the worker write the pull request, then pushes and opens it, and merges nothing', async () => {
  setRepo('pr', { checkCmd: 'test -f a.txt && test -f m.txt' })
  const id = finished('feat/a', { 'a.txt': 'a\n' })
  const tip = mainMoves('m.txt', 'm\n')

  expect(await land(ledger, home, { send })).toEqual([
    { id, did: 'its worker writes the pull request' },
  ])
  // Its own commit, on the default branch as it is now; checked there before the worker is asked.
  expect(git(ws(id), 'log', '--format=%s', `${tip}..HEAD`)).toBe('change a.txt')
  expect(ledger.landing(id)).toMatchObject({ base: tip, ready: head(id) })
  expect(handed[0]?.text).toContain("write it for the repo's readers")
  expect(handed[0]?.text).not.toContain('conflicts in')
  expect(ledger.get(id).status).toBe('running')

  expect(await stops(id, 'Add a\n\nAdds a.txt.\nNOD: done | wrote the pull request')).toBeNull()
  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.landing(id)).toMatchObject({ title: 'Add a', body: 'Adds a.txt.', handedAt: null })
  // Nothing changed since nod checked it, so nothing to review again.
  expect(reviews()).toEqual([])

  const [opened] = await land(ledger, home, { send })
  expect(opened?.did).toBe(
    'pull request open, waiting for its merge: https://github.com/o/r/pull/1',
  )
  expect(git(origin, 'rev-parse', 'refs/heads/feat/a')).toBe(head(id))
  expect(ledger.links(id)).toEqual(['https://github.com/o/r/pull/1'])
  const create = calls(service).find((c) => c.args[1] === 'create')
  expect(create?.args).toEqual(
    expect.arrayContaining(['--base', 'main', '--head', 'feat/a', '--title', 'Add a']),
  )
  expect(create?.stdin).toBe('Adds a.txt.')

  // The default branch moves again: the pull request still merges, so it is left as reviewed.
  mainMoves('n.txt', 'n\n')
  const pushed = head(id)
  await land(ledger, home, { send })
  expect(git(origin, 'rev-parse', 'refs/heads/feat/a')).toBe(pushed)
  // Until the service says it no longer merges.
  writeFileSync(join(service, 'merge-state'), 'DIRTY')
  await land(ledger, home, { send })
  expect(git(origin, 'rev-parse', 'refs/heads/feat/a')).not.toBe(pushed)
  expect(git(origin, 'show', 'feat/a:n.txt')).toBe('n')
  expect(handed).toHaveLength(1)
  expect(calls(service).some((c) => c.args[1] === 'merge')).toBe(false)
}, 30_000)

test('at merge, a task on an earlier task’s branch lands after it, with only its own commits on top of the squash', async () => {
  setRepo('merge')
  const a = finished('feat/a', { 'a.txt': 'a\n' })
  const b = finished('feat/b', { 'b.txt': 'b\n' }, a)

  expect(await land(ledger, home, { send })).toEqual([
    { id: a, did: 'its worker writes the pull request' },
    { id: b, did: 'lands after #1' },
  ])
  await stops(a, 'Add a\n\nNOD: done | wrote it')

  const second = await land(ledger, home, { send })
  expect(second[0]).toEqual({ id: a, did: 'merged: https://github.com/o/r/pull/1' })
  expect(second[1]).toEqual({ id: b, did: 'its worker writes the pull request' })
  const squash = git(origin, 'rev-parse', 'main')
  // b's branch held a's commit too; only b's own moved onto the squash.
  expect(git(ws(b), 'log', '--format=%s', `${squash}..HEAD`)).toBe('change b.txt')
  expect(git(ws(b), 'show', 'HEAD:a.txt')).toBe('a')
  expect(ledger.landing(b)?.base).toBe(squash)
  const merge = calls(service).find((c) => c.args[1] === 'merge')
  expect(merge?.args).toEqual(
    expect.arrayContaining(['--squash', '--match-head-commit', ledger.landing(a)?.pushed ?? '']),
  )

  await stops(b, 'Add b\n\nNOD: done | wrote it')
  expect((await land(ledger, home, { send }))[0]?.did).toBe('merged: https://github.com/o/r/pull/2')
  expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['Add b', 'Add a', 'init'])
  expect(git(origin, 'rev-list', '--merges', 'main')).toBe('')
}, 30_000)

test('a conflict goes to the worker, which stages its resolution; nod goes on with the rebase, sends the next one, then checks and reviews the result', async () => {
  setRepo('pr')
  writeFileSync(join(repo, 'f.txt'), 'start\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'add f')
  git(repo, 'push', '-q', 'origin', 'main')
  const id = finished('feat/f', { 'f.txt': 'one\n' })
  writeFileSync(join(ws(id), 'f.txt'), 'two\n')
  git(ws(id), 'commit', '-qam', 'f two')
  mainMoves('f.txt', 'main\n')

  expect((await land(ledger, home, { send }))[0]?.did).toBe('its worker resolves a conflict')
  expect(handed[0]?.text).toContain('with conflicts in:\n- f.txt')
  expect(handed[0]?.text).toContain('dropping neither side silently')
  expect(handed[0]?.text).toContain("write it for the repo's readers")

  // Unstaged, it goes back as a failure to fix.
  const unstaged = await stops(id, 'Change f\n\nNOD: done | resolved')
  expect(JSON.parse(unstaged ?? '{}').reason).toContain('These files are still unmerged:\nf.txt')
  // Kept both sides, so the next commit conflicts too: that goes on as landing, not as a retry.
  writeFileSync(join(ws(id), 'f.txt'), 'main\none\n')
  git(ws(id), 'add', 'f.txt')
  const next = await stops(id, 'Fixed it.', true)
  expect(JSON.parse(next ?? '{}').reason).toContain('f two')
  expect(ledger.attempts(id).at(-1)?.kind).toBe('land')

  writeFileSync(join(ws(id), 'f.txt'), 'main\ntwo\n')
  git(ws(id), 'add', 'f.txt')
  expect(await stops(id, 'Fixed it.', true)).toBeNull()
  expect(ledger.get(id).status).toBe('succeeded')
  // The text of the done that had its report line.
  expect(ledger.landing(id)).toMatchObject({ title: 'Change f', handedAt: null, ready: head(id) })
  expect(git(ws(id), 'show', 'HEAD:f.txt')).toBe('main\ntwo')
  expect(git(ws(id), 'log', '--format=%s', 'origin/main..HEAD').split('\n')).toEqual([
    'f two',
    'change f.txt',
  ])
  const [review] = reviews()
  expect(review).toContain('What nod asked as it landed the branch')
  expect(review).toContain(`since ${ledger.landing(id)?.base}`)
}, 30_000)

test('a gate that fails asks the person, and dropping it stops landing while the task stays succeeded', async () => {
  setRepo('pr', { gateCmd: '! grep -q Secret "$NOD_PR"' })
  const id = finished('feat/g', { 'g.txt': 'g\n' })
  await land(ledger, home, { send })
  await stops(id, 'Secret plan\n\nNOD: done | wrote it')

  expect((await land(ledger, home, { send }))[0]?.did).toBe('asked: the gate failed')
  const [asked] = ledger.decisions(id).filter((d) => d.answer === null)
  expect(asked?.reason).toBe('check_failed')
  expect(asked?.question).toContain('the repo\'s gate `! grep -q Secret "$NOD_PR"` failed')
  expect(ledger.get(id).status).toBe('needs_decision')
  // Nothing went out.
  expect(
    Bun.spawnSync(['git', '-C', origin, 'rev-parse', '-q', '--verify', 'feat/g']).exitCode,
  ).toBe(1)

  expect(await drop(ledger, home, asked?.id ?? 0)).toBe('landing stopped')
  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.landing(id)?.stopped).toBe('dropped')
  expect(await land(ledger, home, { send })).toEqual([])
}, 30_000)

test('a remote branch with commits nod did not push asks the person: no stops landing, yes tries again', async () => {
  setRepo('pr')
  const id = finished('feat/x', { 'x.txt': 'x\n' })
  await land(ledger, home, { send })
  await stops(id, 'Add x\n\nNOD: done | wrote it')
  // Someone pushed a branch of that name with work of their own.
  const other = tmp.make('nod-other-')
  git(other, 'clone', '-q', origin, '.')
  git(other, 'checkout', '-qb', 'feat/x')
  git(other, 'commit', '-q', '--allow-empty', '-m', 'theirs')
  git(other, 'push', '-q', 'origin', 'feat/x')
  const theirs = git(other, 'rev-parse', 'HEAD')

  expect((await land(ledger, home, { send }))[0]?.did).toStartWith(
    'asked: origin/feat/x has commits',
  )
  expect(git(origin, 'rev-parse', 'feat/x')).toBe(theirs)
  const asked = ledger.decisions(id).find((d) => d.answer === null)
  expect(asked?.reason).toBe('land')
  expect(await answer(ledger, home, asked?.id ?? 0, 'yes', 'human')).toBe(true)
  expect(ledger.get(id).status).toBe('succeeded')
  expect(ledger.landing(id)?.stopped).toBeNull()
  // Still theirs, so asked again; no this time.
  await land(ledger, home, { send })
  const again = ledger.decisions(id).find((d) => d.answer === null)
  await answer(ledger, home, again?.id ?? 0, 'no, I will', 'human')
  expect(ledger.landing(id)?.stopped).toBe('stopped by the person: no, I will')
  expect(ledger.get(id).status).toBe('succeeded')
  expect(git(origin, 'rev-parse', 'feat/x')).toBe(theirs)
}, 30_000)

test('only tasks added after the repo went up land on their own; nod land names older ones, and a task someone linked is left alone', async () => {
  const older = finished('feat/old', { 'o.txt': 'o\n' })
  setRepo('pr')
  const linked = finished('feat/linked', { 'l.txt': 'l\n' })
  ledger.link(linked, ['https://github.com/o/r/pull/9'])
  expect(await land(ledger, home, { send })).toEqual([])
  expect(await land(ledger, home, { send, only: [older] })).toEqual([
    { id: older, did: 'its worker writes the pull request' },
  ])
  // Off again: nothing lands, named or not.
  setRepo('off')
  expect(await land(ledger, home, { send, only: [older] })).toEqual([])
}, 30_000)

test('a message while nod works in the worktree waits, so the worker does not edit files that move under it', async () => {
  setRepo('pr')
  const id = finished('feat/busy', { 'b.txt': 'b\n' })
  // The parent of this test process, alive and not this process: another pass, mid-rebase.
  ledger.setLanding(id, { busy: process.ppid })
  await expect(tell(ledger, home, id, 'one more thing')).rejects.toThrow(
    `nod is landing task ${id} right now`,
  )
  expect(ledger.attempts(id)).toHaveLength(1)
})

test('the tick lands on its fifth minutes, before it sweeps', async () => {
  setRepo('pr')
  const id = finished('feat/t', { 't.txt': 't\n' })
  await land(ledger, home, { send })
  await stops(id, 'Add t\n\nNOD: done | wrote it')
  const quiet = await tick(ledger, home, new Date(), false)
  expect(quiet.landed).toEqual([])
  const { landed } = await tick(ledger, home, new Date(), true)
  expect(landed).toEqual([
    { id, did: 'pull request open, waiting for its merge: https://github.com/o/r/pull/1' },
  ])
})
