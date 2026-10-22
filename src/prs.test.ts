import { expect, test } from 'bun:test'
import { approvedAt, pullRequests } from './prs'

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
