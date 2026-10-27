import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Ledger } from './ledger'

// nod answers a worker's permission prompt itself when it is sure the command only touches what the
// task's own folder can make again: Claude Code's PermissionRequest hook runs as it is about to ask,
// in auto mode too, and also for a prompt an ask rule of the repo forces (measured on 2.1.310, with
// `Bash(rm -rf *)` as an ask rule). An ask rule keeps the person's own checkout safe, not a worktree
// of nod's. The judgment is code, a short list: anything not on it, or that nod cannot read, gets no
// answer, so the prompt shows and becomes a decision as before.
// ponytail: only rm -rf and dependency installs, the shapes asked about; add a shape once it keeps
// coming up as a decision nobody hesitates on.

// What the hook prints to allow (docs: PermissionRequest decision control).
export const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
}

// What Claude Code passes the hook on stdin (measured on 2.1.310); only the fields nod reads. `cwd`
// is where the shell is, after a `cd` the worker ran before.
export const PermissionEvent = z.object({
  session_id: z.string(),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
})

// Plain words only: no `;`, `&`, `|`, newline, `$`, backtick, quotes, glob, `~`, redirection.
const WORD = /^[A-Za-z0-9._/@-]+$/
// The package managers and their commands that only add or remove dependencies.
const INSTALLERS = new Map([
  ['bun', ['install', 'i', 'add', 'remove']],
  ['npm', ['install', 'i', 'ci', 'uninstall']],
  ['pnpm', ['install', 'i', 'add', 'remove']],
  ['yarn', ['install', 'add', 'remove']],
])
const INSTALL_FLAGS = new Set([
  '-d',
  '-D',
  '--dev',
  '--save-dev',
  '-E',
  '--exact',
  '--frozen-lockfile',
])
// A registry package by name, scoped or not, with a version or tag: no path, URL, git or alias.
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._-]+)?$/

// Records and returns whether nod allows this prompt of a worker's. Only Bash, only in the folder of
// the task the session works for.
export function onPermissionRequest(
  ledger: Ledger,
  event: z.infer<typeof PermissionEvent>,
): boolean {
  const { command, dangerouslyDisableSandbox } = event.tool_input
  if (event.tool_name !== 'Bash' || typeof command !== 'string') return false
  if (dangerouslyDisableSandbox === true) return false
  const taskId = ledger.taskOfSession(event.session_id)
  const task = taskId === null ? null : ledger.get(taskId)
  if (task?.workspace == null) return false
  if (!harmless(command, event.cwd, task.workspace, task.repo !== null)) return false
  const attemptId = ledger.openAttempt(task.id)?.id ?? null
  ledger.addNotice({ taskId: task.id, attemptId, event: 'allowed', note: command })
  return true
}

// Whether `command`, run in `cwd`, is on the list: `rm -rf`/`rm -fr` of paths in the task's folder
// `workspace` (in a repo's worktree, ones that hold no uncommitted work), or a package manager adding
// or removing registry packages for a package.json in it. The sandbox still bounds what either
// writes; this keeps out what it lets through, as the repo's shared git folder (docs/design.md).
export function harmless(command: string, cwd: string, workspace: string, repo: boolean): boolean {
  const words = command.trim().split(/ +/)
  if (!words.every((w) => WORD.test(w))) return false
  const root = realOf(workspace)
  const here = realOf(cwd)
  if (root === null || here === null || within(root, here) === null) return false
  const [name = '', sub = '', ...rest] = words
  if (name === 'rm' && (sub === '-rf' || sub === '-fr')) {
    // A work folder with no repo is the task's result itself: nothing there can be made again.
    if (!repo || rest.length === 0) return false
    return rest.every((p) => removable(root, here, p)) && committed(here, rest)
  }
  if (INSTALLERS.get(name)?.includes(sub)) {
    const inRoot = (p: string): boolean => {
      const real = realOf(join(here, p))
      return real !== null && !!within(root, real)
    }
    return (
      exists(join(here, 'package.json')) &&
      inRoot('package.json') &&
      (!exists(join(here, 'node_modules')) || inRoot('node_modules')) &&
      rest.every((w) => INSTALL_FLAGS.has(w) || PACKAGE.test(w))
    )
  }
  return false
}

// A path rm may take: relative, with no `..` and no git folder on the way, and inside `root` but not
// `root` itself once links are resolved, so a link that leads out (to the repo's shared git folder,
// say) is refused.
function removable(root: string, here: string, path: string): boolean {
  if (path.startsWith('/') || path.startsWith('-')) return false
  if (path.split('/').some((p) => p === '..' || isGit(p))) return false
  const real = realOf(resolve(here, path))
  const rel = real === null ? null : within(root, real)
  return !!rel && !rel.split(sep).some(isGit)
}

// No uncommitted change and no untracked file under the paths: what goes is in git or ignored
// (dependencies, build output), so it comes back.
function committed(here: string, paths: string[]): boolean {
  const status = Bun.spawnSync(
    [
      'git',
      '--no-optional-locks',
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--',
      ...paths,
    ],
    { cwd: here, stdout: 'pipe', stderr: 'pipe' },
  )
  return status.exitCode === 0 && status.stdout.length === 0
}

// The case of the file system's, which on macOS need not be the name's.
const isGit = (part: string): boolean => part.toLowerCase() === '.git'

// `path` relative to `root` when inside it, '' for `root` itself, null when outside.
function within(root: string, path: string): string | null {
  const rel = relative(root, path)
  return rel.split(sep)[0] === '..' || isAbsolute(rel) ? null : rel
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// `path` with every link on it resolved, in the file system's own case; for a path that does not
// exist yet, its nearest existing folder's. Null when a link on the way leads nowhere, or it cannot
// be read: nod cannot tell where that goes.
// ponytail: read before the command runs; something else in the folder could change it in between.
function realOf(path: string): string | null {
  const missing: string[] = []
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), ...missing.reverse())
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT' || exists(at)) return null
      if (dirname(at) === at) return null
      missing.push(basename(at))
    }
  }
}
