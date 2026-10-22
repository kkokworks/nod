import { collect, type GcReport, landed } from './gc'
import type { Ledger, Task } from './ledger'
import { message } from './worker'

// When a finished task is done with, so gc can collect it without the human naming it. gc keeps
// the session's transcript and resume rebuilds the worktree (restore in worker.ts), so collecting
// too early costs a rebuild, not the task, and the signals can be generous. One thing always holds
// a task back: commits on its branch that no remote has, since collecting hides the only copy from
// ls. An errored task waits for the human too.

const STALE_DAYS = 7
const DAY = 86_400_000

// A linked pull request: whether it is still open, and the person's last review on it that
// approved or asked for changes. A link that is not a pull request reads as null.
export type PullRequest = {
  state: 'open' | 'merged' | 'closed'
  myVerdict: 'approved' | 'changes' | null
}
export type PrLookup = (url: string) => Promise<PullRequest | null>

export type Done = { id: number; reason: string }
// A task whose signals could not be read, a git service call that failed, say: it waits.
export type Unchecked = { id: number; error: string }

export async function doneTasks(
  ledger: Ledger,
  prs: PrLookup,
  now: Date,
): Promise<{ done: Done[]; unchecked: Unchecked[] }> {
  const tasks = ledger.list()
  const done: Done[] = []
  const unchecked: Unchecked[] = []
  for (const task of tasks) {
    if (task.collectedAt !== null) continue
    if (task.status !== 'succeeded' && task.status !== 'cancelled') continue
    try {
      const reason = await signal(ledger, tasks, task, prs, now)
      if (reason !== null) done.push({ id: task.id, reason })
    } catch (error) {
      unchecked.push({ id: task.id, error: message(error) })
    }
  }
  return { done, unchecked }
}

// Collects the finished tasks a signal says are done with.
export async function sweep(
  ledger: Ledger,
  home: string,
  prs: PrLookup,
  now: Date,
): Promise<{ report: GcReport; done: Done[]; unchecked: Unchecked[] }> {
  const { done, unchecked } = await doneTasks(ledger, prs, now)
  const report = await collect(ledger, home, { ids: done.map((d) => d.id) })
  return { report, done, unchecked }
}

// Cheap signals first: the ledger, then git, then the git service.
async function signal(
  ledger: Ledger,
  tasks: Task[],
  task: Task,
  prs: PrLookup,
  now: Date,
): Promise<string | null> {
  const branch = branchState(task)
  if (branch?.unpushed) return null
  if (task.status === 'cancelled') return 'dropped'
  const newer = tasks.find((t) => t.id > task.id && t.todoId !== null && t.todoId === task.todoId)
  if (newer !== undefined) return `#${newer.id} took over t${task.todoId}`
  if (branch !== null && branch.own > 0 && landed(branch.repo, branch.ref)) {
    return 'its changes are in the default branch'
  }
  // A review task is done once the person approves; one that asked for changes has another round.
  for (const url of ledger.links(task.id)) {
    const pr = await prs(url)
    if (pr === null) continue
    if (pr.state !== 'open') return `${pr.state}: ${url}`
    if (pr.myVerdict === 'approved') return `approved: ${url}`
  }
  if (task.finishedAt !== null && Date.parse(task.finishedAt) <= now.getTime() - STALE_DAYS * DAY) {
    return `finished ${STALE_DAYS}+ days ago`
  }
  return null
}

// A repo task's branch: how many commits it has that the remote's default branch lacks, and
// whether some of them are on no remote and not merged either. Null without a repo, or once the
// branch is gone. Only as fresh as the repo's last fetch.
function branchState(
  task: Task,
): { repo: string; ref: string; own: number; unpushed: boolean } | null {
  const { repo, branch } = task
  if (repo === null || branch === null) return null
  const ref = `refs/heads/${branch}`
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args])
  if (git('rev-parse', '--verify', '-q', ref).exitCode !== 0) return null
  const count = (...args: string[]): number => {
    const out = git('rev-list', '--count', ...args)
    if (out.exitCode !== 0) throw new Error(`git rev-list in ${repo}: ${out.stderr.toString()}`)
    return Number(out.stdout.toString().trim())
  }
  const notOnRemotes = count(ref, '--not', '--remotes')
  const main = 'refs/remotes/origin/HEAD'
  const own = git('rev-parse', '--verify', '-q', main).exitCode === 0 ? count(`${main}..${ref}`) : 0
  return { repo, ref, own, unpushed: notOnRemotes > 0 && !landed(repo, ref) }
}
