import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from './proc'

// A task's branch in its worktree, as nod's own git reads it: where its own commits start, its head,
// and a rebase stopped on it, with what the worker is asked to do about that. For the checks of a
// task's work (verify.ts) and its landing (land.ts).

// Where the branch was created: its oldest reflog entry, since `worktree add -b` records it and later
// commits only add entries. Null once that entry is gone.
export async function createdFrom(worktree: string, branch: string): Promise<string | null> {
  const log = await spawn(
    ['git', 'reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`],
    worktree,
  )
  const [start, ...subject] = (log.stdout.trim().split('\n').at(-1) ?? '').split(' ')
  return log.code === 0 && start && subject.join(' ').startsWith('branch: Created from')
    ? start
    : null
}

// Where the task's own commits start, for its review and where landing rebases it from: where
// landing last recorded them to start (`recorded`), else where the branch was created
// (createdFrom). A worker that brought the remote's default branch (`defaultBranch`) in itself (a
// rebase onto it, or a merge), before landing or in a landing turn, leaves that start behind where
// HEAD now leaves the default branch, or off HEAD once the earlier task the branch started on was
// squash-merged, and the commits between are others': then they start where HEAD leaves it. Null
// with none recorded once the created start is gone.
// ponytail: a branch started on an earlier task's branch that merged the default branch in, rather
// than rebasing onto it, keeps the created start, so its reviewer reads the merged commits too;
// diff from both if that shows up.
export async function ownStart(
  worktree: string,
  branch: string,
  head: string,
  defaultBranch: string,
  recorded: string | null,
): Promise<string | null> {
  const start = recorded ?? (await createdFrom(worktree, branch))
  if (start === null) return null
  // Fails without a default branch fetched, or with no commit in common.
  const left = await spawn(['git', 'merge-base', head, defaultBranch], worktree)
  const main = left.code === 0 ? left.stdout.trim() : start
  if (main === start) return start
  const isAncestor = async (a: string, b: string): Promise<boolean> =>
    (await spawn(['git', 'merge-base', '--is-ancestor', a, b], worktree)).code === 0
  return !(await isAncestor(start, head)) || (await isAncestor(start, main)) ? main : start
}

export async function headOf(worktree: string): Promise<string> {
  const { code, stdout, output } = await spawn(['git', 'rev-parse', 'HEAD'], worktree)
  if (code !== 0) throw new Error(`git rev-parse failed: ${output.trim()}`)
  return stdout.trim()
}

// nod's own git calls run no hooks: one the branch brings (a core.hooksPath into the worktree) would
// run outside the sandbox. A rebase going on takes its messages as they are.
export const NOD_GIT = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.editor=true']

export const gitPath = (ws: string, path: string): string =>
  resolve(
    ws,
    Bun.spawnSync(['git', 'rev-parse', '--git-path', path], { cwd: ws }).stdout.toString().trim(),
  )

// Whether a rebase is going on in the worktree, stopped at a conflict.
export function rebasing(ws: string): boolean {
  return existsSync(gitPath(ws, 'rebase-merge')) || existsSync(gitPath(ws, 'rebase-apply'))
}

// The files a stopped rebase left unmerged, one per line.
export async function unmergedFiles(ws: string): Promise<string> {
  return (await spawn(['git', 'diff', '--name-only', '--diff-filter=U'], ws)).stdout.trim()
}

// The commit a stopped rebase is on and the files in conflict, with how to resolve them.
export async function conflictBrief(ws: string): Promise<string> {
  const files = (await unmergedFiles(ws)).split('\n').filter(Boolean)
  const at = await spawn(['git', 'log', '-1', '--format=%h %s', 'REBASE_HEAD'], ws)
  const listed = files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '- (see git status)'
  return `The rebase stopped at your commit ${at.code === 0 ? at.stdout.trim() : '?'} with conflicts in:\n${listed}\n${RESOLVE}`
}

const RESOLVE =
  "Resolve them in this worktree: keep what the default branch changed and put your branch's change on top of it, dropping neither side silently. Stage each resolved file with `git add <file>`; do not commit, and do not continue or abort the rebase: nod continues it once you report done, and sends you the next conflict if there is one. Skip the subagent review this turn; nod's independent review reads the result. Report each conflict as a table row: | file and place | what the default branch changed | what your branch changed | what you kept and why |. Where numbers or conditions differ and the right one is not clear, ask with NOD: question instead of choosing."
