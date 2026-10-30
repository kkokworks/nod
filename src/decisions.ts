import type { Decision, DecisionReason, Ledger, Task } from './ledger'
import { notify, taskRef } from './notify'

// The decisions a task asks the person, in the ledger: opening one (decide), closing those nothing
// waits on any more (closeDecisions) and the task going on past them (goesOn), telling a to-do list
// that mirrors them (announce), and whether the task ended, so a decision left open on it only
// closes (ended, finished). What an answer does in the worker's terminal is worker.ts's (answer).
// This module takes no terminal, and imports none of worker.ts, hooks.ts or land.ts.

// What a worker asks as its turn ends, which an answer goes on from in its conversation. Once it
// goes on without one, nothing waits on them. Permission, trust and rule decisions are about other
// things, and close where those end; every decision closes once the task does.
export const ASKED: readonly DecisionReason[] = [
  'question',
  'failed',
  'check_failed',
  'interrupted',
]
export const WENT_ON = '(it went on without an answer)'
// How much of what a worker said or would run a decision's question takes, at most.
export const QUESTION_LIMIT = 2000

// A decision on landing the task (land.ts), on its last turn: `land` for what only the person can
// clear, `check_failed` for a gate that failed, whose answer goes to the worker as landing work.
export async function askToLand(
  ledger: Ledger,
  home: string,
  taskId: number,
  reason: 'land' | 'check_failed',
  question: string,
): Promise<void> {
  const last = ledger.lastAttempt(taskId)
  if (last === null) throw new Error(`task n${taskId} has not started`)
  await decide(ledger, home, taskId, last.id, reason, question)
}

// Every decision opens here, so the human hears about each one. Returns whether it opened; a task
// that ended takes none.
export async function decide(
  ledger: Ledger,
  home: string,
  taskId: number,
  attemptId: number,
  reason: DecisionReason,
  question: string,
  // What goes into the ledger with the decision, in its transaction.
  along: () => void = () => {},
): Promise<boolean> {
  // What the worker asks as a turn ends replaces what it asked as an earlier one ended, and a
  // retrospective's proposal the one before it. A task that ended takes none (ended).
  const rule = reason === 'rule'
  const why = rule ? '(a newer proposal replaced it)' : WENT_ON
  const same = (d: Decision): boolean => (rule ? d.reason === 'rule' : ASKED.includes(d.reason))
  const made = ledger.db
    .transaction(() => {
      if (ended(ledger, taskId)) return null
      along()
      const replaced =
        rule || ASKED.includes(reason) ? closeDecisions(ledger, taskId, same, why) : []
      return { id: ledger.ask(taskId, attemptId, reason, question), replaced }
    })
    .immediate()
  if (made === null) return false
  const { id, replaced } = made
  const task = ledger.get(taskId)
  await announce(home, task, replaced, why)
  await notify(home, { event: 'decision', task: taskRef(task), decision: { id, reason, question } })
  return true
}

// The worker went on past decisions that held its task (`closed`), so the task runs again, unless
// it ended (ended).
export function goesOn(ledger: Ledger, taskId: number, closed: Decision[]): void {
  if (closed.length === 0) return
  ledger.db
    .transaction(() => {
      const task = ledger.get(taskId)
      if (task.status !== 'needs_decision' || task.workspace === null) return
      if (!ended(ledger, taskId)) ledger.setRunning(taskId, task.workspace)
    })
    .immediate()
}

// Closes the task's open decisions that `which` picks with `why`, so nobody waits on one nothing
// acts on any more. In one transaction, so one a person answers at the same time is left to them.
// Leaves the task's status to the caller. Returns them, to announce once the change is in.
export function closeDecisions(
  ledger: Ledger,
  taskId: number,
  which: (d: Decision) => boolean,
  why: string,
): Decision[] {
  return ledger.db
    .transaction(() => {
      const open = ledger.decisions(taskId).filter((d) => d.answer === null && which(d))
      for (const d of open) ledger.dismiss(d.id, why)
      return open
    })
    .immediate()
}

// The turn's open permission decision: a dialog of that turn that may be on the screen.
export const asking = (ledger: Ledger, taskId: number, attemptId: number): Decision | undefined =>
  ledger
    .decisions(taskId)
    .find((d) => d.answer === null && d.reason === 'permission' && d.attemptId === attemptId)

// A task that ended for good: dropped, or a retrospective that has its outcome. A turn that ends
// after (one its Stop hook still checked as it was dropped, or one typed into its terminal) is only
// recorded, and changes nothing else.
export function ended(ledger: Ledger, taskId: number): boolean {
  const task = ledger.get(taskId)
  if (task.status === 'cancelled') return true
  return task.retroId !== null && ledger.retro(task.retroId).outcome !== null
}

// A task that ended, or succeeded: a decision left open on it only closes (answer, drop).
export const finished = (ledger: Ledger, taskId: number): boolean =>
  ledger.get(taskId).status === 'succeeded' || ended(ledger, taskId)

// Tells a to-do list that mirrors open decisions that these closed.
export async function announce(
  home: string,
  task: Task,
  closed: Decision[],
  why: string,
): Promise<void> {
  for (const d of closed) {
    await notify(home, {
      event: 'answered',
      task: taskRef(task),
      decision: { id: d.id, reason: d.reason, answer: why },
    })
  }
}

// An ended retrospective keeps what became of it; going on, or another answer, would write over it.
export function refuseEnded(ledger: Ledger, task: Task): void {
  if (task.retroId === null) return
  const { outcome } = ledger.retro(task.retroId)
  if (outcome !== null) {
    throw new Error(`task n${task.id} is retrospective r${task.retroId}, which ended (${outcome})`)
  }
}
