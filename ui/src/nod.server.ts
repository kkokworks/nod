// What the pages show, read from the ledger, and the messages they send to workers. Server only:
// the routes reach it through server functions, so the ledger and tmux never ship to the browser.
import {
  type Attempt,
  type Decision,
  Ledger,
  nodHome,
  type Stats,
  type Task,
  type Trigger,
} from '../../src/ledger'
import { Terminals } from '../../src/tmux'
import { taskNote, taskStatus } from '../../src/view'
import { answer, sessionName, tell } from '../../src/worker'

const home = nodHome()
// One connection for the server's life; WAL lets nod write while this reads.
const ledger = new Ledger(home)
const terminals = Terminals.of(home)

export type TaskRow = { id: number; status: string; turns: number; note: string; links: string[] }

export type OpenDecision = Decision & { brief: string; issue: string | null }

export type Overview = {
  decisions: OpenDecision[]
  // Like `nod ls`: tasks without an issue first, then each issue in the order it first appeared.
  groups: { issue: string | null; tasks: TaskRow[] }[]
  // What gc collected, which `nod ls` lists only with --all.
  collected: TaskRow[]
  triggers: Trigger[]
  stats: Stats
}

export type Detail = {
  task: Task
  status: string
  links: string[]
  after: { id: number; status: string }[]
  // The prompt is left out, as in `nod show`.
  attempts: Omit<Attempt, 'prompt'>[]
  decisions: Decision[]
  report: string | null
  // The worker's terminal right now, while its session is alive.
  screen: string | null
}

export function overview(): Overview {
  const tasks = ledger.list()
  const active = tasks.filter((t) => t.collectedAt === null)
  return {
    decisions: ledger.openDecisions().map((d) => {
      const t = ledger.get(d.taskId)
      return { ...d, brief: t.brief, issue: t.issue }
    }),
    groups: [...Map.groupBy(active, (t) => t.issue)]
      .sort(([a], [b]) => Number(a !== null) - Number(b !== null))
      .map(([issue, group]) => ({ issue, tasks: group.map(row) })),
    collected: tasks.filter((t) => t.collectedAt !== null).map(row),
    triggers: ledger.triggers(),
    stats: ledger.stats(),
  }
}

export function detail(id: number): Detail {
  const task = ledger.get(id)
  const attempts = ledger.attempts(id)
  const name = sessionName(id)
  return {
    task,
    status: taskStatus(task, terminals),
    links: ledger.links(id),
    after: ledger.after(id).map((a) => ({ id: a.id, status: a.status })),
    attempts: attempts.map(({ prompt: _, ...a }) => a),
    decisions: ledger.decisions(id),
    report: attempts.filter((a) => a.report).at(-1)?.report ?? null,
    screen: terminals.alive(name) ? terminals.screen(name).trimEnd() : null,
  }
}

export type Message = { taskId: number; decisionId: number | null; text: string }

// What `nod tell` and `nod <decision> <answer>` do. While a decision is open the worker waits on
// it, so a message answers it; a tell then could land on a permission dialog, where Enter means
// yes.
export async function send(m: Message): Promise<void> {
  // A message reaches a worker in auto mode, so another site open in the same browser must not
  // send one. TanStack Start already refuses that: with no src/start.ts it puts its CSRF middleware
  // (Sec-Fetch-Site, else Origin, must be this page) in front of every server function. A
  // src/start.ts must keep createCsrfMiddleware in its requestMiddleware.
  const task = ledger.get(m.taskId)
  if (task.collectedAt !== null)
    throw new Error(`task #${task.id} was collected; its session is gone`)
  const open = ledger.decisions(task.id).find((d) => d.answer === null)
  if (m.decisionId === null) {
    if (open !== undefined) throw new Error(`answer decision #${open.id} first`)
    tell(ledger, home, task.id, m.text)
    return
  }
  if (open?.id !== m.decisionId)
    throw new Error(`decision #${m.decisionId} is not open on #${task.id}`)
  await answer(ledger, home, m.decisionId, m.text)
}

function row(t: Task): TaskRow {
  return {
    id: t.id,
    status: taskStatus(t, terminals),
    turns: ledger.attempts(t.id).length,
    note: taskNote(ledger, t),
    links: ledger.links(t.id),
  }
}
