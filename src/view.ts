import type { Ledger, Task } from './ledger'
import type { Terminals } from './tmux'
import type { Change } from './todos'
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

// One change to a todo or a project, field by field: `status inbox → next, project — → p1`.
export function changeText(c: Change): string {
  return Object.entries(c.change)
    .map(
      ([field, [from, to]]) =>
        `${FIELD[field] ?? field} ${shown(field, from)} → ${shown(field, to)}`,
    )
    .join(', ')
}

const FIELD: Record<string, string> = {
  projectId: 'project',
  waitingOn: 'waiting on',
  sourceKey: 'key',
}
const shown = (field: string, v: unknown): string => {
  if (v === null) return '—'
  return field === 'projectId' ? `p${String(v)}` : oneLine(String(v), 40)
}

export function oneLine(s: string, max: number): string {
  return s.replaceAll('\n', ' ').slice(0, max)
}

export function indent(s: string, n = 2): string {
  return s
    .split('\n')
    .map((line) => ' '.repeat(n) + line)
    .join('\n')
}
