import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ledger, Task, TaskStatus } from './ledger'
import { Terminals } from './tmux'
import { branchOf, message, sessionName, spawn } from './worker'

const FINISHED: ReadonlySet<TaskStatus> = new Set(['succeeded', 'cancelled', 'error'])

// `clean`: tasks that had nothing left to remove, because gc or something else already removed it.
export type GcReport = {
  removed: number[]
  clean: number[]
  skipped: { id: number; reason: string }[]
}

// Which tasks to collect: those finished before a cutoff, the ones the human named, or the ones a
// signal said are done with, as the signal read them (sweep in done.ts).
export type GcPick = { before: Date } | { ids: number[] } | { seen: Task[] }

// Removes what the picked finished tasks left behind: the worker's tmux session, the workspace or
// worktree, and the task's branch once its work is safe elsewhere (see dropBranch). Ledger rows
// stay, so stats survive, and so does Claude Code's session folder, so resume can bring the task
// back (restore in worker.ts). A plain workspace's files are the task's output, hence the age
// cutoff unless the human names the task. Every task gc gets through is marked collected, so ls
// stops listing it: gc is how the human says they have dealt with the task's result.
export async function collect(ledger: Ledger, home: string, pick: GcPick): Promise<GcReport> {
  const report: GcReport = { removed: [], clean: [], skipped: [] }
  const workRoot = `${join(home, 'work')}/`
  const terminals = Terminals.of(home)
  const seen = (id: number): Task | undefined =>
    'seen' in pick ? pick.seen.find((t) => t.id === id) : undefined
  const picked = (task: Task): boolean => {
    if ('ids' in pick) return pick.ids.includes(task.id)
    if ('seen' in pick) return seen(task.id) !== undefined
    return (
      task.collectedAt === null &&
      task.finishedAt !== null &&
      Date.parse(task.finishedAt) <= pick.before.getTime() &&
      // As sweep: a queued task starts from this one's branch.
      ledger.waiting(task.id).length === 0
    )
  }
  for (const { id } of ledger.list()) {
    // Read again as gc gets to it, since gc waits on each task before: one told to go on meanwhile
    // is running again.
    const task = ledger.get(id)
    if (!picked(task)) continue
    const skip = (reason: string): void => {
      report.skipped.push({ id, reason })
    }
    let claimed = false
    // A task gc does not get through is let go again.
    const release = (reason: string): void => {
      if (claimed && task.collectedAt === null) ledger.uncollected(id)
      skip(reason)
    }
    // `nod tell` took the task back (restore in worker.ts) since gc claimed it.
    const takenBack = (): boolean => ledger.get(id).collectedAt === null
    // One task gc cannot get through, a file it may not delete say, must not stop the rest.
    try {
      if (!FINISHED.has(task.status)) {
        skip(`still ${task.status}`)
        continue
      }
      // A turn the person types in keeps the status succeeded until it ends.
      if (terminals.attached(sessionName(id))) {
        skip('a person is attached to its terminal')
        continue
      }
      // Taken before the session closes, so a task told to go on or collected by another gc since
      // it was read is left alone; for sweep, since its signal read it, so one that ran again and
      // finished is judged again.
      claimed = ledger.claimCollect(seen(id) ?? task)
      if (!claimed) {
        skip('changed while gc ran')
        continue
      }
      if (task.workspace === null || !existsSync(task.workspace)) {
        const head = headOf(task)
        dropBranch(task)
        if (task.collectedAt === null) ledger.collected(task.id, head)
        report.clean.push(task.id)
        continue
      }
      if (!task.workspace.startsWith(workRoot)) {
        release(`workspace outside ${workRoot}`)
        continue
      }
      await terminals.close(sessionName(task.id))
      const head = headOf(task)

      if (task.repo !== null) {
        const status = await spawn(
          ['git', '-C', task.workspace, 'status', '--porcelain'],
          undefined,
        )
        if (status.code !== 0 || status.stdout.trim()) {
          release('uncommitted changes in worktree')
          continue
        }
        const only = onlyCopy(task.repo, task.workspace, branchOf(task))
        if (only !== null) {
          release(only)
          continue
        }
      }
      // Looked at last before anything goes, as the session closing and the checks take a while.
      // ponytail: a tell during the removal itself still finds its folder going; closing that needs
      // restore to wait for gc.
      if (takenBack()) {
        skip('told to go on while gc ran')
        continue
      }
      if (task.repo !== null) {
        // --force only because git refuses any worktree with submodules; the checks above already
        // made sure nothing uncommitted or committed only here is lost.
        const removed = await spawn(
          ['git', '-C', task.repo, 'worktree', 'remove', '--force', task.workspace],
          undefined,
        )
        if (removed.code !== 0) {
          release(removed.output.trim())
          continue
        }
      } else {
        rmSync(task.workspace, { recursive: true })
      }
      // Taken back while its folder went: it stays listed, and keeps its branch.
      if (takenBack()) {
        skip('told to go on while gc ran')
        continue
      }
      ledger.collected(task.id, head)
      dropBranch(task)
      // A worktree sits in folders named after its repo and branch; drop the ones it leaves empty.
      for (
        let dir = dirname(task.workspace);
        dir.startsWith(workRoot) && readdirSync(dir).length === 0;
        dir = dirname(dir)
      ) {
        rmdirSync(dir)
      }

      report.removed.push(task.id)
    } catch (error) {
      release(message(error))
    }
  }
  return report
}

// Why removing the worktree would lose commits, or null: worktree remove takes with it the
// worktree's own clone of each submodule (.git/worktrees/<worktree>/modules), with its HEAD,
// branches and stash, and the worktree's HEAD may hold commits no branch has, made on a detached
// HEAD say. A submodule commit is safe on a remote branch, or in the repo's own checkout of the
// submodule, which initSubmodules (worker.ts) cloned it from.
// ponytail: one level of submodules, as initSubmodules fills; a commit only a reflog reaches goes.
function onlyCopy(repo: string, workspace: string, branch: string): string | null {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args])
  if (
    git(workspace, 'merge-base', '--is-ancestor', 'HEAD', `refs/heads/${branch}`).exitCode !== 0
  ) {
    return `HEAD has commits ${branch} does not`
  }
  const paths = git(
    workspace,
    'config',
    '-z',
    '-f',
    '.gitmodules',
    '--get-regexp',
    String.raw`^submodule\..*\.path$`,
  )
  // 1: no .gitmodules, or no submodule in it.
  if (paths.exitCode > 1) throw new Error(`git config in ${workspace}: ${paths.stderr}`)
  // Each entry is the key, a newline, then the path.
  for (const entry of paths.stdout.toString().split('\0').filter(Boolean)) {
    const path = entry.slice(entry.indexOf('\n') + 1)
    const sub = join(workspace, path)
    if (!existsSync(join(sub, '.git'))) continue // never filled, so nothing of its own
    const head = git(sub, 'rev-parse', '--verify', '-q', 'HEAD')
    const refs = git(sub, 'for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/stash')
    if (refs.exitCode !== 0) throw new Error(`git for-each-ref in ${sub}: ${refs.stderr}`)
    const commits = `${head.stdout}\n${refs.stdout}`.split('\n').filter(Boolean)
    const safe = (commit: string): boolean =>
      remotesHolding(sub, commit).length > 0 ||
      git(join(repo, path), 'cat-file', '-e', `${commit}^{commit}`).exitCode === 0
    if (head.exitCode !== 0 || !commits.every(safe)) {
      return `submodule ${path} has commits no remote has`
    }
  }
  return null
}

// Deletes a finished task's branch once its work is safe elsewhere: a remote branch holds its
// commits, or the remote's default branch already has what it changed (a squash merge whose remote
// branch was deleted leaves no remote branch holding them). Otherwise the branch stays, as the only
// copy of the work. So does a branch still checked out somewhere, which git refuses to delete.
// A task that never started made no branch: one by its name is someone else's.
function dropBranch(task: Task): void {
  const { repo, branch } = task
  if (repo === null || branch === null || task.workspace === null) return
  const ref = `refs/heads/${branch}`
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args])
  // The repo or the branch is gone: nothing to delete.
  if (git('rev-parse', '--verify', '-q', ref).exitCode !== 0) return
  if (remotesHolding(repo, ref).length > 0 || landed(repo, ref)) git('branch', '-D', branch)
}

// The commit a repo task's branch points at, or null without a repo or once the branch is gone.
function headOf(task: Task): string | null {
  if (task.repo === null || task.branch === null) return null
  const head = Bun.spawnSync([
    'git',
    '-C',
    task.repo,
    'rev-parse',
    '--verify',
    '-q',
    `refs/heads/${task.branch}`,
  ])
  return head.exitCode === 0 ? head.stdout.toString().trim() : null
}

// Whether the remote's default branch has every file the branch changed, as the branch has it.
// ponytail: compares files, not commits; a file changed again on the default branch after the
// merge makes the branch look unmerged, which only keeps it.
export function landed(repo: string, ref: string): boolean {
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args])
  const main = 'refs/remotes/origin/HEAD'
  const base = git('merge-base', main, ref)
  if (base.exitCode !== 0) return false // no default branch to compare with
  // -z: otherwise git quotes a name that is not ASCII, and the quoted name matches no file.
  const changed = git(
    'diff',
    '-z',
    '--no-renames',
    '--name-only',
    base.stdout.toString().trim(),
    ref,
  )
  if (changed.exitCode !== 0) throw new Error(`git diff in ${repo}: ${changed.stderr}`)
  const files = changed.stdout.toString().split('\0').filter(Boolean)
  // Literal, so a name is the file and not a pattern that matches others or none.
  const same = () => git('--literal-pathspecs', 'diff', '--quiet', ref, main, '--', ...files)
  return files.length === 0 || same().exitCode === 0
}

// The remote branches holding `ref`'s commits. Only as fresh as the repo's last fetch; nod does
// not fetch.
export function remotesHolding(repo: string, ref: string): string[] {
  const refs = Bun.spawnSync([
    'git',
    '-C',
    repo,
    'for-each-ref',
    '--contains',
    ref,
    '--format=%(refname:lstrip=2)',
    'refs/remotes',
  ])
  if (refs.exitCode !== 0) throw new Error(`git for-each-ref in ${repo}: ${refs.stderr}`)
  return refs.stdout
    .toString()
    .split('\n')
    .filter((r) => r !== '' && !r.endsWith('/HEAD'))
}
