import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calls, clonedRepo, fakeService, git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import {
  approvedAt,
  prAddress,
  prReads,
  pullRequests,
  remoteOf,
  ServiceDown,
  sameRepo,
  serviceOf,
} from './prs'

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

test('a link reads as the address of its pull request, without what follows it', () => {
  const gh = 'https://github.com/o/r/pull/12'
  const ge = 'https://git.example.com/o/r/pulls/3'
  expect([gh, `${gh}/files`, `${gh}#pullrequestreview-4`].map(prAddress)).toEqual([gh, gh, gh])
  expect([ge, `${ge}#issuecomment-9`].map(prAddress)).toEqual([ge, ge])
  expect(prAddress('https://chat.example.com/archives/C1/p2')).toBeNull()
  expect(prAddress('https://git.example.com/o/r/issues/3')).toBeNull()
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

test('two remotes are one repo however each is written, and one missing or unreadable is none', () => {
  expect(sameRepo('https://github.com/o/r', 'git@github.com:O/R.git\n')).toBe(true)
  expect(sameRepo('https://git.example.com/o/r', 'ssh://git@git.example.com:2222/o/r/')).toBe(true)
  expect(sameRepo('https://github.com/o/r', 'https://github.com/fork/r')).toBe(false)
  expect(sameRepo('https://github.com/o/r', 'https://git.example.com/o/r')).toBe(false)
  expect(sameRepo('https://github.com/o/r', null)).toBe(false)
  expect(sameRepo(null, null)).toBe(false)
  expect(sameRepo('/srv/repos/r', '/srv/repos/r')).toBe(false)
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
      expect(await pullRequests(repo)(pr)).toEqual({
        state: 'open',
        head: 'feat/a',
        headRepo: url,
        mergedAt: null,
        approvedAt: null,
        author: 'me',
        sha: head,
        reviews: [],
      })
      // A head in a fork reads as the fork's repo; one in a fork since deleted, as none.
      writeFileSync(join(own, 'head-repo'), 'fork/r')
      expect((await pullRequests(repo)(pr))?.headRepo).toBe(url.replace('/o/', '/fork/'))
      writeFileSync(join(own, 'head-repo'), '')
      expect((await pullRequests(repo)(pr))?.headRepo).toBeNull()
      rmSync(join(own, 'head-repo'))

      // A head that moved since nod checked it is not merged.
      const moved = { head: 'f'.repeat(40), title: 'Add a', body: '' }
      await expect(service.merge(pr, moved)).rejects.toThrow()
      expect((await service.view(pr)).state).toBe('open')
      await service.merge(pr, { head, title: 'Add a', body: 'Body' })
      expect((await service.view(pr)).state).toBe('merged')
      // A later task given the same branch name is not that merged pull request's.
      expect(await service.find('feat/a')).toBeNull()
      // The merged branch deleted on the remote still reads as the pull request's head.
      git(origin, 'update-ref', '-d', 'refs/heads/feat/a')
      expect(await pullRequests(repo)(pr)).toEqual({
        state: 'merged',
        head: 'feat/a',
        headRepo: url,
        mergedAt: expect.any(String),
        approvedAt: null,
        author: 'me',
        sha: expect.any(String),
        reviews: [],
      })
      // One commit on main with the branch's files, and no merge commit.
      expect(git(origin, 'log', '--format=%s', 'main').split('\n')).toEqual(['Add a', 'init'])
      expect(git(origin, 'show', 'main:a.txt')).toBe('a')
      expect(git(origin, 'rev-list', '--merges', 'main')).toBe('')
      const opened = calls(own).find((c) => c.args.includes('create') || c.args.includes('POST'))
      expect(opened?.stdin).toContain('Body')
    }, 30_000)
  }

  // A pull request each tool reads, with the folder the fake keeps its files in.
  const opened = async (tool: 'gh' | 'tea', name: string) => {
    const own = join(state, name)
    process.env.FAKE_SERVICE = own
    const url = tool === 'gh' ? 'https://github.com/o/r' : 'https://git.example.com/o/r'
    const { repo } = clonedRepo(tmp.make, own, url)
    git(repo, 'checkout', '-qb', 'feat/e')
    git(repo, 'push', '-q', 'origin', 'feat/e')
    const pr = await serviceOf(repo).open({ base: 'main', head: 'feat/e', title: 'E', body: '' })
    const keep = (file: string, json: unknown) =>
      writeFileSync(join(own, file), typeof json === 'string' ? json : JSON.stringify(json))
    return { own, repo, pr, head: git(repo, 'rev-parse', 'HEAD'), keep }
  }

  test('gh: reviews read as who, what and when, and nothing of what they wrote', async () => {
    const { repo, pr, head, keep } = await opened('gh', 'gh-reviews')
    const at = '2026-03-09T01:00:00Z'
    keep('reviews', [
      { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: at, body: 'Drop it' },
      { author: null, state: 'COMMENTED', submittedAt: at, body: '' },
      { author: { login: 'me' }, state: 'PENDING', submittedAt: null, body: 'draft' },
    ])
    const read = await pullRequests(repo)(pr)
    expect(read).toMatchObject({ author: 'me', sha: head })
    expect(read?.reviews).toEqual([
      { id: `alice ${at}`, login: 'alice', state: 'CHANGES_REQUESTED', at, comments: 0 },
      { id: ` ${at}`, login: null, state: 'COMMENTED', at, comments: 0 },
      { id: 'me null', login: 'me', state: 'PENDING', at: null, comments: 0 },
    ])
  })

  test('tea: reviews read past the first page, one dismissed as that, and the comments of each with who wrote them', async () => {
    const { own, repo, pr, head, keep } = await opened('tea', 'tea-reviews')
    const at = '2026-03-09T01:00:00Z'
    const review = (id: number, login: string, state: string, more: object = {}) => ({
      id,
      user: { login },
      state,
      submitted_at: at,
      comments_count: 0,
      body: 'Drop it',
      ...more,
    })
    const many = Array.from({ length: 100 }, (_, i) => review(i + 1, 'bob', 'COMMENT'))
    keep('reviews', [
      ...many,
      review(101, 'me', 'APPROVED', { dismissed: true }),
      review(102, 'alice', 'REQUEST_CHANGES', { comments_count: 2, dismissed: false }),
    ])
    const read = await pullRequests(repo)(pr)
    expect(read).toMatchObject({ author: 'me', sha: head, approvedAt: null })
    expect(read?.reviews).toHaveLength(102)
    expect(read?.reviews.slice(100)).toEqual([
      { id: '101', login: 'me', state: 'DISMISSED', at, comments: 0 },
      { id: '102', login: 'alice', state: 'REQUEST_CHANGES', at, comments: 2 },
    ])
    // A page full to the end asks for one more, which is empty.
    keep('reviews', many.slice(0, 50))
    expect((await pullRequests(repo)(pr))?.reviews).toHaveLength(50)
    expect(calls(own).filter((c) => /reviews\?/.test(c.args.at(-1) ?? ''))).toHaveLength(3 + 2)

    keep('comments-102', [
      { id: 7, user: { login: 'alice' }, created_at: at, body: 'Drop it' },
      { id: 8, user: null, created_at: at, body: 'no' },
    ])
    expect(await prReads(repo).comments(pr, '102')).toEqual([
      { id: '7', login: 'alice', at },
      { id: '8', login: null, at },
    ])
  }, 30_000)

  test('gh: CI failed once the last run of a check failed, not one run again, waiting, stopped or skipped', async () => {
    const { repo, pr, head, keep } = await opened('gh', 'gh-checks')
    const failed = async (checks: unknown) => {
      keep('checks', checks)
      return (await prReads(repo).failedHead(pr, 'as looked up')) !== null
    }
    const run = (conclusion: string, startedAt: string, name = 'test') => ({
      __typename: 'CheckRun',
      name,
      workflowName: 'CI',
      status: conclusion === '' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion,
      startedAt,
    })
    const status = (state: string) => ({ __typename: 'StatusContext', context: 'ci/x', state })
    expect(await failed(null)).toBe(false)
    expect(await failed([])).toBe(false)
    expect(await failed([run('SUCCESS', '2026-03-09T01:00:00Z'), status('PENDING')])).toBe(false)
    for (const conclusion of ['CANCELLED', 'SKIPPED', 'NEUTRAL', 'ACTION_REQUIRED', 'STALE', '']) {
      expect(await failed([run(conclusion, '2026-03-09T01:00:00Z')])).toBe(false)
    }
    for (const conclusion of ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']) {
      expect(
        await failed([run('SUCCESS', '2026-03-09T01:00:00Z', 'lint'), run(conclusion, '')]),
      ).toBe(true)
    }
    for (const state of ['FAILURE', 'ERROR']) expect(await failed([status(state)])).toBe(true)
    // Run again, newest first or last: only the last run counts.
    const runs = [run('SUCCESS', '2026-03-09T02:00:00Z'), run('FAILURE', '2026-03-09T01:00:00Z')]
    expect([await failed(runs), await failed(runs.toReversed())]).toEqual([false, false])
    expect(
      await failed([run('FAILURE', '2026-03-09T01:00:00Z'), run('', '2026-03-09T02:00:00Z')]),
    ).toBe(false)
    expect(
      await failed([
        run('SUCCESS', '2026-03-09T01:00:00Z'),
        run('FAILURE', '2026-03-09T02:00:00Z'),
      ]),
    ).toBe(true)
    // The head is the one the checks were read with.
    expect(await prReads(repo).failedHead(pr, 'as looked up')).toBe(head)
  }, 30_000)

  test('tea: CI failed as the head commit says in all, with no call for its runs', async () => {
    const { own, repo, pr, head, keep } = await opened('tea', 'tea-checks')
    const reads = prReads(repo)
    expect(await reads.failedHead(pr, head)).toBeNull()
    for (const [state, failed] of [
      ['failure', head],
      ['error', head],
      ['pending', null],
      ['success', null],
      ['warning', null],
      ['', null],
    ] as const) {
      keep('checks', { state, statuses: [] })
      expect(await reads.failedHead(pr, head)).toBe(failed)
    }
    keep('checks', 'null')
    expect(await reads.failedHead(pr, head)).toBeNull()
    const asked = calls(own).map((c) => c.args.at(-1) ?? '')
    expect(asked.filter((a) => a.includes(`/commits/${head}/status`))).toHaveLength(8)
    expect(asked.filter((a) => a.includes('actions'))).toEqual([])
  }, 30_000)

  for (const [tool, said, down] of [
    ['gh', 'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)', true],
    ['gh', 'HTTP 429: too many requests (https://api.github.com/graphql)', true],
    ['gh', 'GraphQL: API rate limit already exceeded for user ID 1.', true],
    ['gh', 'HTTP 403: You have exceeded a secondary rate limit.', true],
    ['gh', 'error connecting to api.github.com', true],
    ['gh', 'GraphQL: Could not resolve to a PullRequest with the number of 502.', false],
    ['gh', 'HTTP 404: Not Found (https://api.github.com/graphql)', false],
    ['tea', 'HTTP/2.0 500 Internal Server Error\n{"message":"oops"}', true],
    ['tea', 'HTTP/1.1 429 Too Many Requests\n{"message":"slow down"}', true],
    ['tea', 'HTTP/1.1 503 Service Unavailable\n<html>busy</html>', true],
    ['tea', 'HTTP/1.1 403 Forbidden\n<html>who are you</html>', true],
    ['tea', 'HTTP/1.1 200 OK\n<html>please log in</html>', true],
    ['tea', 'HTTP/2.0 404 Not Found\n{"message":"not found"}', false],
    ['tea', 'HTTP/2.0 403 Forbidden\n{"message":"not yours"}', false],
  ] as const) {
    test(`${tool}: ${said.split('\n').join(' ')} is of ${down ? 'the service' : 'its pull request'}`, async () => {
      const own = join(state, 'down')
      process.env.FAKE_SERVICE = own
      clonedRepo(tmp.make, own, 'https://github.com/o/r')
      writeFileSync(join(own, 'down'), said)
      const cwd = tmp.make('nod-down-')
      const pr =
        tool === 'gh' ? 'https://github.com/o/r/pull/502' : 'https://git.example.com/o/r/pulls/502'
      // One after the other: one that fails meanwhile with nothing waiting on it fails the test.
      for (const read of [() => pullRequests(cwd)(pr), () => prReads(cwd).failedHead(pr, 'abc')]) {
        const error = await read()
          .then(() => null)
          .catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect(error instanceof ServiceDown).toBe(down)
      }
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
