import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { doneTasks, type PrLookup, type PullRequest, sweep } from './done'
import { Ledger, type NewTask } from './ledger'
import { Todos } from './todos'
import { workspaceOf } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const PR = 'https://git.example.com/o/r/pulls/'
const NOW = new Date('2026-03-10T00:00:00.000Z')
const RECENT = '2026-03-09T00:00:00.000Z'
const OLD = '2026-03-01T00:00:00.000Z'

test('done signals: dropped, taken over, merged into the default branch, every pull request closed or approved, or old', async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

  const spec = (brief: string, branch: string | null): NewTask => ({
    brief,
    repo: branch === null ? null : repo,
    branch,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  // A task added and finished at `at`; with a branch, a worktree on it, and a commit when `commit`
  // is set.
  const finish = (id: number, at: string, commit = false): number => {
    const task = ledger.get(id)
    const cwd = workspaceOf(home, task)
    if (task.branch === null) mkdirSync(cwd, { recursive: true })
    else {
      git(repo, 'worktree', 'add', '-q', '-b', task.branch, cwd)
      if (commit) {
        writeFileSync(join(cwd, `${id}.txt`), task.brief)
        git(cwd, 'add', '.')
        git(cwd, 'commit', '-q', '-m', task.brief)
      }
    }
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    ledger.db
      .query('update tasks set created_at = $at, finished_at = $at where id = $id')
      .run({ id, at })
    return id
  }
  const add = (brief: string, branch: string | null = null): number =>
    ledger.add(spec(brief, branch))
  const drop = (id: number): void => {
    ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id })
  }

  const dropped = finish(add('dropped', 'chore/dropped'), RECENT)
  drop(dropped)
  // A plain workspace's files are the task's output: only age lets it go.
  const droppedPlain = finish(add('dropped plain'), RECENT)
  drop(droppedPlain)

  const todos = new Todos(ledger)
  const todo = todos.capture(
    { title: 'review', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  ).todo
  const replaced = finish(ledger.addTodoTask(spec('first round', 'chore/first'), todo.id), RECENT)
  const takeover = finish(ledger.addTodoTask(spec('second round', 'chore/second'), todo.id), RECENT)

  const approved = finish(add('approved review', 'chore/approved'), RECENT)
  ledger.link(approved, [`${PR}1#issuecomment-9`])
  const earlierRound = finish(add('review after an earlier approval', 'chore/again'), RECENT)
  ledger.link(earlierRound, [`${PR}6`])
  const changes = finish(add('review asking for changes', 'chore/changes'), RECENT)
  ledger.link(changes, [`${PR}2`])
  const merged = finish(add('merged pr', 'feat/merged'), RECENT, true)
  git(repo, 'update-ref', 'refs/remotes/origin/feat/merged', 'feat/merged')
  ledger.link(merged, [`${PR}3`])
  const oneOfTwo = finish(add('two prs, one merged', 'feat/two'), RECENT)
  ledger.link(oneOfTwo, [`${PR}3`, `${PR}5`])
  const unpushed = finish(add('unpushed', 'feat/unpushed'), OLD, true)
  ledger.link(unpushed, [`${PR}3`])
  const waitedOn = finish(add('base of a queued task', 'feat/base'), RECENT)
  ledger.link(waitedOn, [`${PR}3`])
  ledger.add({ ...spec('after the base', 'feat/next'), after: [waitedOn] })
  const landed = finish(add('squashed', 'feat/squashed'), RECENT, true)
  writeFileSync(join(repo, `${landed}.txt`), 'squashed')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'squash')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const old = finish(add('old plain'), OLD)
  const recent = finish(add('recent plain'), RECENT)
  const broken = finish(add('lookup fails', 'chore/broken'), RECENT)
  ledger.link(broken, [`${PR}4`])
  const brokenOld = finish(add('lookup fails, old', 'chore/broken-old'), OLD)
  ledger.link(brokenOld, [`${PR}4`])
  const errored = add('errored')
  finish(errored, OLD)
  ledger.error(errored, 'crashed')

  const prs: Record<string, PullRequest> = {
    [`${PR}1#issuecomment-9`]: { state: 'open', approvedAt: '2026-03-09T01:00:00Z' },
    [`${PR}2`]: { state: 'open', approvedAt: null },
    [`${PR}3`]: { state: 'merged', approvedAt: null },
    [`${PR}5`]: { state: 'open', approvedAt: null },
    [`${PR}6`]: { state: 'open', approvedAt: '2026-03-08T00:00:00Z' },
  }
  const lookup: PrLookup = async (url) => {
    if (url === `${PR}4`) throw new Error('tea exited 1')
    return prs[url] ?? null
  }

  const { done, unchecked } = await doneTasks(ledger, home, lookup, NOW)

  expect(done).toEqual([
    { id: dropped, reason: 'dropped' },
    { id: replaced, reason: `#${takeover} took over t${todo.id}` },
    { id: approved, reason: `approved: ${PR}1#issuecomment-9` },
    { id: merged, reason: `merged: ${PR}3` },
    { id: landed, reason: 'its changes are in the default branch' },
    { id: old, reason: 'finished 7+ days ago' },
    { id: brokenOld, reason: 'finished 7+ days ago' },
  ])
  // Not done: a plain workspace not yet old, the newer round, an approval from before the task,
  // changes asked for, a pull request still open, the only copy of commits, a branch a queued task
  // starts from, an errored task. A failed lookup is reported, not taken as an answer.
  const ids = done.map((d) => d.id)
  for (const id of [droppedPlain, takeover, earlierRound, changes, oneOfTwo, unpushed, waitedOn]) {
    expect(ids).not.toContain(id)
  }
  expect(ids).not.toContain(recent)
  expect(unchecked).toEqual([{ id: broken, error: 'tea exited 1' }])

  const swept = await sweep(ledger, home, lookup, NOW)
  expect(swept.report.removed).toEqual(ids)
  expect(ledger.get(approved).collectedAt).not.toBeNull()
  expect(ledger.get(unpushed).collectedAt).toBeNull()
  // Collected tasks are not looked at again.
  expect((await doneTasks(ledger, home, lookup, NOW)).done).toEqual([])
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
