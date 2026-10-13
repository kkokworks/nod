import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { collect, sessionFolder } from './gc'
import { Ledger } from './ledger'
import { branchOf, workspaceOf } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const OLD = '2026-01-01T00:00:00.000Z'

test('gc removes old finished workspaces and their session folders, and keeps the rest', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  sh(['git', 'init', '-q'], repo)
  sh(
    [
      'git',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ],
    repo,
  )

  const task = (brief: string, withRepo: boolean, finishedAt: string): number => {
    const id = ledger.add({
      brief,
      repo: withRepo ? repo : null,
      branch: withRepo ? `feat/${brief.replaceAll(' ', '-')}` : null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    if (withRepo) sh(['git', 'worktree', 'add', '-q', '-b', branchOf(ledger.get(id)), cwd], repo)
    else mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionFolder(cwd), { recursive: true })
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: finishedAt })
    return id
  }
  const oldPlain = task('old plain', false, OLD)
  const oldRepo = task('old repo', true, OLD)
  const dirty = task('old dirty repo', true, OLD)
  writeFileSync(join(workspaceOf(home, ledger.get(dirty)), 'uncommitted.txt'), 'x')
  const recent = task('recent', false, new Date().toISOString())
  const recentSessions = sessionFolder(workspaceOf(home, ledger.get(recent)))
  const oldPlainSessions = sessionFolder(workspaceOf(home, ledger.get(oldPlain)))

  const report = await collect(ledger, home, { before: new Date(Date.now() - 7 * 86_400_000) })

  expect(report).toEqual({
    removed: [oldPlain, oldRepo],
    clean: [],
    skipped: [{ id: dirty, reason: 'uncommitted changes in worktree' }],
  })
  expect(existsSync(workspaceOf(home, ledger.get(oldPlain)))).toBe(false)
  expect(existsSync(oldPlainSessions)).toBe(false)
  expect(existsSync(workspaceOf(home, ledger.get(oldRepo)))).toBe(false)
  // Not pushed and no default branch to compare with: the branch is the only copy, so it stays.
  expect(sh(['git', 'branch', '--list', 'feat/old-repo'], repo)).toContain('feat/old-repo')
  expect(existsSync(workspaceOf(home, ledger.get(dirty)))).toBe(true)
  expect(existsSync(workspaceOf(home, ledger.get(recent)))).toBe(true)
  expect(existsSync(recentSessions)).toBe(true)
  expect(ledger.list()).toHaveLength(4)
  expect(ledger.get(oldRepo).collectedAt).not.toBeNull()
  expect(ledger.get(dirty).collectedAt).toBeNull()
  // Collected tasks are not picked again by age; the dirty one still is.
  expect(await collect(ledger, home, { before: new Date() })).toEqual({
    removed: [recent],
    clean: [],
    skipped: [{ id: dirty, reason: 'uncommitted changes in worktree' }],
  })
})

test('gc collects the tasks the human names, however recent, and leaves unfinished ones', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const task = (brief: string): number => {
    const id = ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    mkdirSync(workspaceOf(home, ledger.get(id)), { recursive: true })
    ledger.setRunning(id, workspaceOf(home, ledger.get(id)))
    return id
  }
  const named = task('named')
  ledger.succeed(named)
  const other = task('other')
  ledger.succeed(other)
  const running = task('running')
  const gone = task('workspace already gone')
  ledger.succeed(gone)
  rmSync(workspaceOf(home, ledger.get(gone)), { recursive: true })

  const report = await collect(ledger, home, { ids: [named, running, gone] })

  expect(report).toEqual({
    removed: [named],
    clean: [gone],
    skipped: [{ id: running, reason: 'still running' }],
  })
  expect(ledger.get(gone).collectedAt).not.toBeNull()
  expect(ledger.get(running).collectedAt).toBeNull()
  expect(await collect(ledger, home, { ids: [named] })).toEqual({
    removed: [],
    clean: [named],
    skipped: [],
  })
  expect(existsSync(workspaceOf(home, ledger.get(named)))).toBe(false)
  expect(existsSync(workspaceOf(home, ledger.get(other)))).toBe(true)
  expect(existsSync(workspaceOf(home, ledger.get(running)))).toBe(true)
})

test('gc deletes a branch once a remote branch holds it or the default branch has its changes', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  // Each task commits one file named after its branch, holding the branch name.
  const task = (branch: string): number => {
    const id = ledger.add({
      brief: branch,
      repo,
      branch,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
    writeFileSync(join(cwd, `${branch.replaceAll('/', '-')}.txt`), branch)
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-q', '-m', branch)
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    return id
  }
  const pushed = task('feat/pushed')
  const squashed = task('feat/squashed')
  const unmerged = task('feat/unmerged')
  git(repo, 'update-ref', 'refs/remotes/origin/feat/pushed', 'feat/pushed')
  // A squash merge: the default branch gets the same file in a commit of its own.
  writeFileSync(join(repo, 'feat-squashed.txt'), 'feat/squashed')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'squashed')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

  const report = await collect(ledger, home, { ids: [pushed, squashed, unmerged] })

  expect(report.removed).toEqual([pushed, squashed, unmerged])
  expect(git(repo, 'branch', '--list', 'feat/*').split('\n').filter(Boolean)).toEqual([
    '  feat/unmerged',
  ])
  // The folders named after the repo and branch prefix went with the last worktree in them.
  expect(existsSync(join(home, 'work', 'repo'))).toBe(false)
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
