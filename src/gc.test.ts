import { afterAll, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { huskyHooks, marking, textconvSubmodule, workerSubmodules } from '../test/git-commands'
import { projectFolder, tempFolder } from '../test/projects'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { sweep } from './done'
import { collect, dropTemps, landed, onlyCopy } from './gc'
import { Ledger } from './ledger'
import { branchOf, workspaceOf } from './place'
import { Tmux } from './tmux'
import { Todos } from './todos'
import { restore } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const OLD = '2026-01-01T00:00:00.000Z'

test('gc removes old finished workspaces, keeps their session transcripts, and keeps the rest', async () => {
  const home = tmp.make('nod-gc-')
  const claude = tmp.make('nod-gc-claude-')
  process.env.CLAUDE_CONFIG_DIR = claude
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
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    if (withRepo) sh(['git', 'worktree', 'add', '-q', '-b', branchOf(ledger.get(id)), cwd], repo)
    else mkdirSync(cwd, { recursive: true })
    mkdirSync(projectFolder(claude, cwd), { recursive: true })
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
  const recentSessions = projectFolder(claude, workspaceOf(home, ledger.get(recent)))
  const oldPlainSessions = projectFolder(claude, workspaceOf(home, ledger.get(oldPlain)))

  const report = await collect(ledger, home, Tmux.of(home), {
    before: new Date(Date.now() - 7 * 86_400_000),
  })

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
  expect(await collect(ledger, home, Tmux.of(home), { before: new Date() })).toEqual({
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

  const report = await collect(ledger, home, Tmux.of(home), { ids: [locked, named, running, gone] })
  chmodSync(lockedDir, 0o755)

  expect(report).toEqual({
    removed: [named],
    clean: [gone],
    skipped: [
      // Bun 1.3.14 says EACCES, 1.4.4 ENOTEMPTY.
      { id: locked, reason: expect.stringMatching(/EACCES|ENOTEMPTY/) },
      { id: running, reason: 'still running' },
    ],
  })
  expect(ledger.get(locked).collectedAt).toBeNull()
  expect(ledger.get(gone).collectedAt).not.toBeNull()
  expect(ledger.get(running).collectedAt).toBeNull()
  expect(await collect(ledger, home, Tmux.of(home), { ids: [named] })).toEqual({
    removed: [],
    clean: [named],
    skipped: [],
  })
  expect(existsSync(workspaceOf(home, ledger.get(named)))).toBe(false)
  expect(existsSync(workspaceOf(home, ledger.get(other)))).toBe(true)
  expect(existsSync(workspaceOf(home, ledger.get(running)))).toBe(true)
})

test('gc deletes a branch once the default branch has its changes, and keeps one only pushed', async () => {
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
  const merged = task('feat/merged')
  const squashed = task('feat/squashed')
  const unmerged = task('feat/unmerged')
  // Only pushed: the remote branch may go unmerged, which leaves the branch the only copy.
  git(repo, 'update-ref', 'refs/remotes/origin/feat/pushed', 'feat/pushed')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merged', 'feat/merged')
  // A squash merge: the default branch gets the same file in a commit of its own.
  writeFileSync(join(repo, 'feat-squashed.txt'), 'feat/squashed')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'squashed')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

  const report = await collect(ledger, home, Tmux.of(home), {
    ids: [pushed, merged, squashed, unmerged],
  })

  expect(report.removed).toEqual([pushed, merged, squashed, unmerged])
  expect(git(repo, 'branch', '--list', 'feat/*').split('\n').filter(Boolean)).toEqual([
    '  feat/pushed',
    '  feat/unmerged',
  ])
  // The folders named after the repo and branch prefix went with the last worktree in them.
  expect(existsSync(join(home, 'work', 'repo'))).toBe(false)
})

test('gc keeps a pushed branch the default branch lacks, so its commits outlive the remote branch', async () => {
  const home = tmp.make('nod-gc-')
  const claude = tmp.make('nod-gc-claude-')
  process.env.CLAUDE_CONFIG_DIR = claude
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  const remote = join(home, 'remote.git')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(home, 'init', '-q', '--bare', remote)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  const id = ledger.add({
    brief: 'pushed',
    repo,
    branch: 'feat/x',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', cwd)
  writeFileSync(join(cwd, 'x.txt'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'x')
  git(repo, 'push', '-q', 'origin', 'feat/x')
  ledger.setRunning(id, cwd)
  ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId: 's', prompt: 'x' })
  ledger.succeed(id)
  mkdirSync(projectFolder(claude, cwd), { recursive: true })
  writeFileSync(join(projectFolder(claude, cwd), 's.jsonl'), '{}\n')
  const head = git(repo, 'rev-parse', 'feat/x').trim()

  await collect(ledger, home, Tmux.of(home), { ids: [id] })
  // The remote branch goes unmerged, and a fetch --prune, as landing's, takes origin/feat/x too;
  // then git gc drops what no ref reaches.
  git(remote, 'branch', '-D', 'feat/x')
  git(repo, 'fetch', '-q', '--prune', 'origin')
  git(repo, 'gc', '-q', '--prune=now')
  await restore(ledger, home, id)

  expect(git(repo, 'rev-parse', 'feat/x').trim()).toBe(head)
  expect(readFileSync(join(cwd, 'x.txt'), 'utf8')).toBe('x')
})

test('resume brings a collected task back: the worktree returns at the same path from the commit gc recorded', async () => {
  // Characters Claude Code turns into `-` in the name of a transcript's folder, as `/` and `.`.
  const home = tmp.make('nod_gc 복원-')
  const claude = tmp.make('nod-gc-claude-')
  process.env.CLAUDE_CONFIG_DIR = claude
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
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    if (branch === null) mkdirSync(cwd, { recursive: true })
    else git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
    ledger.setRunning(id, cwd)
    const sessionId = `session-${id}`
    ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId, prompt: brief })
    ledger.succeed(id)
    mkdirSync(projectFolder(claude, cwd), { recursive: true })
    writeFileSync(join(projectFolder(claude, cwd), `${sessionId}.jsonl`), '{}\n')
    return id
  }
  const id = task('feature', 'feat/x')
  const cwd = workspaceOf(home, ledger.get(id))
  writeFileSync(join(cwd, 'x.txt'), 'x')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'x')
  // Merged, so gc deletes the branch.
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'feat/x')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const head = git(repo, 'rev-parse', 'feat/x').trim()
  await collect(ledger, home, Tmux.of(home), { ids: [id] })
  expect(ledger.get(id).head).toBe(head)
  expect(git(repo, 'branch', '--list', 'feat/x')).toBe('')
  // A second gc that finds the branch gone keeps the commit the first one recorded.
  ledger.collected(id, null)
  expect(ledger.get(id).head).toBe(head)
  // The default branch now points at a commit without it, so only the recorded commit has the work.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'later')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

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
  await collect(ledger, home, Tmux.of(home), { ids: [byHand] })
  await restore(ledger, home, byHand)
  expect(readFileSync(join(byHandCwd, 'y.txt'), 'utf8')).toBe('y')

  // A task collected before gc kept transcripts cannot come back, and says so.
  const plain = task('plain', null)
  const plainCwd = workspaceOf(home, ledger.get(plain))
  const plainSessions = projectFolder(claude, plainCwd)
  await collect(ledger, home, Tmux.of(home), { ids: [plain] })
  rmSync(plainSessions, { recursive: true })
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

test('landed reads a name with pathspec magic in it as that file, not as a pattern', () => {
  const home = tmp.make('nod-gc-')
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], repo)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'memo.md'), 'memo')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git('checkout', '-q', '-b', 'feat/colon')
  writeFileSync(join(repo, ':memo.md'), 'colon')
  git('add', '.')
  git('commit', '-q', '-m', 'colon')
  git('checkout', '-q', 'main')

  // As a pattern, `:memo.md` is `memo.md`, which both branches have alike.
  expect(landed(repo, 'refs/heads/feat/colon')).toBe(false)
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
  // A commit on a branch of the submodule, which is back on the commit the repo records.
  const onSide = task('feat/side')
  push('feat/side')
  const sideLib = join(onSide.cwd, 'lib')
  git(sideLib, 'checkout', '-q', '-b', 'side')
  commit(sideLib, 'side work')
  git(sideLib, 'checkout', '-q', '--detach', 'HEAD~1')
  // Work stashed in the submodule.
  const stashed = task('feat/stashed')
  push('feat/stashed')
  writeFileSync(join(stashed.cwd, 'lib', 'draft.txt'), 'draft')
  git(join(stashed.cwd, 'lib'), 'stash', 'push', '-q', '-u')
  // A tagged commit in the submodule, which is back on the commit the repo records.
  const tagged = task('feat/tagged')
  push('feat/tagged')
  const taggedLib = join(tagged.cwd, 'lib')
  commit(taggedLib, 'tagged work')
  git(taggedLib, 'tag', 'wip')
  git(taggedLib, 'checkout', '-q', '--detach', 'HEAD~1')
  // The repo's branch recorded a submodule commit, then took the submodule out.
  const removedSub = task('feat/removed-sub')
  commit(join(removedSub.cwd, 'lib'), 'lib work')
  git(removedSub.cwd, 'add', 'lib')
  commit(removedSub.cwd, 'record lib work')
  git(removedSub.cwd, 'rm', '-q', 'lib')
  commit(removedSub.cwd, 'drop lib')
  push('feat/removed-sub')
  // Uncommitted work in a submodule the repo tells status to ignore.
  const ignored = task('feat/ignored')
  push('feat/ignored')
  writeFileSync(join(ignored.cwd, 'lib', 'draft.txt'), 'draft')
  git(repo, 'config', 'submodule.lib.ignore', 'all')
  const detached = task('feat/detached')
  push('feat/detached')
  git(detached.cwd, 'checkout', '-q', '--detach')
  commit(detached.cwd, 'detached work')
  const kept = [inSub, onSide, stashed, tagged, removedSub, ignored, detached]

  const report = await collect(ledger, home, Tmux.of(home), {
    ids: [plain.id, ...kept.map((t) => t.id)],
  })

  const inLib = 'submodule lib has commits no remote has'
  expect(report).toEqual({
    removed: [plain.id],
    clean: [],
    skipped: [
      { id: inSub.id, reason: inLib },
      { id: onSide.id, reason: inLib },
      { id: stashed.id, reason: inLib },
      { id: tagged.id, reason: inLib },
      { id: removedSub.id, reason: inLib },
      { id: ignored.id, reason: 'uncommitted changes in worktree' },
      { id: detached.id, reason: 'HEAD has commits feat/detached does not' },
    ],
  })
  expect(existsSync(plain.cwd)).toBe(false)
  for (const t of kept) {
    expect(existsSync(t.cwd)).toBe(true)
    expect(ledger.get(t.id).collectedAt).toBeNull()
  }
}, 30_000)

test('gc removes nothing of a task told to go on while it checks the worktree', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const id = ledger.add({
    brief: 'merged',
    repo,
    branch: 'feat/merged',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/merged', cwd)
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'work')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'feat/merged')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  ledger.setRunning(id, cwd)
  ledger.succeed(id)
  // `nod tell` comes as gc runs the git command named in `tellAt`: the message sets the task
  // running. Then gc has marked nothing yet, so a gc that stopped there would leave it listed.
  let tellAt = ''
  let markedMidway: string | null = null
  const spawn = Bun.spawn
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
    const [cmd] = args
    if (Array.isArray(cmd) && cmd.includes(tellAt)) {
      markedMidway = ledger.get(id).collectedAt
      ledger.setRunning(id, cwd)
    }
    return spawn.apply(Bun, args)
  }) as typeof spawn)
  try {
    // Once the session is closed, as gc looks for uncommitted changes.
    tellAt = 'status'
    expect(await collect(ledger, home, Tmux.of(home), { ids: [id] })).toEqual({
      removed: [],
      clean: [],
      skipped: [{ id, reason: 'told to go on while gc ran' }],
    })
    expect(markedMidway).toBeNull()
    expect(existsSync(cwd)).toBe(true)
    expect(git(repo, 'branch', '--list', 'feat/merged')).toContain('feat/merged')
    expect(ledger.get(id).collectedAt).toBeNull()

    // While the worktree goes: the folder is gone, but the task stays listed and keeps its branch.
    ledger.succeed(id)
    tellAt = 'remove'
    expect(await collect(ledger, home, Tmux.of(home), { ids: [id] })).toEqual({
      removed: [],
      clean: [],
      skipped: [{ id, reason: 'told to go on while gc ran' }],
    })
    expect(git(repo, 'branch', '--list', 'feat/merged')).toContain('feat/merged')
    expect(ledger.get(id).collectedAt).toBeNull()
  } finally {
    spy.mockRestore()
  }
})

test('a task gc cannot finish after its worktree went stays listed, and a later gc ends it', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const id = ledger.add({
    brief: 'merged',
    repo,
    branch: 'feat/merged',
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/merged', cwd)
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'work')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'feat/merged')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  ledger.setRunning(id, cwd)
  ledger.succeed(id)
  // Comparing the branch with the default branch fails, so it cannot be deleted.
  const spawnSync = Bun.spawnSync
  const spy = spyOn(Bun, 'spawnSync').mockImplementation(((
    ...args: Parameters<typeof spawnSync>
  ) => {
    const [cmd] = args
    if (Array.isArray(cmd) && cmd.includes('--name-only')) throw new Error('git diff failed')
    return spawnSync.apply(Bun, args)
  }) as typeof spawnSync)

  const failed = await collect(ledger, home, Tmux.of(home), { ids: [id] }).finally(() =>
    spy.mockRestore(),
  )

  expect(failed).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id, reason: 'git diff failed' }],
  })
  expect(existsSync(cwd)).toBe(false)
  expect(ledger.get(id).collectedAt).toBeNull()
  expect(
    await collect(ledger, home, Tmux.of(home), { before: new Date(Date.now() + 60_000) }),
  ).toEqual({
    removed: [],
    clean: [id],
    skipped: [],
  })
  expect(git(repo, 'branch', '--list', 'feat/merged')).toBe('')
  expect(ledger.get(id).collectedAt).not.toBeNull()
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

  const collecting = collect(ledger, home, Tmux.of(home), { ids: [closing, told, other] })
  // gc is closing the first task's session.
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

// Its terminal went (a restart of the machine, say) with a turn a person typed still open: nothing
// ends that turn, so it must not keep the task from gc for good.
test('gc takes a finished task whose open turn went with its terminal', async () => {
  const home = tmp.make('nod-gc-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const id = ledger.add({
    brief: 'typed into, then its terminal went',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(id, cwd)
  ledger.succeed(id)
  // As the prompt hook of a turn a person typed opens it (onPrompt).
  ledger.startAttempt({
    taskId: id,
    kind: 'followup',
    decisionId: null,
    sessionId: 'gone',
    prompt: '(typed into the terminal)\nhang',
  })

  expect(await collect(ledger, home, Tmux.of(home), { ids: [id] })).toEqual({
    removed: [id],
    clean: [],
    skipped: [],
  })
  expect(existsSync(cwd)).toBe(false)
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
    issue: null,
  }
  const base = ledger.add(spec)
  mkdirSync(workspaceOf(home, ledger.get(base)), { recursive: true })
  ledger.setRunning(base, workspaceOf(home, ledger.get(base)))
  ledger.succeed(base)
  ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id: base, at: OLD })
  ledger.add({ ...spec, brief: 'after the base', after: [base] })

  expect(await collect(ledger, home, Tmux.of(home), { before: new Date() })).toEqual({
    removed: [],
    clean: [],
    skipped: [],
  })
  expect(existsSync(workspaceOf(home, ledger.get(base)))).toBe(true)
  expect(ledger.get(base).collectedAt).toBeNull()
})

// A home whose workers' account keeps its sessions' temp folders in a folder of the test's, and
// succeeded tasks there, each with the temp folder of a session of its own.
function withTemps() {
  const home = tmp.make('nod-gc-')
  const base = tmp.make('nod-gc-tmp-')
  const account = tmp.make('nod-gc-claude-')
  // This shell's account keeps them elsewhere.
  const shellBase = tmp.make('nod-gc-shell-tmp-')
  const shell = tmp.make('nod-gc-shell-')
  process.env.CLAUDE_CONFIG_DIR = shell
  for (const [dir, at] of [
    [account, base],
    [shell, shellBase],
  ] as const) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_TMPDIR: at } }))
  }
  const ledger = new Ledger(home)
  const temp = (cwd: string, session: string, at = base): string => {
    const dir = tempFolder(at, cwd, session)
    mkdirSync(join(dir, 'scratchpad'), { recursive: true })
    writeFileSync(join(dir, 'scratchpad', 'big'), 'x')
    return dir
  }
  const turn = (id: number, session: string): string => {
    ledger.startAttempt({
      taskId: id,
      kind: 'start',
      decisionId: null,
      sessionId: session,
      prompt: 'x',
    })
    return temp(workspaceOf(home, ledger.get(id)), session)
  }
  const task = (brief: string): { id: number; cwd: string; session: string; kept: string } => {
    const id = ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    mkdirSync(cwd, { recursive: true })
    ledger.setRunning(id, cwd)
    ledger.setAccount(id, account)
    const session = crypto.randomUUID()
    const kept = turn(id, session)
    ledger.succeed(id)
    return { id, cwd, session, kept }
  }
  return { home, base, shellBase, ledger, temp, turn, task }
}

test("gc removes the temp folders of a task's sessions, and leaves every other session's", async () => {
  const { home, ledger, temp, turn, task } = withTemps()
  const done = task('done')
  // A conversation Claude Code went on in under another ID.
  const second = turn(done.id, crypto.randomUUID())
  const other = task('not collected')
  const running = task('running')
  ledger.setRunning(running.id, running.cwd)
  // Opened in the task's workspace all the same: a session of a person's, one nod open has, and one
  // another task's turn went to last.
  const persons = temp(done.cwd, crypto.randomUUID())
  const opened = crypto.randomUUID()
  const openedTemp = turn(done.id, opened)
  new Todos(ledger).addSession({ role: 'orchestrator', name: 'north' }, opened, done.cwd)
  const moved = crypto.randomUUID()
  const movedTemp = turn(done.id, moved)
  turn(running.id, moved)

  expect(await collect(ledger, home, Tmux.of(home), { ids: [done.id, running.id] })).toEqual({
    removed: [done.id],
    clean: [],
    skipped: [{ id: running.id, reason: 'still running' }],
  })
  expect([done.kept, second].map((d) => existsSync(d))).toEqual([false, false])
  const stay = [other.kept, running.kept, persons, openedTemp, movedTemp]
  expect(stay.map((d) => existsSync(join(d, 'scratchpad', 'big')))).toEqual(stay.map(() => true))
})

test('gc leaves the temp folder of a task whose workspace Claude Code names as the collected one', async () => {
  const { home, base, ledger, task } = withTemps()
  // Each character but a letter or digit turns into `-`, so these two share a folder, as the
  // worktrees of branches `feat/a.b` and `feat/a-b` do.
  const dotted = task('dotted')
  const cwd = join(home, 'work', 'a.b')
  mkdirSync(cwd)
  ledger.setRunning(dotted.id, cwd)
  ledger.succeed(dotted.id)
  const dashed = task('dashed')
  mkdirSync(join(home, 'work', 'a-b'))
  ledger.setRunning(dashed.id, join(home, 'work', 'a-b'))
  ledger.succeed(dashed.id)
  const folder = dirname(tempFolder(base, cwd, '-'))
  for (const t of [dotted, dashed]) mkdirSync(join(folder, t.session), { recursive: true })

  const report = await collect(ledger, home, Tmux.of(home), { ids: [dotted.id] })
  expect(report.removed).toEqual([dotted.id])
  expect(existsSync(join(folder, dotted.session))).toBe(false)
  expect(existsSync(join(folder, dashed.session))).toBe(true)
})

test('gc collects a task whose temp folder it cannot remove, says why, and nod gc removes it later', async () => {
  const { home, ledger, task } = withTemps()
  const locked = task('locked')
  const other = task('other')
  chmodSync(join(locked.kept, 'scratchpad'), 0o555)
  const stays = {
    id: locked.id,
    reason: expect.stringMatching(
      // Bun 1.3.14 says EACCES, 1.4.4 ENOTEMPTY.
      /^collected, but gc could not remove its temp folders: (EACCES|ENOTEMPTY)/,
    ),
  }
  expect(await collect(ledger, home, Tmux.of(home), { ids: [locked.id, other.id] })).toEqual({
    removed: [locked.id, other.id],
    clean: [],
    skipped: [stays],
  })
  expect(ledger.get(locked.id).collectedAt).not.toBeNull()
  expect(existsSync(other.kept)).toBe(false)
  expect(dropTemps(ledger, home)).toEqual({ removed: [], skipped: [stays] })

  const [left = ''] = readdirSync(dirname(locked.kept))
  chmodSync(join(dirname(locked.kept), left, 'scratchpad'), 0o755)
  expect(dropTemps(ledger, home)).toEqual({ removed: [locked.id], skipped: [] })
  expect(existsSync(dirname(locked.kept))).toBe(false)
})

test('the temp folders of tasks collected before go once, with nod gc or as it names the task, not as the tick sweeps', async () => {
  const { home, shellBase, ledger, temp, task } = withTemps()
  // As nod left them before it recorded accounts, under the account of the shell.
  const old = task('old')
  const oldTemp = temp(old.cwd, old.session, shellBase)
  rmSync(old.cwd, { recursive: true })
  ledger.db.query('update tasks set account = null where id = $id').run({ id: old.id })
  ledger.collected(old.id, null)
  // As gc left them before it removed temp folders.
  const [first, named] = [task('first'), task('named')]
  for (const t of [first, named]) {
    rmSync(t.cwd, { recursive: true })
    ledger.collected(t.id, null)
  }
  const open = task('not collected')
  rmSync(open.cwd, { recursive: true })
  const running = task('brought back')
  ledger.collected(running.id, null)
  ledger.uncollected(running.id)
  ledger.setRunning(running.id, running.cwd)
  // One outside nod's work folder, as a home moved since leaves: not gc's to remove.
  const outside = task('outside')
  const away = tmp.make('nod-gc-away-')
  ledger.setRunning(outside.id, away)
  ledger.succeed(outside.id)
  ledger.collected(outside.id, null)
  const awayTemp = temp(away, outside.session)

  // sweep is what the tick runs.
  await sweep(ledger, home, Tmux.of(home), async () => null, new Date())
  expect(existsSync(first.kept)).toBe(true)

  expect(await collect(ledger, home, Tmux.of(home), { ids: [named.id] })).toEqual({
    removed: [named.id],
    clean: [],
    skipped: [],
  })
  expect(existsSync(named.kept)).toBe(false)
  expect(dropTemps(ledger, home)).toEqual({ removed: [old.id, first.id], skipped: [] })
  expect([oldTemp, first.kept].map((d) => existsSync(d))).toEqual([false, false])
  for (const t of [open.kept, running.kept, awayTemp]) expect(existsSync(t)).toBe(true)

  expect(dropTemps(ledger, home)).toEqual({ removed: [], skipped: [] })
  expect(await collect(ledger, home, Tmux.of(home), { ids: [named.id] })).toEqual({
    removed: [],
    clean: [named.id],
    skipped: [],
  })
})

test('a temp folder stays while a task not collected or a todo not closed names its session', async () => {
  const { home, base, ledger, task } = withTemps()
  const todos = new Todos(ledger)
  const free = task('named by nothing')
  const at = (session: string): string => `go by ${base}/x/${session}/scratchpad/bench`
  const todo = (title: string, notes: string | null, url: string | null): number =>
    todos.capture({ title, notes, source: 'cli', sourceKey: null, url }, 'human').todo.id

  // Each is named in one place only.
  const [brief, told, midTurn, yetToStart] = [
    task('brief'),
    task('told'),
    task('mid-turn'),
    task('yet to start'),
  ]
  const reader = task(at(brief.session))
  const attemptId = ledger.startAttempt({
    taskId: reader.id,
    kind: 'followup',
    decisionId: null,
    sessionId: reader.session,
    prompt: at(told.session),
  })
  ledger.addMessage(reader.id, attemptId, at(midTurn.session))
  ledger.setRunning(reader.id, reader.cwd)
  const queued = ledger.add({
    brief: 'queued',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [reader.id],
    issue: null,
  })
  ledger.keepTell(queued, reader.id, at(yetToStart.session))
  const [title, notes, link, linkTitle] = [
    task('title'),
    task('notes'),
    task('link'),
    task('link title'),
  ]
  const titled = todo(at(title.session), null, null)
  const noted = todo('read it', `first\n${at(notes.session)}`, null)
  todos.set(noted, { status: 'someday' }, 'human')
  const linked = todo('read it', null, `file://${base}/x/${link.session}/scratchpad/report.md`)
  todos.link(linked, 'https://example.com', at(linkTitle.session), 'human')
  // By one that gc collected, and by one that is closed.
  const [past, closed] = [task('past'), task('closed')]
  await collect(ledger, home, Tmux.of(home), { ids: [task(at(past.session)).id] })
  todos.finish([todo('read it', at(closed.session), null)], 'dropped', 'human')

  const namedIn = new Map([
    [brief, `n${reader.id}`],
    [told, `n${reader.id}`],
    [midTurn, `n${reader.id}`],
    [yetToStart, `n${queued}`],
    [title, `t${titled}`],
    [notes, `t${noted}`],
    [link, `t${linked}`],
    [linkTitle, `t${linked}`],
  ])
  const kept = [...namedIn.keys()]
  const gone = [free, past, closed]
  const there = (of: { kept: string }[]): boolean[] => of.map((t) => existsSync(t.kept))

  // As they are collected: the tasks themselves are, and nothing is said of the folders.
  const all = [...gone, ...kept].map((t) => t.id).sort((a, b) => a - b)
  expect(
    await collect(ledger, home, Tmux.of(home), { seen: all.map((id) => ledger.get(id)) }),
  ).toEqual({ removed: all, clean: [], skipped: [] })
  expect(there(gone)).toEqual(gone.map(() => false))
  expect(there(kept)).toEqual(kept.map(() => true))
  // Nor by the nod gc that looks at those collected before.
  expect(dropTemps(ledger, home)).toEqual({ removed: [], skipped: [] })
  expect(there(kept)).toEqual(kept.map(() => true))
  // Named, each says what names it.
  expect(await collect(ledger, home, Tmux.of(home), { ids: kept.map((t) => t.id) })).toEqual({
    removed: [],
    clean: kept.map((t) => t.id),
    skipped: [...namedIn].map(([t, ref]) => ({
      id: t.id,
      reason: `collected, but the temp folder of its session ${t.session} stays, named in ${ref}`,
    })),
  })
  expect(there(kept)).toEqual(kept.map(() => true))

  // Once the tasks are collected, a nod gc removes what they named; then what the todos did.
  ledger.succeed(reader.id)
  expect((await collect(ledger, home, Tmux.of(home), { ids: [reader.id] })).removed).toEqual([
    reader.id,
  ])
  expect(dropTemps(ledger, home)).toEqual({ removed: [brief.id, told.id, midTurn.id], skipped: [] })
  ledger.cancel(queued, 'dropped')
  ledger.collected(queued, null)
  expect(dropTemps(ledger, home)).toEqual({ removed: [yetToStart.id], skipped: [] })
  todos.finish([titled, linked], 'done', 'human')
  expect(dropTemps(ledger, home)).toEqual({
    removed: [title.id, link.id, linkTitle.id],
    skipped: [],
  })
  todos.finish([noted], 'dropped', 'human')
  expect(await collect(ledger, home, Tmux.of(home), { ids: [notes.id] })).toEqual({
    removed: [notes.id],
    clean: [],
    skipped: [],
  })
  expect(there(kept)).toEqual(kept.map(() => false))
})

test('gc of a named task says all that name its session as it collects it', async () => {
  const { home, ledger, task } = withTemps()
  const done = task('done')
  const reader = task(`as ${done.session} had it`)
  const { todo } = new Todos(ledger).capture(
    { title: 'x', notes: done.session, source: 'cli', sourceKey: null, url: null },
    'human',
  )
  const reason = `collected, but the temp folder of its session ${done.session} stays, named in n${reader.id}, t${todo.id}`
  expect(await collect(ledger, home, Tmux.of(home), { ids: [done.id] })).toEqual({
    removed: [done.id],
    clean: [],
    skipped: [{ id: done.id, reason }],
  })
  expect(existsSync(done.kept)).toBe(true)
})

test("a task told to go on as gc ends it keeps its worker's temp folder", async () => {
  const { home, ledger, task } = withTemps()
  const { id, cwd, kept } = task('told')
  // `nod tell` brings it back right after gc marked it collected.
  const mark = ledger.collectedAsRead.bind(ledger)
  const spy = spyOn(ledger, 'collectedAsRead').mockImplementation((...args) => {
    const marked = mark(...args)
    ledger.uncollected(id)
    ledger.setRunning(id, cwd)
    return marked
  })
  try {
    await collect(ledger, home, Tmux.of(home), { ids: [id] })
  } finally {
    spy.mockRestore()
  }
  expect(existsSync(kept)).toBe(true)

  // Once it ends again, gc takes the folder too.
  ledger.succeed(id)
  expect((await collect(ledger, home, Tmux.of(home), { ids: [id] })).removed).toEqual([id])
  expect(existsSync(kept)).toBe(false)
})

// A finished task of a repo of its own under `home`, with its worktree, and its marking commands.
function repoTask(home: string, branch: string) {
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-gc-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  git(home, 'init', '-q', repo)
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const id = ledger.add({
    brief: branch,
    repo,
    branch,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
  ledger.setRunning(id, cwd)
  const sessionId = `session-${id}`
  ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId, prompt: branch })
  ledger.succeed(id)
  const sessions = projectFolder(process.env.CLAUDE_CONFIG_DIR, cwd)
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(sessions, `${sessionId}.jsonl`), '{}\n')
  return { ledger, repo, id, cwd, ...marking(tmp.make('nod-gc-marks-')) }
}

test('gc runs none of the commands named in the config of a submodule its worker made', async () => {
  const home = tmp.make('nod-gc-')
  const { ledger, id, cwd, command, ran } = repoTask(home, 'feat/sub')
  workerSubmodules(cwd, command)

  expect(await collect(ledger, home, Tmux.of(home), { ids: [id] })).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id, reason: 'uncommitted changes in worktree' }],
  })
  expect(ran()).toEqual([])
}, 30_000)

test('gc looks for a submodule commit in the repo’s own checkout of it without fetching it', () => {
  const dir = tmp.make('nod-gc-')
  const { command, ran } = marking(tmp.make('nod-gc-marks-'))
  const files = ['-c', 'protocol.file.allow=always']
  const lib = join(dir, 'lib')
  git(dir, 'init', '-q', lib)
  git(lib, 'commit', '-q', '--allow-empty', '-m', 'one')
  const repo = join(dir, 'repo')
  git(dir, 'init', '-q', repo)
  git(repo, ...files, 'submodule', 'add', '-q', lib, 'lib')
  git(repo, 'commit', '-q', '-m', 'add lib')
  const cwd = join(dir, 'work')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/sub', cwd)
  git(
    cwd,
    ...files,
    '-c',
    `submodule.lib.url=${join(repo, 'lib')}`,
    'submodule',
    'update',
    '-q',
    '--init',
  )
  git(join(cwd, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'only here')
  // The repo's checkout of it, a partial clone whose config names the upload-pack a fetch runs.
  const config = {
    'core.repositoryformatversion': '1',
    'extensions.partialClone': 'origin',
    'remote.origin.promisor': 'true',
    'remote.origin.uploadpack': command('upload-pack'),
  }
  for (const [key, value] of Object.entries(config)) git(join(repo, 'lib'), 'config', key, value)

  expect(onlyCopy(repo, cwd, 'feat/sub')).toBe('submodule lib has commits no remote has')
  expect(ran()).toEqual([])
}, 30_000)

test('gc fetches nothing for a submodule git folder of the worktree, whose config its worker can write', async () => {
  const home = tmp.make('nod-gc-')
  const { repo, cwd, command, ran } = repoTask(home, 'feat/sub')
  // A partial clone's, with a branch at a commit it lacks.
  const lib = join(resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'modules')), 'lib')
  git(home, 'init', '-q', '--bare', lib)
  const config = {
    'core.repositoryformatversion': '1',
    'extensions.partialClone': 'origin',
    'remote.origin.url': repo,
    'remote.origin.promisor': 'true',
    'remote.origin.uploadpack': command('upload-pack'),
  }
  for (const [key, value] of Object.entries(config)) git(lib, 'config', key, value)
  writeFileSync(join(lib, 'refs', 'heads', 'x'), '0123456789012345678901234567890123456789\n')

  expect(() => onlyCopy(repo, cwd, 'feat/sub')).toThrow('bad object refs/heads/x')
  expect(ran()).toEqual([])
}, 30_000)

test('whether the default branch has a branch’s changes reads a submodule as its commit, whatever diff.submodule the person set', () => {
  const repo = tmp.make('nod-gc-repo-')
  const { command, ran } = marking(tmp.make('nod-gc-marks-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'checkout', '-q', '-b', 'feat/t')
  textconvSubmodule(repo, command)
  git(repo, 'config', 'diff.submodule', 'diff')
  // The default branch has the submodule at its first commit, the branch at its second.
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'feat/t~1')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

  expect(landed(repo, 'refs/heads/feat/t')).toBe(false)
  expect(ran()).toEqual([])
}, 30_000)

// A task whose repo's config names a hooks folder in each worktree, as husky's does, and whose
// worker committed hooks there, with a file git looks at again so that git status writes the index.
function hookedTask(home: string) {
  const task = repoTask(home, 'feat/hook')
  const { repo, cwd, command } = task
  git(repo, 'config', 'core.hooksPath', '.husky/_')
  const hooks = huskyHooks(cwd, command)
  writeFileSync(join(cwd, 'x.txt'), 'x')
  git(cwd, 'add', '.husky', 'x.txt')
  git(cwd, 'commit', '-q', '-m', 'hooks')
  git(cwd, 'update-index', '--cacheinfo', `100644,${git(cwd, 'rev-parse', 'HEAD:x.txt')},x.txt`)
  return { ...task, hooks }
}

test('gc runs none of the hooks a branch brings into a hooks folder its repo names in the worktree', async () => {
  const home = tmp.make('nod-gc-')
  const { ledger, id, ran } = hookedTask(home)

  expect((await collect(ledger, home, Tmux.of(home), { ids: [id] })).removed).toEqual([id])
  expect(ran()).toEqual([])
}, 30_000)

test('resume brings a worktree back without running the hooks its branch brings', async () => {
  const home = tmp.make('nod-gc-')
  const { ledger, id, hooks, ran, forget } = hookedTask(home)
  await collect(ledger, home, Tmux.of(home), { ids: [id] })
  forget()

  await restore(ledger, home, id)
  expect(existsSync(join(hooks, 'post-index-change'))).toBe(true)
  expect(ran()).toEqual([])
}, 30_000)

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
