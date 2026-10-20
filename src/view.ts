import type { Ledger, Task } from './ledger'
import type { Terminals } from './tmux'
import { sessionName } from './worker'

// How ls and the UI name a task's state. A running task without a session was cut off (exit,
// restart); `nod resume` reopens it.
export function taskStatus(t: Task, terminals: Terminals): string {
  return t.status === 'running' && !terminals.alive(sessionName(t.id)) ? 'session ended' : t.status
}

// The one line shown beside a task: what went wrong, what it waits for, what it last reported, or
// what it was asked to do.
export function taskNote(ledger: Ledger, t: Task): string {
  const waiting = t.status === 'queued' ? ledger.after(t.id) : []
  const waitsFor =
    waiting.length > 0 ? `waits for ${waiting.map((a) => `#${a.id}`).join(', ')}: ${t.brief}` : null
  return t.error ?? waitsFor ?? ledger.lastAttempt(t.id)?.summary ?? t.brief
}
