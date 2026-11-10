import { FINISHED, type Ledger, type Notice, type Task, type TaskStatus } from './ledger'
import { sessionName } from './place'
import { quote } from './tmux'
import type { Change, SessionPlace } from './todos'

// What nod allowed a task's worker itself (Notice), as the project session hears it: one line in
// the words the person asked for, with nothing to do next.
export const allowedLine = (n: Notice): string => `n${n.taskId} 허락: ${n.note}`

// A task as notices and the decision list name it: `task n5 t3 PROJ-1`.
export function taskLabel(t: Task): string {
  return ['task', `n${t.id}`, owner(t), t.issue ?? ''].filter((x) => x !== '').join(' ')
}

// The command that goes back into a project's session: nod open for the project's latest, else
// claude --resume in the folder it was opened in, where Claude Code keeps its transcript.
export function reopenCommand({ session, project, latest }: SessionPlace): string {
  if (latest) return `nod open p${project.id}`
  return `cd ${quote(session.cwd)} && claude --resume ${session.sessionKey}`
}

// How ls and the UI name a task's state. A running task without a session lost its terminal (a
// restart of the machine or of tmux): the tick asks about the turn it was in, or opens the terminal
// again for a message the turn never took (lostTurns), and `nod resume` reopens it. `live`: the
// sessions there are (Terminals.sessions), read once for all the tasks shown.
export function taskStatus(t: Task, live: ReadonlySet<string>): string {
  return t.status === 'running' && !live.has(sessionName(t.id)) ? 'session ended' : t.status
}

// The one line shown beside a task: what went wrong, what it waits for, where its landing stands,
// what it last reported, or what it was asked to do.
export function taskNote(ledger: Ledger, t: Task): string {
  const waiting = t.status === 'queued' ? ledger.after(t.id) : []
  const waitsFor =
    waiting.length > 0 ? `waits for ${waiting.map((a) => `n${a.id}`).join(', ')}: ${t.brief}` : null
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

// What a task works for: the person's todo (t<n>) or nod's retrospective (r<n>).
export function owner(t: Pick<Task, 'retroId' | 'todoId'>): string {
  if (t.retroId !== null) return `r${t.retroId}`
  return t.todoId === null ? '' : `t${t.todoId}`
}

// A task as `nod ls` lists it, gathered by cli.ts from the ledger, tmux and git; --json prints it
// as it is.
export type LsTask = {
  id: number
  todoId: number | null
  retroId: number | null
  status: TaskStatus
  // Running, but its terminal is gone (taskStatus).
  sessionEnded: boolean
  turns: number
  createdAt: string
  // When its last turn started; null before the first.
  startedAt: string | null
  finishedAt: string | null
  // When gc collected it: the person has dealt with what it produced.
  collectedAt: string | null
  note: string
  issue: string | null
  links: string[]
  // The remote branches holding its branch while it has no link (unlinkedPushes in cli.ts).
  pushed: string[]
}

// What needs the person first, then work going on, work waiting its turn, results not yet sent
// anywhere (no link, no push), and the rest of what ended. What gc collected (--all) the person has
// dealt with, whatever its status; bringing it back (restore in worker.ts) uncollects it.
const GROUPS = ['결정 대기 · 오류', '진행 중', '차례 기다림', '끝남 · 내보내기 전', '끝남']

function groupOf(t: LsTask): number {
  if (t.collectedAt !== null) return 4
  const s = shownStatus(t)
  if (s === 'needs_decision' || s === 'error' || s === 'session ended') return 0
  if (s === 'running') return 1
  if (s === 'queued') return 2
  return s === 'succeeded' && t.links.length === 0 && t.pushed.length === 0 ? 3 : 4
}

const shownStatus = (t: LsTask): string => (t.sessionEnded ? 'session ended' : t.status)

// Since its end once it has ended, else since its last turn started, else since it was added. A
// task that runs again keeps its old finished_at (setRunning), so only an ended status counts it.
const sinceOf = (t: LsTask): string =>
  (FINISHED.has(t.status) ? t.finishedAt : null) ?? t.startedAt ?? t.createdAt

// ls's groups in order, the latest first in each, with the empty ones left out.
export function lsGroups(tasks: LsTask[]): { name: string; tasks: LsTask[] }[] {
  const latest = tasks.toSorted((a, b) => sinceOf(b).localeCompare(sinceOf(a)) || b.id - a.id)
  return GROUPS.map((name, i) => ({ name, tasks: latest.filter((t) => groupOf(t) === i) })).filter(
    (g) => g.tasks.length > 0,
  )
}

// What `nod ls` prints: JSON lines with --json; a plain line a task with --plain or when the output
// is no terminal (a pipe); else the table, in color unless NO_COLOR is set (no-color.org).
export function lsMode(
  flags: { json?: boolean; plain?: boolean },
  tty: boolean,
  noColor: string | undefined,
): 'json' | 'plain' | 'table' | 'color' {
  if (flags.json) return 'json'
  if (flags.plain || !tty) return 'plain'
  return noColor ? 'table' : 'color'
}

const RED = '31'
const GREEN = '32'
const YELLOW = '33'
const BLUE = '34'
const DIM = '2'

// The status ls names (taskStatus), as a sign and a word, with its color.
const STATUS: Record<string, [string, string]> = {
  needs_decision: ['? 결정 대기', YELLOW],
  'session ended': ['! 끊김', YELLOW],
  error: ['✕ 오류', RED],
  running: ['▶ 진행', BLUE],
  queued: ['○ 기다림', DIM],
  succeeded: ['✓ 성공', GREEN],
  cancelled: ['- 취소', DIM],
}

const HEADS = {
  id: '작업',
  owner: '할 일',
  status: '상태',
  turns: '차례',
  since: '지남',
  note: '요약',
  results: '이슈 · 결과',
}
type Column = keyof typeof HEADS

// When the terminal is too narrow for the summary to get NOTE_MIN columns and the issue and results
// theirs (up to RESULTS_MAX), the turns column goes; then the results give up room down to
// RESULTS_MIN; then, should the summary still get fewer than NOTE_MIN, the todo's column goes.
// Measured with running and succeeded tasks: all seven columns from 82, the todo's from 70; with a
// task waiting on a decision (an 11-column status), from 87 and 75.
const NOTE_MIN = 20
const RESULTS_MAX = 20
const RESULTS_MIN = 11

// `nod ls` in a terminal: a box `width` columns wide, a row per task under its group, the summary
// taking what the other columns leave. Only the status is colored; the time and results are dim.
export function lsTable(tasks: LsTask[], width: number, color: boolean, now: Date): string {
  if (tasks.length === 0) return '작업 없음'
  const groups = lsGroups(tasks).map((g) => ({
    label: `${g.name} (${g.tasks.length})`,
    tasks: g.tasks.map((t) => ({ cells: cells(t, now), color: STATUS[shownStatus(t)]?.[1] })),
  }))
  const all = groups.flatMap((g) => g.tasks)
  const widths = Object.fromEntries(
    Object.entries(HEADS).map(([k, head]) => [
      k,
      Math.max(Bun.stringWidth(head), ...all.map((r) => Bun.stringWidth(r.cells[k as Column]))),
    ]),
  ) as Record<Column, number>
  const wanted = Math.min(widths.results, RESULTS_MAX)
  let shown = Object.keys(HEADS) as Column[]
  const layout = (): void => {
    const fixed = shown
      .filter((k) => k !== 'note' && k !== 'results')
      .reduce((n, k) => n + widths[k], 0)
    // Each column has a space either side and a bar after it, and the box one more bar.
    const room = width - fixed - 3 * shown.length - 1
    widths.results = Math.min(wanted, Math.max(RESULTS_MIN, room - NOTE_MIN))
    widths.note = Math.max(1, room - widths.results)
  }
  layout()
  if (widths.results < wanted || widths.note < NOTE_MIN) {
    shown = shown.filter((k) => k !== 'turns')
    layout()
  }
  if (widths.note < NOTE_MIN) {
    shown = shown.filter((k) => k !== 'owner')
    layout()
  }

  const paint = (code: string | undefined, s: string): string =>
    color && code !== undefined ? `\x1b[${code}m${s}\x1b[0m` : s
  const line = (left: string, mid: string, right: string): string =>
    left + shown.map((k) => '─'.repeat(widths[k] + 2)).join(mid) + right
  const row = (r: Record<Column, string>, status?: string): string =>
    `│ ${shown
      .map((k) => {
        const cell = fit(r[k], widths[k])
        if (k === 'status') return paint(status, cell)
        return k === 'since' || k === 'results' ? paint(DIM, cell) : cell
      })
      .join(' │ ')} │`
  const inner = shown.reduce((n, k) => n + widths[k] + 3, -3)
  const out = [line('╭', '┬', '╮'), `│ ${shown.map((k) => fit(HEADS[k], widths[k])).join(' │ ')} │`]
  for (const g of groups) {
    out.push(line('├', '┴', '┤'), `│ ${fit(g.label, inner)} │`, line('├', '┬', '┤'))
    for (const t of g.tasks) out.push(row(t.cells, t.color))
  }
  out.push(line('╰', '┴', '╯'))
  return out.join('\n')
}

function cells(t: LsTask, now: Date): Record<Column, string> {
  const status = shownStatus(t)
  return {
    id: `n${t.id}`,
    owner: owner(t),
    status: STATUS[status]?.[0] ?? status,
    turns: String(t.turns),
    since: ago(sinceOf(t), now),
    note: firstLine(t.note),
    results: clean([t.issue, ...t.links.map(shortLink), ...t.pushed].filter((x) => x).join(' ')),
  }
}

// `nod ls` for scripts: a task a line, tab-separated, with whole values: the status as ls names
// it, the time it counts from, the note's first line, the issue, links and pushes as they are.
export function lsLine(t: LsTask): string {
  const results = [t.issue, ...t.links, ...t.pushed].filter((x) => x).join(' ')
  return [t.id, owner(t), shownStatus(t), t.turns, sinceOf(t), firstLine(t.note), clean(results)]
    .map(String)
    .join('\t')
}

// How long ago, in whole minutes, hours or days.
export function ago(from: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000))
  if (mins < 60) return `${mins}분`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}시간`
  return `${Math.floor(mins / (24 * 60))}일`
}

// A pull request's address as <repo>#<number> (GitHub, Gitea and Forgejo, GitLab); any other
// address without its scheme.
function shortLink(url: string): string {
  const pr = url.match(/\/([^/]+)\/(?:-\/)?(?:pull|pulls|merge_requests)\/(\d+)/)
  return pr === null ? url.replace(/^https?:\/\//, '') : `${pr[1]}#${pr[2]}`
}

// A worker's text may carry tabs and terminal escapes, which would break the columns, and format
// characters (bidi controls among them) and line separators, which reorder a row or which
// Bun.stringWidth counts otherwise than a terminal draws them. Emoji keep the joiner and tags
// (Emoji_Component) they are built from. A lookahead with the u flag, not a v-flag set difference:
// Bun 1.3's nested v class matched half of a character beyond U+FFFF and left a lone surrogate.
export const clean = (s: string): string =>
  s.replace(/(?!\p{Emoji_Component})[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/gu, ' ')
export const firstLine = (s: string): string => clean(s.trim().split('\n')[0] ?? '')

// `s` exactly `w` columns wide on screen: padded, or cut with `…`. Hangul and emoji take two.
function fit(s: string, w: number): string {
  let out = s
  if (Bun.stringWidth(s) > w) {
    out = ''
    for (const { segment } of new Intl.Segmenter().segment(s)) {
      if (Bun.stringWidth(out + segment) > w - 1) break
      out += segment
    }
    out += '…'
  }
  return out + ' '.repeat(Math.max(0, w - Bun.stringWidth(out)))
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
  if (field === 'projectId') return `p${String(v)}`
  // backTo is gone from todos (v33), but the history keeps the tasks it named.
  return field === 'backTo' ? `n${String(v)}` : oneLine(clean(String(v)), 40)
}

// A cut through a character beyond U+FFFF would leave half of it, which prints as U+FFFD.
export function oneLine(s: string, max: number): string {
  return s
    .replaceAll('\n', ' ')
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, '')
}

// `s` as one clean line of at most `max`, with `…` where it is cut, so no one reads it as whole.
export function cutLine(s: string, max: number): string {
  const line = clean(s).trim()
  return line.length > max ? `${oneLine(line, max)}…` : line
}

export function indent(s: string, n = 2): string {
  return s
    .split('\n')
    .map((line) => ' '.repeat(n) + line)
    .join('\n')
}
