import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionReason, Task } from './ledger'

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
  | { event: 'trigger_failed'; trigger: { id: number; cron: string }; error: string }

export const taskRef = (t: Task): TaskRef => ({ id: t.id, brief: t.brief, issue: t.issue })

// Runs `<home>/notify`, if the human made one, with the event as JSON on stdin: how a person hears
// about a decision while away from the Claude session. A notification that fails is reported on
// stderr and changes nothing else, since the ledger already holds the event.
export async function notify(home: string, event: NotifyEvent): Promise<void> {
  const script = join(home, 'notify')
  if (!existsSync(script)) return
  const proc = Bun.spawn([script], {
    stdin: new Blob([JSON.stringify(event)]),
    stdout: 'ignore',
    stderr: 'pipe',
    env: process.env,
    timeout: NOTIFY_TIMEOUT_MS,
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    console.error(`nod: ${script} exited ${code} on ${event.event}: ${stderr.trim()}`)
  }
}
