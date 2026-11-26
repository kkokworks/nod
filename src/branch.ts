import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
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

// nod's own git calls run no hooks and no file system monitor that a config names: a core.hooksPath
// into the worktree (husky's) runs what the branch brings there, and git status and diff run git in
// each submodule with that one's own config, which the worker can write (docs/design.md, 「워커가 쓸
// 수 있는 git 설정」). Either would run outside the sandbox. git passes these settings on to the git
// it runs in submodules. A rebase going on takes its messages as they are.
export const NOD_GIT = [
  'git',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.editor=true',
]

// For nod's git that reads a worktree's files or a submodule's git folder: no lazy fetch of an
// object a partial clone lacks, which runs the remote command (core.sshCommand, an upload-pack) that
// a submodule's config names. A rebase takes it unless the repo is a partial clone (rebaseEnv).
// Before 2.44 git ignores it.
export const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: '1' }

// For a rebase in a task's worktree: NO_LAZY_FETCH, unless the repo is a partial clone itself, whose
// rebase fetches what it lacks. To merge a submodule both sides moved, git looks for its commits in
// that submodule's git folder, and a lazy fetch there would go by that one's config.
export function rebaseEnv(ws: string): Record<string, string> {
  const partial = Bun.spawnSync(['git', '-C', ws, 'config', '--get', 'extensions.partialClone'])
  return partial.exitCode === 0 ? {} : NO_LAZY_FETCH
}

// git status --porcelain in a task's worktree, as nod's checks read it.
export const worktreeStatus = (ws: string, ...args: string[]) =>
  spawn([...NOD_GIT, '-C', ws, 'status', '--porcelain', ...args], undefined, { env: NO_LAZY_FETCH })

// fetch and push reach the remote: a network that hangs, or a login that would ask for a password
// no one is there to type, must not hold the tick. They run in a process group of their own, so the
// timeout also ends the remote helper or ssh git starts, which would hold the output open.
const GIT_TIMEOUT_MS = 2 * 60_000

// git on the remote, which may never answer and must not ask (GIT_TIMEOUT_MS). A fetch does not go
// on into submodules, which it does by default once a fetched commit moves one: it would fetch with
// that submodule's config, the worker's to write, and the remote command it names.
export function onRemote(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return spawn([...NOD_GIT, '-c', 'fetch.recurseSubmodules=false', ...args], cwd, {
    env: { GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

// What a worker's sandbox may not write in the repo's shared git folder (docs/design.md, 「워커가
// 쓸 수 있는 공용 git 폴더」). Claude Code opens that folder to a worktree's commands, as a commit
// writes its objects, its branch and their logs there, and itself keeps them out of only its config,
// hooks and the other worktrees' folders (2.1.332). The main checkout's own files: its HEAD and
// index, the merge or rebase it has going, its HEAD's log, its submodules' git folders, and info/
// (exclude, sparse-checkout). Not packed-refs.lock: git takes it to delete any ref, the
// CHERRY_PICK_HEAD a cherry-pick ends with too.
const MAIN_CHECKOUT = [
  'HEAD',
  'HEAD.lock',
  'index',
  'index.lock',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'SQUASH_MSG',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'sequencer',
  'modules',
  'info',
]
// Refs no worker moves: every packed one, tags, remote-tracking refs (gc reads one as the branch's
// copy on the remote), and replace refs, which would change what nod's review reads.
const SHARED_REFS = ['packed-refs', 'packed-refs.new', 'refs/tags', 'refs/remotes', 'refs/replace']

// Those paths for a task on branch `own` in `repo`, with the branch the main checkout has out and
// the remote's default branch, as they are now; none once git cannot read the repo.
export function sharedGitDenies(repo: string, own: string, platform = process.platform): string[] {
  const read = (...args: string[]): string => {
    const r = Bun.spawnSync([...NOD_GIT, '-C', repo, ...args])
    return r.exitCode === 0 ? r.stdout.toString().trim() : ''
  }
  const dir = read('rev-parse', '--path-format=absolute', '--git-common-dir')
  if (dir === '') return []
  // Real, as a path that is not there yet is denied only as written.
  const common = realpathSync(dir)
  const folder = (branch: string) => (branch.includes('/') ? branch.split('/')[0] : null)
  const branches = [
    read('symbolic-ref', '-q', 'HEAD'),
    read('symbolic-ref', '-q', 'refs/remotes/origin/HEAD'),
  ]
    .map((ref) => ref.replace(/^refs\/(heads|remotes\/origin)\//, ''))
    // On macOS the sandbox also keeps a denied path's folders from being made (2.1.332), and a gc
    // that packs the refs of a folder (fix/) removes it, which the worker's next commit makes again.
    .filter((b) => b !== '' && b !== own && (folder(b) === null || folder(b) !== folder(own)))
  const paths = [
    ...MAIN_CHECKOUT,
    // Only in a logs/ that is there: the sandbox would keep it from being made too (above), and a
    // repo without one (logAllRefUpdates off) has a stash make it for its reflog.
    ...(existsSync(join(common, 'logs')) ? ['logs/HEAD'] : []),
    ...SHARED_REFS,
    ...[...new Set(branches)].flatMap((b) => [`refs/heads/${b}`, `refs/heads/${b}.lock`]),
  ].map((p) => join(common, p))
  // On Linux the sandbox makes an empty file at a denied path that is not there for as long as
  // each command runs (2.1.332): a HEAD.lock there would stop the person's commits.
  return platform === 'linux' ? paths.filter((p) => existsSync(p)) : paths
}

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
// A submodule in conflict is one too; git status in each submodule is not needed to tell.
export async function unmergedFiles(ws: string): Promise<string> {
  const diff = [...NOD_GIT, 'diff', '--name-only', '--diff-filter=U', '--ignore-submodules=all']
  return (await spawn(diff, ws, { env: NO_LAZY_FETCH })).stdout.trim()
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
