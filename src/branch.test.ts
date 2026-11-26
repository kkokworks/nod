import { afterAll, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { marking, workerSubmodules } from '../test/git-commands'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { NO_LAZY_FETCH, onRemote, rebaseEnv, unmergedFiles, worktreeStatus } from './branch'

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
