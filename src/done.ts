import { collect, type GcReport, landed } from './gc'
import type { Ledger, Task } from './ledger'
import { Terminals } from './tmux'
import { message, sessionName } from './worker'

// When a finished task is done with, so gc can collect it without the human naming it. gc keeps
// the session's transcript and resume rebuilds the worktree (restore in worker.ts), so collecting
// a repo task too early costs a rebuild, not the task, and the signals can be generous. A plain
// workspace's files are the task's output, which resume cannot bring back, so only age lets one
// go; a retrospective's output is its report and the answer to it, kept in the ledger, so it goes
// once it ends. Always held back: commits on the branch that no remote has, since collecting hides the only
// copy from ls; a queued task that starts from this one's branch; a person attached to the
// session. An errored task waits for the human too.

const STALE_DAYS = 7
const DAY = 86_400_000

// A linked pull request: whether it is still open, and when the person approved it, if their last
// review that approved or asked for changes approved. A link that is not a pull request reads as
// null.
export type PullRequest = {
  state: 'open' | 'merged' | 'closed'
  approvedAt: string | null
}
export type PrLookup = (url: string) => Promise<PullRequest | null>

export type Done = { id: number; reason: string }
// A task whose signals could not be read, a git service call that failed, say: it waits.
export type Unchecked = { id: number; error: string }

export async function doneTasks(
  ledger: Ledger,
  home: string,
  prs: PrLookup,
  now: Date,
): Promise<{ done: Done[]; unchecked: Unchecked[] }> {
  const tasks = ledger.list()
  const terminals = Terminals.of(home)
  const done: Done[] = []
  const unchecked: Unchecked[] = []
  for (const task of tasks) {
    if (task.collectedAt !== null) continue
    if (task.status !== 'succeeded' && task.status !== 'cancelled') continue
    // A turn the person types in keeps the status succeeded until it ends.
    if (terminals.attached(sessionName(task.id))) continue
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
  const { done, unchecked } = await doneTasks(ledger, home, prs, now)
  const report = await collect(ledger, home, { ids: done.map((d) => d.id) })
  return { report, done, unchecked }
}

// Cheap signals first: the ledger, then git, then the git service, so a git service that cannot be
// read holds back only what it alone could end.
async function signal(
  ledger: Ledger,
  tasks: Task[],
  task: Task,
  prs: PrLookup,
  now: Date,
): Promise<string | null> {
  const branch = branchState(task)
  if (branch?.unpushed) return null
  if (ledger.waiting(task.id).length > 0) return null
  if (task.finishedAt !== null && Date.parse(task.finishedAt) <= now.getTime() - STALE_DAYS * DAY) {
    return `finished ${STALE_DAYS}+ days ago`
  }
  // Its rule added, turned down (cancelled), or none proposed.
  if (task.retroId !== null) return task.status === 'cancelled' ? 'dropped' : 'retrospective done'
  if (task.repo === null) return null
  if (task.status === 'cancelled') return 'dropped'
  const newer = tasks.find((t) => t.id > task.id && t.todoId !== null && t.todoId === task.todoId)
  if (newer !== undefined) return `#${newer.id} took over t${task.todoId}`
  if (branch?.landed && branch.own > 0) return 'its changes are in the default branch'
  // Done once no linked pull request waits on anything: each merged, closed, or approved by the
  // person since the task was added. An approval from an earlier round does not end a new one, and
  // one that asked for changes has another round.
  const ends: string[] = []
  for (const url of ledger.links(task.id)) {
    const pr = await prs(url)
    if (pr === null) continue
    if (pr.state !== 'open') ends.push(`${pr.state}: ${url}`)
    else if (pr.approvedAt !== null && Date.parse(pr.approvedAt) >= Date.parse(task.createdAt)) {
      ends.push(`approved: ${url}`)
    } else return null
  }
  return ends.length > 0 ? ends.join(', ') : null
}

// A repo task's branch: how many commits the task made that the remote's default branch lacks,
// whether the default branch has its changes, and whether some of its commits are on no remote and
// not merged either. Null without a repo, once the branch is gone, or for a task that never started
// and so made no branch: one by its name is someone else's. Only as fresh as the repo's last fetch.
function branchState(task: Task): { own: number; landed: boolean; unpushed: boolean } | null {
  const { repo, branch } = task
  if (repo === null || branch === null || task.workspace === null) return null
  const ref = `refs/heads/${branch}`
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args])
  if (git('rev-parse', '--verify', '-q', ref).exitCode !== 0) return null
  const count = (...args: string[]): number => {
    const out = git('rev-list', '--count', ...args)
    if (out.exitCode !== 0) throw new Error(`git rev-list in ${repo}: ${out.stderr.toString()}`)
    return Number(out.stdout.toString().trim())
  }
  // The commits the branch was made on are not the task's: the main clone may sit on a branch with
  // commits no remote has. The oldest entry of the branch's reflog says where it was created.
  // ponytail: reflog entries expire (90 days by default); without the creation entry every commit
  // counts, as if the task made them.
  const oldest = git('reflog', 'show', '--format=%H %gs', ref).stdout.toString().trim().split('\n')
  const [start, ...subject] = (oldest.at(-1) ?? '').split(' ')
  const notTheirs = subject.join(' ').startsWith('branch: Created from') ? [`^${start}`] : []
  const notOnRemotes = count(ref, ...notTheirs, '--not', '--remotes')
  const main = 'refs/remotes/origin/HEAD'
  const own =
    git('rev-parse', '--verify', '-q', main).exitCode === 0
      ? count(`${main}..${ref}`, ...notTheirs)
      : 0
  const merged = landed(repo, ref)
  return { own, landed: merged, unpushed: notOnRemotes > 0 && !merged }
}
