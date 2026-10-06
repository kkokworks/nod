import { existsSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ledger, TaskStatus } from './ledger'
import { Terminals } from './tmux'
import { sessionName, spawn } from './worker'

const FINISHED: ReadonlySet<TaskStatus> = new Set(['succeeded', 'cancelled', 'error'])

export type GcReport = { removed: number[]; skipped: { id: number; reason: string }[] }

// Removes what tasks finished before `cutoff` left behind: the worker's tmux session, the workspace
// or worktree, and Claude Code's session folder for it. Ledger rows and `nod/<id>` branches stay, so stats
// and commits survive. A plain workspace's files are the task's output, hence the age cutoff.
export async function collect(ledger: Ledger, home: string, cutoff: Date): Promise<GcReport> {
  const report: GcReport = { removed: [], skipped: [] }
  const workRoot = `${join(home, 'work')}/`
  for (const task of ledger.list()) {
    if (!FINISHED.has(task.status) || task.finishedAt === null) continue
    if (Date.parse(task.finishedAt) > cutoff.getTime()) continue
    if (task.workspace === null || !existsSync(task.workspace)) continue
    if (!task.workspace.startsWith(workRoot)) {
      report.skipped.push({ id: task.id, reason: `workspace outside ${workRoot}` })
      continue
    }
    const sessions = sessionFolder(task.workspace) // needs the workspace to exist for realpath
    await Terminals.of(home).close(sessionName(task.id))

    if (task.repo !== null) {
      const status = await spawn(['git', '-C', task.workspace, 'status', '--porcelain'], undefined)
      if (status.code !== 0 || status.stdout.trim()) {
        report.skipped.push({ id: task.id, reason: 'uncommitted changes in worktree' })
        continue
      }
      const removed = await spawn(
        ['git', '-C', task.repo, 'worktree', 'remove', task.workspace],
        undefined,
      )
      if (removed.code !== 0) {
        report.skipped.push({ id: task.id, reason: removed.output.trim() })
        continue
      }
    } else {
      rmSync(task.workspace, { recursive: true })
    }

    if (existsSync(sessions)) rmSync(sessions, { recursive: true })
    report.removed.push(task.id)
  }
  return report
}

// Claude Code keeps one session folder per working directory, named after its real path with `/`
// and `.` turned into `-` (observed on 2.1.289). That is Claude Code's internal layout, so the rule
// lives only here.
export function sessionFolder(workspace: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(configDir, 'projects', realpathSync(workspace).replace(/[/.]/g, '-'))
}
