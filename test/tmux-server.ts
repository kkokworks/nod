import { test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { socketsParent } from './tmp'

// Why to skip the tests that need a tmux server, or null to run them. `up`: whether a server
// answered once started; tmux exits 0 even when it cannot make the server's socket.
// Measured in a Claude Code worker sandbox (tmux 3.6a, Claude Code 2.1.310): new-session prints
// `error creating <socket> (Operation not permitted)`, exits 0, and no server answers. Claude Code
// adds SANDBOX_RUNTIME=1 to the environment of only the commands it runs in its sandbox, with
// the sandbox's TMPDIR and proxy. Skipping takes both, and anything else that keeps tmux from
// starting fails the run: nod's check runs these tests outside the sandbox and must not pass
// without them. A worker nod starts now has a folder its sandbox lets it keep sockets in
// (NOD_SOCKETS), where the probe and the tests make theirs, so they run there too; the skip stays
// for a worker started before that, and any sandbox without the rule.
export function tmuxSkip(
  up: boolean,
  stderr: string,
  env: Record<string, string | undefined>,
): string | null {
  if (up) return null
  if (env.SANDBOX_RUNTIME === '1' && stderr.includes('(Operation not permitted)')) {
    return "tmux cannot start a server in this sandbox: skipping the tests that need one, which nod's check runs outside it"
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
