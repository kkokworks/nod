import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tellSessions } from './inbox'
import type { DecisionReason, Ledger, Task } from './ledger'
import { message, runGroup } from './proc'

const NOTIFY_TIMEOUT_MS = 10_000

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

// For a .catch on work nobody watches: the person hears the task's error (notify).
export const notifyError =
  (ledger: Ledger, home: string, taskId: number) =>
  (error: unknown): Promise<void> =>
    notify(home, { event: 'error', task: taskRef(ledger.get(taskId)), error: message(error) })
