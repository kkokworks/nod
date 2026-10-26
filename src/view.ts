import type { Decision, Ledger, Task } from './ledger'
import { quote, type Terminals } from './tmux'
import type { Change, SessionPlace } from './todos'
import { sessionName } from './worker'

// Also covers a decision that opens just as the last worker stops.
const WATCH_GRACE_SECS = 5

// `nod watch`: hands `print` each decision that opens on a task `counts`, once, until none of those
// tasks has had a worker running for WATCH_GRACE_SECS looks. `wait` comes between looks.
export async function watch(
  ledger: Ledger,
  counts: (t: Task) => boolean,
  print: (d: Decision) => void,
  wait: () => Promise<void> = () => Bun.sleep(1000),
): Promise<void> {
  const seen = new Set(ledger.openDecisions().map((d) => d.id))
  let idleSecs = 0
  while (idleSecs < WATCH_GRACE_SECS) {
    await wait()
    for (const d of ledger.openDecisions()) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      if (counts(ledger.get(d.taskId))) print(d)
    }
    const running = ledger.list().some((t) => t.status === 'running' && counts(t))
    idleSecs = running ? 0 : idleSecs + 1
  }
}

// The command that goes back into a project's session: nod open for the project's latest, else
// claude --resume in the folder it was opened in, where Claude Code keeps its transcript.
export function reopenCommand({ session, project, latest }: SessionPlace): string {
  if (latest) return `nod open p${project.id}`
  return `cd ${quote(session.cwd)} && claude --resume ${session.sessionId}`
}

// How ls and the UI name a task's state. A running task without a session lost its terminal (a
// restart of the machine or of tmux): the tick asks about the turn it was in (lostTurns), and
// `nod resume` reopens it.
export function taskStatus(t: Task, terminals: Terminals): string {
  return t.status === 'running' && !terminals.alive(sessionName(t.id)) ? 'session ended' : t.status
}

// The one line shown beside a task: what went wrong, what it waits for, where its landing stands,
// what it last reported, or what it was asked to do.
export function taskNote(ledger: Ledger, t: Task): string {
  const waiting = t.status === 'queued' ? ledger.after(t.id) : []
  const waitsFor =
    waiting.length > 0 ? `waits for ${waiting.map((a) => `#${a.id}`).join(', ')}: ${t.brief}` : null
  return (
    t.error ?? waitsFor ?? landingNote(ledger, t) ?? ledger.lastAttempt(t.id)?.summary ?? t.brief
  )
}

// Where landing the task stands (land.ts), until it is merged.
function landingNote(ledger: Ledger, t: Task): string | null {
  const l = ledger.landing(t.id)
  if (l === null || l.mergedAt !== null) return null
  if (l.stopped !== null) return `landing stopped: ${l.stopped}`
  return l.note === null ? null : `landing: ${l.note}`
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
