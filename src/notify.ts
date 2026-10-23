import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionReason, Task } from './ledger'

const NOTIFY_TIMEOUT_MS = 10_000
// How long a run past its time waits, once its group is killed, for its output to close.
const KILLED_GRACE_MS = 500

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
// the first process leaves the rest holding its output open, and the wait goes on (measured). One
// that left the group (setsid) outlives the kill and may still hold it, so a short grace after, the
// output is let go and the run returns without it. The sources and watches run here too (shell).
export async function runGroup(
  cmd: string[],
  opts: {
    cwd?: string
    env: Record<string, string | undefined>
    stdin?: string
    timeoutMs: number
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
  // process holding the pipe ends (measured).
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()]
  const output = Promise.all(
    readers.map(async (reader) => {
      const decoder = new TextDecoder()
      let text = ''
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        text += decoder.decode(r.value, { stream: true })
      }
      return text + decoder.decode()
    }),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const given = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        // The group has ended already.
      }
      timer = setTimeout(() => resolve(null), KILLED_GRACE_MS)
    }, opts.timeoutMs)
  })
  try {
    const [stdout = '', stderr = ''] = (await Promise.race([output, given])) ?? []
    return { code: await proc.exited, stdout, stderr }
  } finally {
    clearTimeout(timer)
    await Promise.all(readers.map((r) => r.cancel()))
  }
}
