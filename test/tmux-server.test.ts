import { expect, test } from 'bun:test'
import { tmuxSkip, tmuxSkipped } from './tmux-server'

const denied = 'error creating /tmp/x/tmux-501/probe (Operation not permitted)\n'

test('tmux tests skip only in the sandbox that keeps tmux from starting, and fail anywhere else it cannot', () => {
  expect(tmuxSkip(false, denied, { SANDBOX_RUNTIME: '1' })).toContain('sandbox')
  // Outside the sandbox, nod's check must not pass without them.
  expect(() => tmuxSkip(false, denied, {})).toThrow(denied.trim())
  expect(() => tmuxSkip(false, 'tmux is not on PATH', { SANDBOX_RUNTIME: '1' })).toThrow()
  // A server that starts runs them, sandbox or not.
  expect(tmuxSkip(true, '', { SANDBOX_RUNTIME: '1' })).toBeNull()
  expect(tmuxSkip(true, '', {})).toBeNull()
})

test('this run skips tmux tests only in the sandbox', () => {
  if (process.env.SANDBOX_RUNTIME !== '1') expect(tmuxSkipped).toBeNull()
})
