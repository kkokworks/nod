import { afterAll, expect, test } from 'bun:test'
import { tmuxSkip, tmuxTest } from './tmux-server'

const denied = 'error creating /tmp/x/tmux-501/probe (Operation not permitted)\n'

test('tmux tests skip only in the sandbox that keeps tmux from starting, and fail anywhere else it cannot', () => {
  expect(tmuxSkip(false, denied, { SANDBOX_RUNTIME: '1' })).toContain('sandbox')
  // Outside the sandbox, nod's check must not pass without them.
  expect(() => tmuxSkip(false, denied, {})).toThrow(denied.trim())
  expect(() => tmuxSkip(false, 'tmux: no such file\n', { SANDBOX_RUNTIME: '1' })).toThrow()
  // A server that starts runs them, sandbox or not.
  expect(tmuxSkip(true, '', { SANDBOX_RUNTIME: '1' })).toBeNull()
  expect(tmuxSkip(true, '', {})).toBeNull()
})

// The same, as this run went: outside the sandbox a tmux test ran.
let ran = false
tmuxTest('a tmux test runs wherever it is not skipped', () => {
  ran = true
})
afterAll(() => {
  if (process.env.SANDBOX_RUNTIME !== '1') expect(ran).toBe(true)
})
