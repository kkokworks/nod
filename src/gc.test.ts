import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDirs } from '../test/tmp'
import { collect, landed } from './gc'
import { Ledger } from './ledger'
import { branchOf, restore, sessionFolder, workspaceOf } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const OLD = '2026-01-01T00:00:00.000Z'

test('gc removes old finished workspaces, keeps their session transcripts, and keeps the rest', async () => {
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
    mkdirSync(sessionFolder(cwd, process.env.CLAUDE_CONFIG_DIR ?? null), { recursive: true })
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
  const recentSessions = sessionFolder(
    workspaceOf(home, ledger.get(recent)),
    process.env.CLAUDE_CONFIG_DIR ?? null,
  )
  const oldPlainSessions = sessionFolder(
    workspaceOf(home, ledger.get(oldPlain)),
    process.env.CLAUDE_CONFIG_DIR ?? null,
  )

  const report = await collect(ledger, home, { before: new Date(Date.now() - 7 * 86_400_000) })

  expect(report).toEqual({
    removed: [oldPlain, oldRepo],
    clean: [],
    skipped: [{ id: dirty, reason: 'uncommitted changes in worktree' }],
  })
  expect(existsSync(workspaceOf(home, ledger.get(oldPlain)))).toBe(false)
  // The transcript stays, so resume can bring the task back.
  expect(existsSync(oldPlainSessions)).toBe(true)
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
  // A folder gc may not delete from; it must not stop gc from getting through the tasks after it.
  const locked = task('locked')
  ledger.succeed(locked)
  const lockedDir = join(workspaceOf(home, ledger.get(locked)), 'locked')
  mkdirSync(lockedDir)
  writeFileSync(join(lockedDir, 'file'), '')
  chmodSync(lockedDir, 0o555)
  const named = task('named')
  ledger.succeed(named)
  const other = task('other')
  ledger.succeed(other)
  const running = task('running')
  const gone = task('workspace already gone')
  ledger.succeed(gone)
  rmSync(workspaceOf(home, ledger.get(gone)), { recursive: true })

  const report = await collect(ledger, home, { ids: [locked, named, running, gone] })
  chmodSync(lockedDir, 0o755)

  expect(report).toEqual({
    removed: [named],
    clean: [gone],
    skipped: [
      { id: locked, reason: expect.stringContaining('EACCES') },
      { id: running, reason: 'still running' },
    ],
  })
  expect(ledger.get(locked).collectedAt).toBeNull()
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

test('resume brings a collected task back: the worktree returns at the same path from the commit gc recorded', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const task = (brief: string, branch: string | null): number => {
    const id = ledger.add({
      brief,
      repo: branch === null ? null : repo,
      branch,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    if (branch === null) mkdirSync(cwd, { recursive: true })
    else git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
    ledger.setRunning(id, cwd)
    const sessionId = `session-${id}`
    ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId, prompt: brief })
    ledger.succeed(id)
    mkdirSync(sessionFolder(cwd, process.env.CLAUDE_CONFIG_DIR ?? null), { recursive: true })
    writeFileSync(
      join(sessionFolder(cwd, process.env.CLAUDE_CONFIG_DIR ?? null), `${sessionId}.jsonl`),
      '{}\n',
    )
    return id
  }
  const id = task('feature', 'feat/x')
  const cwd = workspaceOf(home, ledger.get(id))
  writeFileSync(join(cwd, 'x.txt'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'x')
  // Pushed, so gc deletes the branch; then the remote branch goes too, as after a merge.
  git(repo, 'update-ref', 'refs/remotes/origin/feat/x', 'feat/x')
  const head = git(repo, 'rev-parse', 'feat/x').trim()
  await collect(ledger, home, { ids: [id] })
  expect(ledger.get(id).head).toBe(head)
  expect(git(repo, 'branch', '--list', 'feat/x')).toBe('')
  // A second gc that finds the branch gone keeps the commit the first one recorded.
  ledger.collected(id, null)
  expect(ledger.get(id).head).toBe(head)
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/feat/x')

  await restore(ledger, home, id)

  expect(readFileSync(join(cwd, 'x.txt'), 'utf8')).toBe('x')
  expect(git(repo, 'rev-parse', 'feat/x').trim()).toBe(head)
  expect(ledger.get(id).collectedAt).toBeNull()

  // A worktree folder deleted by hand stays registered with git; it still comes back.
  const byHand = task('deleted by hand', 'feat/y')
  const byHandCwd = workspaceOf(home, ledger.get(byHand))
  writeFileSync(join(byHandCwd, 'y.txt'), 'y')
  git(byHandCwd, 'add', '.')
  git(byHandCwd, 'commit', '-q', '-m', 'y')
  rmSync(byHandCwd, { recursive: true })
  await collect(ledger, home, { ids: [byHand] })
  await restore(ledger, home, byHand)
  expect(readFileSync(join(byHandCwd, 'y.txt'), 'utf8')).toBe('y')

  // A task collected before gc kept transcripts cannot come back, and says so.
  const plain = task('plain', null)
  await collect(ledger, home, { ids: [plain] })
  const plainCwd = workspaceOf(home, ledger.get(plain))
  rmSync(sessionFolder(plainCwd, process.env.CLAUDE_CONFIG_DIR ?? null), { recursive: true })
  await expect(restore(ledger, home, plain)).rejects.toThrow('transcript is gone')
  expect(existsSync(plainCwd)).toBe(false)
  expect(ledger.get(plain).collectedAt).not.toBeNull()
})

test('landed reads a non-ASCII file name as that file, so an unpushed change to it has not landed', () => {
  const home = tmp.make('nod-gc-')
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], repo)
  git('init', '-q', '-b', 'main')
  // git's default, which quotes such a name in its output.
  git('config', 'core.quotePath', 'true')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-b', 'feat/plan')
  writeFileSync(join(repo, '기획.md'), 'plan')
  git('add', '.')
  git('commit', '-q', '-m', 'plan')
  git('checkout', '-q', 'main')

  expect(landed(repo, 'refs/heads/feat/plan')).toBe(false)
  // A squash merge brings the same file to the default branch.
  writeFileSync(join(repo, '기획.md'), 'plan')
  git('add', '.')
  git('commit', '-q', '-m', 'squash')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect(landed(repo, 'refs/heads/feat/plan')).toBe(true)
})

test('gc keeps a worktree holding the only copy of commits: in a submodule, or on a detached HEAD', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const git = (cwd: string, ...args: string[]): string =>
    sh(
      [
        'git',
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        '-c',
        'protocol.file.allow=always',
        ...args,
      ],
      cwd,
    )
  const commit = (cwd: string, msg: string): void => {
    git(cwd, 'commit', '-q', '--allow-empty', '-m', msg)
  }
  // The submodule's remote, and a repo whose checkout of it pins a commit past the branch it was
  // cloned on, so a worktree's clone of that checkout has the commit on no remote branch.
  const upstream = join(home, 'lib')
  mkdirSync(upstream)
  git(upstream, 'init', '-q', '-b', 'main')
  commit(upstream, 'one')
  const repo = join(home, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'submodule', 'add', '-q', upstream, 'lib')
  commit(repo, 'add lib')
  commit(upstream, 'two')
  git(join(repo, 'lib'), 'fetch', '-q')
  git(join(repo, 'lib'), 'checkout', '-q', '--detach', 'origin/main')
  git(repo, 'add', 'lib')
  commit(repo, 'lib two')
  // A pushed task, its submodule filled as initSubmodules does, from the repo's checkout of it.
  const task = (branch: string): { id: number; cwd: string } => {
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
    git(cwd, '-c', `submodule.lib.url=${join(repo, 'lib')}`, 'submodule', 'update', '-q', '--init')
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    return { id, cwd }
  }
  const push = (branch: string): void => {
    git(repo, 'update-ref', `refs/remotes/origin/${branch}`, branch)
  }
  const plain = task('feat/plain')
  push('feat/plain')
  // The repo's branch records the submodule's new commit and is pushed; the commit itself is not.
  const inSub = task('feat/in-sub')
  commit(join(inSub.cwd, 'lib'), 'lib work')
  git(inSub.cwd, 'add', 'lib')
  commit(inSub.cwd, 'record lib work')
  push('feat/in-sub')
  const detached = task('feat/detached')
  push('feat/detached')
  git(detached.cwd, 'checkout', '-q', '--detach')
  commit(detached.cwd, 'detached work')

  const report = await collect(ledger, home, { ids: [plain.id, inSub.id, detached.id] })

  expect(report).toEqual({
    removed: [plain.id],
    clean: [],
    skipped: [
      { id: inSub.id, reason: 'submodule lib has commits no remote has' },
      { id: detached.id, reason: 'HEAD has commits feat/detached does not' },
    ],
  })
  expect(existsSync(plain.cwd)).toBe(false)
  expect(existsSync(inSub.cwd)).toBe(true)
  expect(existsSync(detached.cwd)).toBe(true)
  expect(ledger.get(inSub.id).collectedAt).toBeNull()
  expect(ledger.get(detached.id).collectedAt).toBeNull()
})

test('gc reads each task again as it gets to it: one told to go on meanwhile is left alone', async () => {
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
    ledger.succeed(id)
    return id
  }
  const closing = task('told to go on as its session closes')
  const told = task('told to go on before gc gets to it')
  const other = task('other')
  // As `nod tell` does: restore takes a collected task back, then the message sets it running.
  const tell = (id: number): void => {
    ledger.uncollected(id)
    ledger.setRunning(id, workspaceOf(home, ledger.get(id)))
  }

  const collecting = collect(ledger, home, { ids: [closing, told, other] })
  // gc took the first task and is closing its session.
  expect(ledger.get(closing).collectedAt).not.toBeNull()
  tell(closing)
  tell(told)
  const report = await collecting

  expect(report).toEqual({
    removed: [other],
    clean: [],
    skipped: [
      { id: closing, reason: 'told to go on while gc ran' },
      { id: told, reason: 'still running' },
    ],
  })
  for (const id of [closing, told]) {
    expect(existsSync(workspaceOf(home, ledger.get(id)))).toBe(true)
    expect(ledger.get(id).collectedAt).toBeNull()
  }
})

test('gc --older-than leaves a task a queued one waits for, as sweep does', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const spec = {
    brief: 'base',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  }
  const base = ledger.add(spec)
  mkdirSync(workspaceOf(home, ledger.get(base)), { recursive: true })
  ledger.setRunning(base, workspaceOf(home, ledger.get(base)))
  ledger.succeed(base)
  ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id: base, at: OLD })
  ledger.add({ ...spec, brief: 'after the base', after: [base] })

  expect(await collect(ledger, home, { before: new Date() })).toEqual({
    removed: [],
    clean: [],
    skipped: [],
  })
  expect(existsSync(workspaceOf(home, ledger.get(base)))).toBe(true)
  expect(ledger.get(base).collectedAt).toBeNull()
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
