import { afterAll, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calls, clonedRepo, fakeService, git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { approvedAt, pullRequests, remoteOf, serviceOf } from './prs'

test("the approval is the person's last approval or request for changes, if it approved; comments and others' reviews do not count", () => {
  const r = (login: string, state: string, at: string) => ({ login, state, at })
  expect(approvedAt([], 'me')).toBeNull()
  expect(approvedAt([r('me', 'COMMENT', '1'), r('other', 'APPROVED', '2')], 'me')).toBeNull()
  expect(approvedAt([r('me', 'REQUEST_CHANGES', '1'), r('me', 'APPROVED', '2')], 'me')).toBe('2')
  expect(approvedAt([r('me', 'APPROVED', '1'), r('me', 'CHANGES_REQUESTED', '2')], 'me')).toBeNull()
  expect(approvedAt([r('me', 'APPROVED', '1'), r('me', 'COMMENTED', '2')], 'me')).toBe('1')
})

test('a link that is not a pull request reads as null without asking any service', async () => {
  const lookup = pullRequests('/')
  expect(await lookup('https://chat.example.com/archives/C1/p2')).toBeNull()
  expect(await lookup('https://git.example.com/o/r/issues/3')).toBeNull()
})

test('a remote reads as its host and owner/repo however git takes it', () => {
  expect(remoteOf('https://github.com/o/r.git')).toEqual({ host: 'github.com', path: 'o/r' })
  expect(remoteOf('git@github.com:o/r.git\n')).toEqual({ host: 'github.com', path: 'o/r' })
  expect(remoteOf('ssh://git@git.example.com:2222/o/r')).toEqual({
    host: 'git.example.com',
    path: 'o/r',
  })
  expect(() => remoteOf('/srv/repos/r')).toThrow('a remote nod cannot read')
})

describe('nod opens and squash merges its pull requests through the repo service', () => {
  const tmp = tempDirs()
  afterAll(tmp.removeAll)
  const state = tmp.make('nod-service-')
  fakeService(tmp.make('nod-service-bin-'), state)

  for (const [tool, url] of [
    ['gh', 'https://github.com/o/r'],
    ['tea', 'https://git.example.com/o/r'],
  ] as const) {
    test(`${tool}: opens, finds, reads and merges only the head it was given`, async () => {
      const own = join(state, tool)
      process.env.FAKE_SERVICE = own
      const { repo, origin } = clonedRepo(tmp.make, own, url)
      writeFileSync(join(repo, 'a.txt'), 'a\n')
      git(repo, 'checkout', '-qb', 'feat/a')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-qm', 'add a')
      git(repo, 'push', '-q', 'origin', 'feat/a')
      const head = git(repo, 'rev-parse', 'HEAD')

      const service = serviceOf(repo)
      expect(service.name).toBe(tool)
      expect(await service.find('feat/a')).toBeNull()
      const pr = await service.open({ base: 'main', head: 'feat/a', title: 'Add a', body: 'Body' })
      expect(pr).toMatch(tool === 'gh' ? /^https:\/\/github\.com\/o\/r\/pull\/1$/ : /pulls\/1$/)
      expect(await service.find('feat/a')).toBe(pr)
      expect(await service.view(pr)).toMatchObject({ state: 'open', head, merge: 'clean' })

      // A head that moved since nod checked it is not merged.
      const moved = { head: 'f'.repeat(40), title: 'Add a', body: '' }
      await expect(service.merge(pr, moved)).rejects.toThrow()
      expect((await service.view(pr)).state).toBe('open')
      await service.merge(pr, { head, title: 'Add a', body: 'Body' })
      expect((await service.view(pr)).state).toBe('merged')
      // A later task given the same branch name is not that merged pull request's.
      expect(await service.find('feat/a')).toBeNull()
      // One commit on main with the branch's files, and no merge commit.
      expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['Add a', 'init'])
      expect(git(origin, 'show', 'main:a.txt')).toBe('a')
      expect(git(origin, 'rev-list', '--merges', 'main')).toBe('')
      const opened = calls(own).find((c) => c.args.includes('create') || c.args.includes('POST'))
      expect(opened?.stdin).toContain('Body')
    })
  }

  test('gh: a pull request behind, waiting on a review, in conflict or not worked out yet is not clean', async () => {
    const own = join(state, 'gh-states')
    process.env.FAKE_SERVICE = own
    const { repo } = clonedRepo(tmp.make, own, 'https://github.com/o/r')
    git(repo, 'checkout', '-qb', 'feat/b')
    git(repo, 'push', '-q', 'origin', 'feat/b')
    const service = serviceOf(repo)
    const pr = await service.open({ base: 'main', head: 'feat/b', title: 'B', body: '' })
    for (const [status, merge] of [
      ['BEHIND', 'behind'],
      ['BLOCKED', 'blocked'],
      ['DIRTY', 'conflict'],
      ['UNKNOWN', 'unknown'],
      // Pre-receive hooks that may yet refuse it: not clean either.
      ['HAS_HOOKS', 'blocked'],
    ] as const) {
      writeFileSync(join(own, 'merge-state'), status)
      expect((await service.view(pr)).merge).toBe(merge)
    }
  })
})
