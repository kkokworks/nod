import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { marking, workerSubmodules } from '../test/git-commands'
import { GIT, git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import {
  NO_LAZY_FETCH,
  onRemote,
  rebaseEnv,
  sharedGitDenies,
  unmergedFiles,
  worktreeStatus,
} from './branch'

const tmp = tempDirs()
afterAll(tmp.removeAll)

// git status and diff run git in each submodule, with that one's config; a worker writes that
// config for one it made, or for one of the repo's (.git/worktrees/<worktree>/modules).
test("nod's git status and diff in a worktree run none of the commands named in the config of a submodule its worker made", async () => {
  const dir = tmp.make('nod-branch-')
  const { command, ran } = marking(dir)
  const ws = join(dir, 'ws')
  git(dir, 'init', '-q', ws)
  git(ws, 'commit', '-q', '--allow-empty', '-m', 'init')
  workerSubmodules(ws, command)

  await unmergedFiles(ws)
  expect(ran()).toEqual([])
  expect((await worktreeStatus(ws)).code).not.toBe(0)
  expect(ran()).toEqual([])
}, 30_000)

test("nod's fetch does not go on into a submodule, whose config names its own remote command", async () => {
  const dir = tmp.make('nod-branch-')
  const { command, ran } = marking(dir)
  const files = ['-c', 'protocol.file.allow=always']
  const lib = join(dir, 'lib')
  git(dir, 'init', '-q', lib)
  git(lib, 'commit', '-q', '--allow-empty', '-m', 'one')
  const origin = join(dir, 'origin.git')
  git(dir, 'init', '-q', '--bare', origin)
  const other = join(dir, 'other')
  git(dir, 'clone', '-q', origin, other)
  git(other, ...files, 'submodule', 'add', '-q', lib, 'lib')
  git(other, 'commit', '-q', '-m', 'add lib')
  git(other, 'push', '-q', 'origin', 'HEAD')
  const repo = join(dir, 'repo')
  git(dir, ...files, 'clone', '-q', '--recurse-submodules', origin, repo)
  // Someone else moves the submodule on the remote, and its config in the repo names a command.
  git(lib, 'commit', '-q', '--allow-empty', '-m', 'two')
  git(join(other, 'lib'), 'pull', '-q', 'origin', 'HEAD')
  git(other, 'commit', '-q', '-am', 'move lib')
  git(other, 'push', '-q', 'origin', 'HEAD')
  const modules = join(resolve(repo, git(repo, 'rev-parse', '--git-path', 'modules')), 'lib')
  git(modules, 'config', 'remote.origin.uploadpack', command('upload-pack'))

  const fetched = await onRemote(repo, ['fetch', '-q', 'origin'])
  expect(ran()).toEqual([])
  expect(fetched.code).toBe(0)
}, 30_000)

test('a rebase fetches nothing it lacks, unless the repo is a partial clone itself', () => {
  const ws = tmp.make('nod-branch-')
  git(ws, 'init', '-q')
  expect(rebaseEnv(ws)).toEqual(NO_LAZY_FETCH)
  git(ws, 'config', 'extensions.partialClone', 'origin')
  expect(rebaseEnv(ws)).toEqual({})
})

// A repo whose main checkout is on main and whose remote's default branch is trunk, with a task's
// worktree on fix/own. Returns the repo, the worktree and the shared git folder.
function sharedRepo(): { repo: string; ws: string; common: string } {
  const dir = tmp.make('nod-branch-')
  const repo = join(dir, 'repo')
  git(dir, 'init', '-q', '-b', 'main', repo)
  // As git makes a repo by default, whatever this machine's git config says.
  git(repo, 'config', 'core.logAllRefUpdates', 'true')
  mkdirSync(join(repo, '.git', 'info'), { recursive: true })
  writeFileSync(join(repo, 'f'), 'base\n')
  git(repo, 'add', 'f')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  const ws = join(dir, 'own')
  git(repo, 'worktree', 'add', '-q', '-b', 'fix/own', ws)
  return { repo, ws, common: realpathSync(join(repo, '.git')) }
}

// What the worker's own work writes there (measured on git 2.53, docs/design.md): its branch, its
// log, the stash everyone shares, objects, its worktree's folder, and the lock a ref's deletion takes.
const OWN_WRITES = [
  'refs/heads/fix/own',
  'refs/heads/fix/own.lock',
  'logs/refs/heads/fix/own',
  'refs/stash',
  'logs/refs/stash',
  'packed-refs.lock',
  'objects/ab/cdef',
  'objects/pack/pack-1.pack',
  'worktrees/own/HEAD',
  'worktrees/own/index',
  'worktrees/own/rebase-merge/done',
]
const covers = (denied: string[], path: string): boolean =>
  denied.some((d) => path === d || path.startsWith(`${d}/`))

test("a worker's sandbox may not write the main checkout's own files, packed-refs or refs no worker moves in the shared git folder, and may write all its own work does", () => {
  const { repo, common } = sharedRepo()
  const denied = sharedGitDenies(repo, 'fix/own', 'darwin')
  const at = (...paths: string[]) => paths.map((p) => join(common, p))
  expect(denied).toEqual(
    expect.arrayContaining(
      at(
        ...['HEAD', 'HEAD.lock', 'index', 'index.lock', 'ORIG_HEAD', 'MERGE_HEAD', 'logs/HEAD'],
        ...['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'modules', 'info'],
        ...['packed-refs', 'packed-refs.new', 'refs/tags', 'refs/remotes', 'refs/replace'],
        // The branch the main checkout has out, and the remote's default branch, with their logs.
        ...['refs/heads/main', 'refs/heads/main.lock', 'logs/refs/heads/main'],
        ...['refs/heads/trunk', 'refs/heads/trunk.lock', 'logs/refs/heads/trunk'],
      ),
    ),
  )
  for (const path of at(...OWN_WRITES))
    expect({ path, denied: covers(denied, path) }).toEqual({ path, denied: false })

  // A task added from a linked worktree of the person's: that one's branch, and the main checkout's.
  const side = join(dirname(repo), 'side')
  git(repo, 'worktree', 'add', '-q', '-b', 'person/side', side)
  expect(sharedGitDenies(side, 'fix/own', 'darwin')).toEqual(
    expect.arrayContaining(at('refs/heads/person/side', 'refs/heads/main', 'refs/heads/trunk')),
  )

  // A task on the remote's default branch keeps it.
  expect(sharedGitDenies(repo, 'trunk', 'darwin')).not.toContain(join(common, 'refs/heads/trunk'))
  // A branch in the folder of the task's own stays open: the sandbox keeps a denied path's folders
  // from being made, and the worker's commit makes refs/heads/fix again once a gc packed it away.
  git(repo, 'switch', '-q', '-c', 'fix/human')
  const besides = sharedGitDenies(repo, 'fix/own', 'darwin')
  expect(besides.filter((p) => p.startsWith(join(common, 'refs/heads/')))).toEqual(
    at('refs/heads/trunk', 'refs/heads/trunk.lock'),
  )
  expect(sharedGitDenies(repo, 'feat/own', 'darwin')).toContain(
    join(common, 'refs/heads/fix/human'),
  )

  // On Linux only what is there and stays there: the sandbox would make the rest, a branch's loose
  // ref packed since too, as empty files in the repo while each command runs.
  expect(sharedGitDenies(repo, 'feat/own', 'linux')).toEqual(
    at('HEAD', 'index', 'info', 'logs/HEAD', 'refs/tags', 'refs/remotes'),
  )
  expect(existsSync(join(common, 'refs/heads/fix/human'))).toBe(true)

  // Nothing in a logs/ that is not there (a repo without reflogs), which a stash makes.
  rmSync(join(common, 'logs'), { recursive: true })
  expect(sharedGitDenies(repo, 'fix/own', 'darwin').filter((p) => p.includes('/logs'))).toEqual([])

  expect(sharedGitDenies(join(common, 'gone'), 'fix/own')).toEqual([])
})

// Shuts `paths` to git as the sandbox would, which a test cannot start inside a worker's own
// (sandbox-exec there fails with `sandbox_apply: Operation not permitted`): git writes a file through
// `<name>.lock` or `<name>.new` and moves it in place, which a folder of that name stops, and writes
// nothing that is there in place. Gives back what opens them again.
function shut(paths: string[]): () => void {
  const there = paths.filter((p) => existsSync(p))
  for (const p of paths) if (!existsSync(p)) mkdirSync(p, { recursive: true })
  const chmod = (mode: string) => {
    if (there.length > 0) Bun.spawnSync(['chmod', '-R', mode, ...there])
  }
  chmod('a-w')
  return () => chmod('u+w')
}

test("with those shut, a worker's commits, rebase through a conflict, stash, cherry-pick and merge in its worktree all go on, leaving no CHERRY_PICK_HEAD", () => {
  const { repo, ws, common } = sharedRepo()
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text)
    git(cwd, 'add', file)
    git(cwd, 'commit', '-q', '-m', file)
  }
  commit(repo, 'f', 'main\n')
  git(repo, 'switch', '-q', '-c', 'pick')
  commit(repo, 'p', 'pick\n')
  git(repo, 'switch', '-q', '-c', 'm', 'main')
  commit(repo, 'q', 'merge\n')
  git(repo, 'switch', '-q', 'main')
  // Packed as a gc leaves them, so the branch's next commit writes it loose again.
  git(repo, 'pack-refs', '--all')
  const before = git(repo, 'rev-parse', 'HEAD', 'main', 'refs/remotes/origin/trunk')
  const open = shut(sharedGitDenies(repo, 'fix/own', 'darwin'))
  try {
    commit(ws, 'f', 'own\n')
    const run = (...args: string[]) => Bun.spawnSync([...GIT, ...args], { cwd: ws })
    expect(run('rebase', 'main').exitCode).not.toBe(0)
    writeFileSync(join(ws, 'f'), 'both\n')
    git(ws, 'add', 'f')
    git(ws, '-c', 'core.editor=true', 'rebase', '--continue')
    writeFileSync(join(ws, 'f'), 'stashed\n')
    git(ws, 'stash', 'push', '-q')
    git(ws, 'stash', 'pop', '-q')
    git(ws, 'checkout', '-q', '--', 'f')
    git(ws, 'cherry-pick', 'pick')
    expect(run('rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD').exitCode).not.toBe(0)
    git(ws, 'merge', '-q', '--no-edit', 'm')
    git(ws, 'branch', 'tmp')
    git(ws, 'branch', '-D', 'tmp')
    expect(git(ws, 'log', '--first-parent', '--format=%s', '-4')).toBe(
      ["Merge branch 'm' into fix/own", 'p', 'f', 'f'].join('\n'),
    )
    expect(git(ws, 'stash', 'list')).toBe('')
    // And what it may not do, it cannot.
    expect(run('update-ref', 'refs/heads/main', 'HEAD').exitCode).not.toBe(0)
    expect(run('tag', 'v1').exitCode).not.toBe(0)
  } finally {
    open()
  }
  expect(git(repo, 'rev-parse', 'HEAD', 'main', 'refs/remotes/origin/trunk')).toBe(before)
  expect(common).toBe(realpathSync(join(repo, '.git')))
}, 30_000)
