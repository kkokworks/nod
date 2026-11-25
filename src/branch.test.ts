import { afterAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { marking, workerSubmodules } from '../test/git-commands'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { unmergedFiles, worktreeStatus } from './branch'

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
