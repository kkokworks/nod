import { expect, test } from 'bun:test'
import { pullRequests, verdict } from './prs'

test("the verdict is the person's last approval or request for changes; comments and others' reviews do not count", () => {
  const r = (login: string, state: string) => ({ login, state })
  expect(verdict([], 'me')).toBeNull()
  expect(verdict([r('me', 'COMMENT'), r('other', 'APPROVED')], 'me')).toBeNull()
  expect(verdict([r('me', 'REQUEST_CHANGES'), r('me', 'APPROVED')], 'me')).toBe('approved')
  expect(verdict([r('me', 'APPROVED'), r('me', 'CHANGES_REQUESTED')], 'me')).toBe('changes')
  expect(verdict([r('me', 'APPROVED'), r('me', 'COMMENTED')], 'me')).toBe('approved')
})

test('a link that is not a pull request reads as null without asking any service', async () => {
  const lookup = pullRequests('/')
  expect(await lookup('https://chat.example.com/archives/C1/p2')).toBeNull()
  expect(await lookup('https://git.example.com/o/r/issues/3')).toBeNull()
})
