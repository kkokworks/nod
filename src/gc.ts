import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ledger, Task, TaskStatus } from './ledger'
import { Terminals } from './tmux'
import { message, sessionName, spawn } from './worker'

const FINISHED: ReadonlySet<TaskStatus> = new Set(['succeeded', 'cancelled', 'error'])

// `clean`: tasks that had nothing left to remove, because gc or something else already removed it.
export type GcReport = {
  removed: number[]
  clean: number[]
  skipped: { id: number; reason: string }[]
}

// Which tasks to collect: those finished before a cutoff, or the ones the human named.
export type GcPick = { before: Date } | { ids: number[] }

// Removes what the picked finished tasks left behind: the worker's tmux session, the workspace or
// worktree, and the task's branch once its work is safe elsewhere (see dropBranch). Ledger rows
// stay, so stats survive, and so does Claude Code's session folder, so resume can bring the task
// back (restore in worker.ts). A plain workspace's files are the task's output, hence the age
// cutoff unless the human names the task. Every task gc gets through is marked collected, so ls
// stops listing it: gc is how the human says they have dealt with the task's result.
export async function collect(ledger: Ledger, home: string, pick: GcPick): Promise<GcReport> {
  const report: GcReport = { removed: [], clean: [], skipped: [] }
  const workRoot = `${join(home, 'work')}/`
  const picked = (task: Task): boolean =>
    'ids' in pick
      ? pick.ids.includes(task.id)
      : task.collectedAt === null &&
        task.finishedAt !== null &&
        Date.parse(task.finishedAt) <= pick.before.getTime()
  for (const task of ledger.list()) {
    if (!picked(task)) continue
    // One task gc cannot get through, a file it may not delete say, must not stop the rest.
    try {
      if (!FINISHED.has(task.status)) {
        report.skipped.push({ id: task.id, reason: `still ${task.status}` })
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
        report.skipped.push({ id: task.id, reason: `workspace outside ${workRoot}` })
        continue
      }
      await Terminals.of(home).close(sessionName(task.id))
      const head = headOf(task)

      if (task.repo !== null) {
        const status = await spawn(
          ['git', '-C', task.workspace, 'status', '--porcelain'],
          undefined,
        )
        if (status.code !== 0 || status.stdout.trim()) {
          report.skipped.push({ id: task.id, reason: 'uncommitted changes in worktree' })
          continue
        }
        // --force only because git refuses any worktree with submodules; the status check above
        // already made sure nothing uncommitted is lost.
        const removed = await spawn(
          ['git', '-C', task.repo, 'worktree', 'remove', '--force', task.workspace],
          undefined,
        )
        if (removed.code !== 0) {
          report.skipped.push({ id: task.id, reason: removed.output.trim() })
          continue
        }
        dropBranch(task)
      } else {
        rmSync(task.workspace, { recursive: true })
      }
      // A worktree sits in folders named after its repo and branch; drop the ones it leaves empty.
      for (
        let dir = dirname(task.workspace);
        dir.startsWith(workRoot) && readdirSync(dir).length === 0;
        dir = dirname(dir)
      ) {
        rmdirSync(dir)
      }

      ledger.collected(task.id, head)
      report.removed.push(task.id)
    } catch (error) {
      report.skipped.push({ id: task.id, reason: message(error) })
    }
  }
  return report
}

// Deletes a finished task's branch once its work is safe elsewhere: a remote branch holds its
// commits, or the remote's default branch already has what it changed (a squash merge whose remote
// branch was deleted leaves no remote branch holding them). Otherwise the branch stays, as the only
// copy of the work. So does a branch still checked out somewhere, which git refuses to delete.
function dropBranch(task: Task): void {
  const { repo, branch } = task
  if (repo === null || branch === null) return
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
  const changed = git('diff', '--no-renames', '--name-only', base.stdout.toString().trim(), ref)
  if (changed.exitCode !== 0) throw new Error(`git diff in ${repo}: ${changed.stderr}`)
  const files = changed.stdout.toString().split('\n').filter(Boolean)
  return files.length === 0 || git('diff', '--quiet', ref, main, '--', ...files).exitCode === 0
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
