import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionReason, Task } from './ledger'

const NOTIFY_TIMEOUT_MS = 10_000
// How long a run waits, once its process has ended, for its output to close.
const OUTPUT_GRACE_MS = 500

type TaskRef = { id: number; brief: string; issue: string | null }

export type NotifyEvent =
  | {
      event: 'decision'
      task: TaskRef
      decision: { id: number; reason: DecisionReason; question: string }
    }
  | {
      event: 'answered'
      task: TaskRef
      decision: { id: number; reason: DecisionReason; answer: string }
    }
  | { event: 'succeeded'; task: TaskRef; summary: string }
  | { event: 'cancelled'; task: TaskRef }
  | { event: 'error'; task: TaskRef; error: string }
  // A worker's Claude Code is due to start again, but a person is attached to its terminal.
  | { event: 'restart_held'; task: TaskRef; reason: string }
  | { event: 'trigger_failed'; trigger: { id: number; cron: string }; error: string }
  | { event: 'watch_passed'; todo: { id: number; title: string }; watch: string }
  | { event: 'watch_failed'; todo: { id: number; title: string }; watch: string; error: string }

export const taskRef = (t: Task): TaskRef => ({ id: t.id, brief: t.brief, issue: t.issue })

// Runs `<home>/notify`, if the human made one, with the event as JSON on stdin: how a person hears
// about a decision while away from the Claude session. A notification that fails, or cannot run at
// all (not executable, no #! line), is reported on stderr and changes nothing else, since the
// ledger already holds the event.
export async function notify(
  home: string,
  event: NotifyEvent,
  timeoutMs = NOTIFY_TIMEOUT_MS,
): Promise<void> {
  const script = join(home, 'notify')
  if (!existsSync(script)) return
  try {
    const { code, stderr } = await runGroup([script], {
      env: process.env,
      stdin: JSON.stringify(event),
      timeoutMs,
    })
    if (code !== 0)
      console.error(`nod: ${script} exited ${code} on ${event.event}: ${stderr.trim()}`)
  } catch (error) {
    console.error(`nod: could not run ${script} on ${event.event}: ${String(error)}`)
  }
}

// Runs a command in a process group of its own, so the timeout ends all of a pipeline: killing only
// the first process leaves the rest holding its output open, and the wait goes on (measured). Once
// the command has ended, killed or not, what still holds its output (one it put in the background,
// one that left the group with setsid and outlived the kill) is not waited for past a short grace:
// the run returns what it read by then, and what was left keeps running. The sources and watches
// run here too (shell).
export async function runGroup(
  cmd: string[],
  opts: {
    cwd?: string
    env: Record<string, string | undefined>
    stdin?: string
    timeoutMs: number
    // How long output is waited on once the command has ended; a test sets it.
    graceMs?: number
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  // Readers, not Response.text(): a read that is let go must be cancelled, or Bun stays up until the
  // process holding the pipe ends (measured). What each has read is kept as it comes.
  const read = { stdout: '', stderr: '' }
  const readers = { stdout: proc.stdout.getReader(), stderr: proc.stderr.getReader() }
  const output = Promise.all(
    (['stdout', 'stderr'] as const).map(async (key) => {
      const decoder = new TextDecoder()
      for (let r = await readers[key].read(); !r.done; r = await readers[key].read()) {
        read[key] += decoder.decode(r.value, { stream: true })
      }
      read[key] += decoder.decode()
    }),
  )
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      // The group has ended already.
    }
  }, opts.timeoutMs)
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    const code = await proc.exited
    // Ended in time, it is not killed while its output is waited on.
    clearTimeout(timer)
    await Promise.race([
      output,
      new Promise((resolve) => {
        grace = setTimeout(resolve, opts.graceMs ?? OUTPUT_GRACE_MS)
      }),
    ])
    return { code, ...read }
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    await Promise.all([readers.stdout.cancel(), readers.stderr.cancel()])
  }
}
