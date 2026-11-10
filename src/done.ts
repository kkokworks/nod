import { collect, type GcReport, hasRef, landed } from './gc'
import { FINISHED, type Ledger, type Task } from './ledger'
import { sessionName } from './place'
import { message, readAtOnce } from './proc'
import { isPullRequest, pushUrls, sameRepo } from './prs'
import type { Terminals } from './tmux'
import { type Left, Todos } from './todos'

// When a finished task is done with, so gc can collect it without the human naming it. gc keeps
// the session's transcript and resume rebuilds the worktree (restore in worker.ts), so collecting
// a repo task too early costs a rebuild, not the task, and the signals can be generous. A plain
// workspace's files are the task's output, which resume cannot bring back, so only age lets one
// go; a retrospective's output is its report and the answer to it, kept in the ledger, so it goes
// once it ends. Held back: commits on the branch that no remote has, since collecting hides the
// only copy from ls, unless a succeeded task's own pull request merged after the last of them and
// no other linked one waits; a queued task that starts from this one's branch; a person attached
// to the session. An errored task goes only with age, as what went wrong is for the person to see
// first, or, in a repo, once a newer task took its todo over.

const STALE_DAYS = 7
const DAY = 86_400_000

// A linked pull request: whether it is still open, its head branch's name, the repo that branch is
// in (an address remoteOf in prs.ts reads, null when the service does not say), when it merged,
// and when the person approved it, if their last review that approved or asked for changes
// approved. A link that is not a pull request reads as null.
export type PullRequest = {
  state: 'open' | 'merged' | 'closed'
  head: string
  headRepo: string | null
  mergedAt: string | null
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
  terminals: Terminals,
  prs: PrLookup,
  now: Date,
  tasks: Task[] = ledger.list(),
): Promise<{ done: Done[]; unchecked: Unchecked[] }> {
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
  terminals: Terminals,
  prs: PrLookup,
  now: Date,
): Promise<{ report: GcReport; done: Done[]; unchecked: Unchecked[] }> {
  const tasks = ledger.list()
  const { done, unchecked } = await doneTasks(ledger, terminals, prs, now, tasks)
  const seen = tasks.filter((t) => done.some((d) => d.id === t.id))
  const report = await collect(ledger, home, terminals, { seen })
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
  if (ledger.waiting(task.id).length > 0) return null
  if (branch?.unpushed) {
    if (task.status !== 'succeeded') return null
    // The branch's own pull request (ownPr) merged after its last commit: the work went up from
    // elsewhere, rebased on another branch, say, so these commits are not its only copy. A commit
    // made or rewritten since is newer than the merge, and held back. Any other link still waiting
    // holds it back too, as it does a pushed task, though here age does not end the wait.
    // ponytail: a commit made before the merge and never pushed goes from ls too; it stays on the
    // branch (dropBranch in gc.ts), and resume brings it back.
    let merged: string | null = null
    for (const url of linksOf(ledger, task)) {
      const pr = await prs(url)
      if (pr === null) continue
      if (pr.state === 'open' && !approvedSince(pr, task)) return null
      if (pr.state === 'merged' && mergedAfter(pr.mergedAt, branch.lastCommitAt) && ownPr(task, pr))
        merged ??= `merged: ${url}`
    }
    return merged
  }
  if (task.finishedAt !== null && Date.parse(task.finishedAt) <= now.getTime() - STALE_DAYS * DAY) {
    return `finished ${STALE_DAYS}+ days ago`
  }
  const sameTodo = (t: Task): boolean =>
    t.id > task.id && t.todoId !== null && t.todoId === task.todoId
  const tookOver = (t: Task): string => `n${t.id} took over t${task.todoId}`
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
  const ends: string[] = []
  for (const url of linksOf(ledger, task)) {
    const pr = await prs(url)
    if (pr === null) continue
    if (pr.state !== 'open') ends.push(`${pr.state}: ${url}`)
    else if (approvedSince(pr, task)) ends.push(`approved: ${url}`)
    else return null
  }
  return ends.length > 0 ? ends.join(', ') : null
}

// Whether the person approved an open pull request since the task was added.
const approvedSince = (pr: PullRequest, task: Task): boolean =>
  pr.approvedAt !== null && Date.parse(pr.approvedAt) >= Date.parse(task.createdAt)

// Whether a pull request is the task's branch's own: its head is a branch of that name in the repo
// nod pushes to, `origin`'s (pushUrls). One of that name in another repo or a fork is someone
// else's, and so is one whose head repo is not known. Only as its remote addresses are written: an
// ssh alias for the service's host reads as another host.
const ownPr = (task: Task, pr: PullRequest): boolean =>
  pr.head === task.branch &&
  task.repo !== null &&
  pushUrls(task.repo).some((u) => sameRepo(pr.headRepo, u))

// Whether a merge came after the branch's last commit, where that is known: a commit made since is
// not in it.
const mergedAfter = (mergedAt: string | null, lastCommitAt: string | null): boolean =>
  mergedAt !== null && (lastCommitAt === null || Date.parse(lastCommitAt) < Date.parse(mergedAt))

// Whether nod lands the task itself (land.ts) and has not merged it yet nor stopped: its repo lets
// nod land, and it is named (`only`, or else a landing begun) or was added since the repo let nod
// land. A link someone else made means its result went out another way.
export function lands(ledger: Ledger, task: Task, only?: number[]): boolean {
  const repo = ledger.repos().find((r) => r.path === task.repo)
  if (repo === undefined || repo.land === 'off') return false
  const l = ledger.landing(task.id)
  if (l !== null && (l.stopped !== null || l.mergedAt !== null)) return false
  const named = only === undefined ? l !== null : only.includes(task.id)
  const since = repo.raisedAt !== null && task.createdAt >= repo.raisedAt
  if (!named && !(only === undefined && since)) return false
  return ledger.links(task.id).every((url) => url === l?.pr)
}

// Where a succeeded task's work leaves its todo (followTasks in todos.ts): done once the task's
// changes are in the default branch, its own pull request (ownPr) merged, or nod merged it, and
// when it made no commits of its own; waiting while that pull request is open, or nod lands it;
// next while its commits wait on the person. `prs` null, as the hooks call it, reads no git
// service: a task with a pull request linked waits for gc or the tick to read it.
// ponytail: a repo with no `origin/HEAD` reads as one whose tasks made no commits, as in gc.
export async function workLeft(ledger: Ledger, task: Task, prs: PrLookup | null): Promise<Left> {
  const { repo } = task
  if (repo === null || task.branch === null || task.workspace === null) return { status: 'done' }
  const branch = branchState(task)
  // gc deletes the branch only once the default branch has its changes; once the branch is gone,
  // the head gc recorded is read in its place.
  const inMain =
    branch === null
      ? task.head !== null && landed(repo, task.head)
      : branch.own === 0 || branch.landed
  if (inMain) return { status: 'done' }
  // When its last commit was made, that of the head gc recorded once the branch is gone: one made
  // after a merge, pushed or not, is not in it. Unknown without either.
  let lastAt: string | null | undefined
  const lastCommitAt = (): string | null => {
    if (lastAt !== undefined) return lastAt
    const ref = branch === null ? task.head : `refs/heads/${task.branch}`
    lastAt = branch?.unpushed ? branch.lastCommitAt : ref === null ? null : commitTime(repo, ref)
    return lastAt
  }
  // nod merged its landing (land.ts).
  const landedAt = ledger.landing(task.id)?.mergedAt ?? null
  if (landedAt !== null && mergedAfter(landedAt, lastCommitAt())) return { status: 'done' }
  let merged = false
  for (const url of linksOf(ledger, task)) {
    if (prs === null) {
      if (isPullRequest(url)) return { status: 'waiting', pr: null }
      continue
    }
    const pr = await prs(url)
    if (pr === null || !ownPr(task, pr)) continue
    if (pr.state === 'open') return { status: 'waiting', pr: url }
    if (pr.state === 'merged' && mergedAfter(pr.mergedAt, lastCommitAt())) merged = true
  }
  if (merged) return { status: 'done' }
  return lands(ledger, task) ? { status: 'waiting', pr: null } : { status: 'next' }
}

// Moves the todos that wait on their tasks along by what the work left (followTasks in todos.ts).
// With `prs`, as gc and the tick call it, it reads the linked pull requests and looks again at the
// todos it left open; a task it cannot read is told on stderr and looked at the next time.
export function followWork(ledger: Ledger, actor: string, prs: PrLookup | null): Promise<void> {
  const left = (task: Task): Promise<Left | null> =>
    workLeft(ledger, task, prs).catch((error) => {
      console.error(`nod: could not read what task n${task.id} left: ${message(error)}`)
      return null
    })
  return new Todos(ledger).followTasks(actor, left, prs !== null)
}

// The links on a task and on its todo, each once.
function linksOf(ledger: Ledger, task: Task): string[] {
  const todoLinks = task.todoId === null ? [] : new Todos(ledger).links(task.todoId)
  return [...new Set([...ledger.links(task.id), ...todoLinks.map((l) => l.url)])]
}

type BranchState = { own: number; landed: boolean } & (
  | { unpushed: false }
  | { unpushed: true; lastCommitAt: string }
)

// A repo task's branch: how many commits the task made that the remote's default branch lacks,
// whether the default branch has its changes, whether some of its commits are on no remote and not
// merged either, and if so its last commit's time, the committer's, which a rebase sets anew. Null
// without a repo, once the branch is gone, or for a task that never started and so keeps no branch
// of its own (dropBranch in gc.ts): one by its name is someone else's. Only as fresh as the repo's
// last fetch.
function branchState(task: Task): BranchState | null {
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
  if (notOnRemotes === 0 || merged) return { own, landed: merged, unpushed: false }
  return { own, landed: merged, unpushed: true, lastCommitAt: commitTime(repo, ref) }
}

// The time of ref's last commit, the committer's, which a rebase sets anew.
function commitTime(repo: string, ref: string): string {
  // log.showSignature would print the signature's check ahead of the time.
  const last = Bun.spawnSync([
    'git',
    '-C',
    repo,
    'log',
    '-1',
    '--no-show-signature',
    '--format=%cI',
    ref,
  ])
  if (last.exitCode !== 0) throw new Error(`git log in ${repo}: ${last.stderr.toString()}`)
  return last.stdout.toString().trim()
}
