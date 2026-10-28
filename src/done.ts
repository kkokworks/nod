import { collect, type GcReport, hasRef, landed } from './gc'
import { FINISHED, type Ledger, type Task } from './ledger'
import { Terminals } from './tmux'
import { Todos } from './todos'
import { message, readAtOnce, sessionName } from './worker'

// When a finished task is done with, so gc can collect it without the human naming it. gc keeps
// the session's transcript and resume rebuilds the worktree (restore in worker.ts), so collecting
// a repo task too early costs a rebuild, not the task, and the signals can be generous. A plain
// workspace's files are the task's output, which resume cannot bring back, so only age lets one
// go; a retrospective's output is its report and the answer to it, kept in the ledger, so it goes
// once it ends. Always held back: commits on the branch that no remote has, since collecting hides the only
// copy from ls; a queued task that starts from this one's branch; a person attached to the
// session. An errored task goes only with age, as what went wrong is for the person to see first,
// or, in a repo, once a newer task took its todo over.

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

// `tasks`: the ledger's tasks, as read once for the signals. Several tasks' signals are read at
// once (readAtOnce), as a git service may take a while on each (up to TIMEOUT_MS in prs.ts); what
// they say stays in the tasks' order.
export async function doneTasks(
  ledger: Ledger,
  home: string,
  prs: PrLookup,
  now: Date,
  tasks: Task[] = ledger.list(),
): Promise<{ done: Done[]; unchecked: Unchecked[] }> {
  const terminals = Terminals.of(home)
  const read = await readAtOnce(tasks, async (task): Promise<Done | Unchecked | null> => {
    if (task.collectedAt !== null) return null
    if (!FINISHED.has(task.status)) return null
    // A turn the person types in keeps the status succeeded until it ends.
    if (terminals.attached(sessionName(task.id))) return null
    try {
      const reason = await signal(ledger, tasks, task, prs, now)
      return reason === null ? null : { id: task.id, reason }
    } catch (error) {
      return { id: task.id, error: message(error) }
    }
  })
  return {
    done: read.filter((r): r is Done => r !== null && 'reason' in r),
    unchecked: read.filter((r): r is Unchecked => r !== null && 'error' in r),
  }
}

// Collects the finished tasks a signal says are done with, each only while it is as the signal read
// it: reading the git service takes a while, and a task told to go on meanwhile may have finished
// again with commits no remote has.
export async function sweep(
  ledger: Ledger,
  home: string,
  prs: PrLookup,
  now: Date,
): Promise<{ report: GcReport; done: Done[]; unchecked: Unchecked[] }> {
  const tasks = ledger.list()
  const { done, unchecked } = await doneTasks(ledger, home, prs, now, tasks)
  const seen = tasks.filter((t) => done.some((d) => d.id === t.id))
  const report = await collect(ledger, home, { seen })
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
  const sameTodo = (t: Task): boolean =>
    t.id > task.id && t.todoId !== null && t.todoId === task.todoId
  const tookOver = (t: Task): string => `#${t.id} took over t${task.todoId}`
  // An errored task also goes once a newer one does its todo, added after the error: the person
  // saw what stopped it, fixed it and added the todo again. Its error stays on its row.
  if (task.status === 'error') {
    const { finishedAt } = task
    const again = tasks.find((t) => sameTodo(t) && finishedAt !== null && t.createdAt >= finishedAt)
    return task.repo === null || again === undefined ? null : tookOver(again)
  }
  // Its rule added, turned down (cancelled), or none proposed.
  if (task.retroId !== null) return task.status === 'cancelled' ? 'dropped' : 'retrospective done'
  if (task.repo === null) return null
  if (task.status === 'cancelled') return 'dropped'
  const newer = tasks.find(sameTodo)
  if (newer !== undefined) return tookOver(newer)
  if (branch?.landed && branch.own > 0) return 'its changes are in the default branch'
  // Done once no linked pull request waits on anything: each merged, closed, or approved by the
  // person since the task was added. An approval from an earlier round does not end a new one, and
  // one that asked for changes has another round. Links on the task's todo count too (nod in
  // --link, nod todo set --link); those that are no pull request, a chat message say, do not.
  // ponytail: a todo's links are all its rounds'; one merged in an earlier round ends a later round
  // that has not linked its own yet, which costs a rebuild if it goes on.
  const todoLinks = task.todoId === null ? [] : new Todos(ledger).links(task.todoId)
  const ends: string[] = []
  for (const url of new Set([...ledger.links(task.id), ...todoLinks.map((l) => l.url)])) {
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
// and so keeps no branch of its own (dropBranch in gc.ts): one by its name is someone else's. Only
// as fresh as the repo's last fetch.
function branchState(task: Task): { own: number; landed: boolean; unpushed: boolean } | null {
  const { repo, branch } = task
  if (repo === null || branch === null || task.workspace === null) return null
  const ref = `refs/heads/${branch}`
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args])
  if (!hasRef(repo, ref)) return null
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
  const own = hasRef(repo, main) ? count(`${main}..${ref}`, ...notTheirs) : 0
  const merged = landed(repo, ref)
  return { own, landed: merged, unpushed: notOnRemotes > 0 && !merged }
}
