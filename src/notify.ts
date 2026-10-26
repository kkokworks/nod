import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tellSessions } from './inbox'
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
  // Landing a task (land.ts): the pull request nod opened, its merge, and what the landing waits on
  // or failed on, each time that changes.
  | { event: 'pr_opened'; task: TaskRef; url: string }
  | { event: 'merged'; task: TaskRef; url: string }
  | { event: 'landing'; task: TaskRef; note: string }
  | { event: 'trigger_failed'; trigger: { id: number; cron: string }; error: string }
  | { event: 'watch_passed'; todo: { id: number; title: string }; watch: string }
  | { event: 'watch_failed'; todo: { id: number; title: string }; watch: string; error: string }

export const taskRef = (t: Task): TaskRef => ({ id: t.id, brief: t.brief, issue: t.issue })

// First sends the project sessions what the ledger holds for them, this event's end or decision
// among it (inbox.ts). Then runs `<home>/notify`, if the human made one, with the event as JSON on
// stdin: how a person hears about a decision while away from the Claude session. A notification
// that fails, or cannot run at all (not executable, no #! line), is reported on stderr and changes
// nothing else, since the ledger already holds the event.
export async function notify(
  home: string,
  event: NotifyEvent,
  timeoutMs = NOTIFY_TIMEOUT_MS,
): Promise<void> {
  await tellSessions(home)
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

// The groups of the commands running now (runGroup). Out of this process's group, they would outlive
// a signal that ends it, and their limit with it: a Stop hook's check ran on after its session
// closed (review). Such a signal goes to them first, as it did in this process's group.
const running = new Set<number>()
const ENDING = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const

function killGroup(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group has ended already.
  }
}

function endRunning(signal: NodeJS.Signals): void {
  // A process with a handler of its own decides what the signal ends (the keeper ignores Ctrl-C).
  if (process.listenerCount(signal) > 1) return
  // The signal itself, not SIGKILL, so git removes its lock as it goes (review).
  for (const pid of running) killGroup(pid, signal)
  running.clear()
  for (const s of ENDING) process.off(s, endRunning)
  // The process ends on the signal, as it did without this handler.
  process.kill(process.pid, signal)
}

// Runs a command in a process group of its own, so the timeout ends all of a pipeline: killing only
// the first process leaves the rest holding its output open, and the wait goes on (measured). Once
// the command has ended, killed or not, what still holds its output (one it put in the background,
// one that left the group with setsid and outlived the kill) is not waited for past a short grace:
// the run returns what it read by then, and what was left keeps running. The sources and watches
// (shell) and the worker's commands (spawn) run here too.
export async function runGroup(
  cmd: string[],
  opts: {
    cwd?: string
    env: Record<string, string | undefined>
    stdin?: string
    // Without it, the command is not killed.
    timeoutMs?: number
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
  if (running.size === 0) for (const s of ENDING) process.on(s, endRunning)
  running.add(proc.pid)
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
  const timer =
    opts.timeoutMs === undefined ? undefined : setTimeout(() => killGroup(proc.pid), opts.timeoutMs)
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    const code = await proc.exited
    // Ended in time, it is not killed while its output is waited on, nor is what it left.
    clearTimeout(timer)
    running.delete(proc.pid)
    if (running.size === 0) for (const s of ENDING) process.off(s, endRunning)
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
