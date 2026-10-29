import { test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { socketsParent } from './tmp'

// Why to skip the tests that need a tmux server, or null to run them. `up`: whether a server
// answered once started. Claude Code adds SANDBOX_RUNTIME=1 to the environment of only the
// commands it runs in its sandbox, with the sandbox's TMPDIR and proxy. Skipping takes that and
// tmux's `Operation not permitted`, which a sandbox gives it two ways (tmux 3.6a, measured):
// - No pseudo-terminal, in every worker nod starts now (Claude Code 2.1.312). Its sandbox lets it
//   keep sockets in its own folder (NOD_SOCKETS), where the probe makes its, but opens no
//   pseudo-terminal (`openpty: Operation not permitted`). new-session makes the socket, prints
//   `create window failed: fork failed: Operation not permitted`, exits 1, and the server ends at
//   once. worker.test.ts runs its workers in fake terminals for this (test/fake-terminals.ts).
// - No socket, where that folder is missing or of no use (a worker started before it, nod's
//   reviewer, too long a path: test/tmp.ts) and in other sandboxes (2.1.310). new-session prints
//   `error creating <socket> (Operation not permitted)`, exits 0, and no server answers.
// Anything else that keeps tmux from starting fails the run: nod's check runs these tests outside
// the sandbox, when it runs `bun test`, and must not pass without them.
export function tmuxSkip(
  up: boolean,
  stderr: string,
  env: Record<string, string | undefined>,
): string | null {
  if (up) return null
  if (env.SANDBOX_RUNTIME === '1' && stderr.includes('Operation not permitted')) {
    const blocked = stderr.includes('fork failed')
      ? 'opens no pseudo-terminal, so tmux cannot open a window'
      : 'lets tmux make no socket here'
    return (
      `skipping the tests that need a tmux server: this sandbox ${blocked} (${stderr.trim()}). ` +
      "They run outside the sandbox only when nod's check runs `bun test`: the task's acceptance " +
      'check, if it does, or the check nod runs as it lands the branch'
    )
  }
  throw new Error(`tmux cannot start a server: ${stderr.trim() || '(it said nothing)'}`)
}

// A session on a socket of its own, in a dir of its own, so it meets no other server.
function probe(): { up: boolean; stderr: string } {
  if (Bun.which('tmux') === null) return { up: false, stderr: 'tmux is not on PATH' }
  const dir = mkdtempSync(join(socketsParent(), 'nod-tmux-probe-'))
  const env = { ...process.env, TMUX_TMPDIR: dir }
  const tmux = (...args: string[]) => Bun.spawnSync(['tmux', '-L', 'probe', ...args], { env })
  try {
    // sleep, not true: the server ends with its last session, maybe before it is asked.
    const started = tmux('new-session', '-d', '-s', 'probe', 'sleep 30')
    const up = tmux('has-session', '-t', '=probe').exitCode === 0
    return { up, stderr: started.stderr.toString() }
  } finally {
    tmux('kill-server')
    rmSync(dir, { recursive: true, force: true })
  }
}

const { up, stderr } = probe()
// What `tmuxSkip` said for this run.
export const tmuxSkipped = tmuxSkip(up, stderr, process.env)
if (tmuxSkipped !== null) console.warn(tmuxSkipped)

// For a test that needs a tmux server: skipped where `tmuxSkip` says so, without waiting on one.
export const tmuxTest = test.skipIf(tmuxSkipped !== null)
