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

test('done signals: dropped, taken over, merged into the default branch, a pull request closed or approved, or old', async () => {
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
  // A finished task; with a branch, a worktree on it, and a commit when `commit` is set.
  const finish = (id: number, finishedAt: string, commit = false): number => {
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
    ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: finishedAt })
    return id
  }
  const add = (brief: string, branch: string | null = null): number =>
    ledger.add(spec(brief, branch))

  const dropped = add('dropped')
  finish(dropped, RECENT)
  ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id: dropped })

  const todos = new Todos(ledger)
  const todo = todos.capture(
    { title: 'review', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  ).todo
  const replaced = finish(ledger.addTodoTask(spec('first round', null), todo.id), RECENT)
  const takeover = finish(ledger.addTodoTask(spec('second round', null), todo.id), RECENT)

  const approved = finish(add('approved review', 'chore/approved'), RECENT)
  ledger.link(approved, [`${PR}1#issuecomment-9`])
  const changes = finish(add('review asking for changes', 'chore/changes'), RECENT)
  ledger.link(changes, [`${PR}2`])
  const merged = finish(add('merged pr', 'feat/merged'), RECENT, true)
  git(repo, 'update-ref', 'refs/remotes/origin/feat/merged', 'feat/merged')
  ledger.link(merged, [`${PR}3`])
  const unpushed = finish(add('unpushed', 'feat/unpushed'), OLD, true)
  ledger.link(unpushed, [`${PR}3`])
  const landed = finish(add('squashed', 'feat/squashed'), RECENT, true)
  writeFileSync(join(repo, `${landed}.txt`), 'squashed')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'squash')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const old = finish(add('old plain'), OLD)
  const recent = finish(add('recent plain'), RECENT)
  const broken = finish(add('lookup fails'), RECENT)
  ledger.link(broken, [`${PR}4`])
  const errored = add('errored')
  finish(errored, OLD)
  ledger.error(errored, 'crashed')

  const prs: Record<string, PullRequest> = {
    [`${PR}1#issuecomment-9`]: { state: 'open', myVerdict: 'approved' },
    [`${PR}2`]: { state: 'open', myVerdict: 'changes' },
    [`${PR}3`]: { state: 'merged', myVerdict: null },
  }
  const lookup: PrLookup = async (url) => {
    if (url === `${PR}4`) throw new Error('tea exited 1')
    return prs[url] ?? null
  }

  const { done, unchecked } = await doneTasks(ledger, lookup, NOW)

  expect(done).toEqual([
    { id: dropped, reason: 'dropped' },
    { id: replaced, reason: `#${takeover} took over t${todo.id}` },
    { id: approved, reason: `approved: ${PR}1#issuecomment-9` },
    { id: merged, reason: `merged: ${PR}3` },
    { id: landed, reason: 'its changes are in the default branch' },
    { id: old, reason: 'finished 7+ days ago' },
  ])
  // Not done: the newer round, changes asked for, the only copy of commits, a recent task, an
  // errored one. A failed lookup is reported, not taken as an answer.
  expect(done.map((d) => d.id)).not.toContain(changes)
  expect(done.map((d) => d.id)).not.toContain(unpushed)
  expect(done.map((d) => d.id)).not.toContain(recent)
  expect(unchecked).toEqual([{ id: broken, error: 'tea exited 1' }])

  const swept = await sweep(ledger, home, lookup, NOW)
  expect(swept.report.removed).toEqual(done.map((d) => d.id))
  expect(ledger.get(approved).collectedAt).not.toBeNull()
  expect(ledger.get(unpushed).collectedAt).toBeNull()
  // Collected tasks are not looked at again.
  expect((await doneTasks(ledger, lookup, NOW)).done).toEqual([])
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
