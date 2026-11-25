import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { squeeze, WAIT } from './dialog'
import type { Ledger, Notice } from './ledger'
import { message } from './proc'
import { autoModeDenied, inBackground } from './transcript'

// nod answers a worker's permission prompt itself in two cases: Claude Code's PermissionRequest hook
// runs as it is about to ask, in auto mode too. It allows a command it is sure only touches what the
// task's own folder can make again (harmless), also one whose prompt an ask rule of the repo forces
// (measured on 2.1.310, with `Bash(rm -rf *)` as an ask rule): that rule keeps the person's own
// checkout safe, not a worktree of nod's. And it sends back, allowing nothing, a call auto mode asks
// about only because it had nothing to judge (unjudged): sent again alone, auto mode judges it. The
// judgment is code, a short list: anything else, or that nod cannot read, gets no answer, so the
// prompt shows, and the hook makes it a decision as it does (onPermissionAsk).
// ponytail: of what it allows, only the shapes asked about; add a shape once it keeps coming up as a
// decision nobody hesitates on.

// What the hook prints to allow, and to send the call `command` back (docs: PermissionRequest decision
// control): a deny that leaves the turn going (no `interrupt`), whose message the worker reads as the
// call's result. Of a background subagent's call nod cannot tell why auto mode asks (unjudged), so the
// message does not say that it knows.
export const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
}
const FORM_LIMIT = 500
export const back = (command: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: {
      behavior: 'deny',
      message: `nod sent this call back, and nothing ran. This is no judgment on whether it is safe: auto mode may have had nothing to judge, as a hook changed this call, or one beside it in its response, after auto mode looked at it. Send it again as the only tool call of a response, so that auto mode can judge it; calls that came back together go one response each. Where a hook changes commands (\`git log\` into \`rtk git log\`, say), send the call from the start in the form the hook leaves it${command.length > FORM_LIMIT ? '.' : `, here:\n${command}`}\nIf it asks once more, the person answers it: do not word it differently to get past that.`,
    },
  },
})
type Answer = typeof ALLOW | ReturnType<typeof back>

// What Claude Code passes the hook on stdin (measured on 2.1.310); only the fields nod reads. `cwd`
// is where the shell is, after a `cd` the worker ran before. `agent_id`: only in a subagent's
// (2.1.310's binary). The transcript is the session's in a subagent's too, '' where Claude Code keeps
// none (2.1.331's binary).
export const PermissionEvent = z.object({
  session_id: z.string(),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  agent_id: z.string().optional(),
  permission_mode: z.string().optional(),
  transcript_path: z.string().optional(),
})

// The parameters a Bash call nod allows may have. Any other may open the sandbox for it
// (`allowed_domains`, 2.1.331).
const INPUT = ['command', 'description', 'timeout', 'run_in_background']

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
// What npm and bun take for a tarball in the folder instead (npm-package-arg's file names).
const TARBALL = /\.(tgz|tar|tar\.gz)$/i

// What nod answers this prompt of a worker's, in the ledger too (ALLOW, back); null when it is the
// person's. Only Bash, only for a task's session, never a call that asks to leave the sandbox.
// `screen`: what that task's terminal shows.
export function onPermissionRequest(
  ledger: Ledger,
  event: z.infer<typeof PermissionEvent>,
  screen: (taskId: number) => string,
): Answer | null {
  const { command, dangerouslyDisableSandbox = false, ...rest } = event.tool_input
  if (event.tool_name !== 'Bash' || typeof command !== 'string') return null
  if (dangerouslyDisableSandbox !== false) return null
  const taskId = ledger.taskOfSession(event.session_id)
  const task = taskId === null ? null : ledger.get(taskId)
  if (task?.workspace == null) return null
  const { id, workspace, repo } = task
  if (
    Object.keys(rest).every((key) => INPUT.includes(key)) &&
    harmless(command, event.cwd, workspace, repo !== null)
  ) {
    const attemptId = ledger.openAttempt(id)?.id ?? null
    ledger.addNotice({ taskId: id, attemptId, event: 'allowed', note: command })
    return ALLOW
  }
  const may = (before: Notice[]): boolean => mayGoBack(command, before)
  // Before the dialog is waited for, and again as it goes in.
  if (loses(command) || !may(ledger.sentBack(id))) return null
  if (!unjudged(event, command, () => screen(id))) return null
  return ledger.sendBack(id, command, may) ? back(command) : null
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
    const paths: string[] = []
    for (const p of rest) {
      const asked = removable(root, here, p)
      if (asked === null) return false
      paths.push(...asked)
    }
    return committed(root, paths)
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
      rest.every((w) => INSTALL_FLAGS.has(w) || (PACKAGE.test(w) && !TARBALL.test(w)))
    )
  }
  return false
}

// What git is asked about for rm's `path`, relative to `root`: the path as typed, and the path rm
// reaches, with links and the file system's case resolved (a link with a `/` after it, or `SRC` for
// `src` on macOS, which git takes as another path). Null for a path rm may not take: absolute, with
// `..` or a git folder on the way, or outside `root` or `root` itself once resolved, so a link that
// leads out (to the repo's shared git folder, say) is refused.
function removable(root: string, here: string, path: string): string[] | null {
  if (path.startsWith('/') || path.startsWith('-')) return null
  if (path.split('/').some((p) => p === '..' || isGit(p))) return null
  const typed = within(root, resolve(here, path))
  const real = realOf(resolve(here, path))
  const rel = real === null ? null : within(root, real)
  if (!typed || !rel || rel.split(sep).some(isGit)) return null
  return [typed, rel]
}

// No uncommitted change and no untracked file under the paths: what goes is in git or ignored
// (dependencies, build output, all made in the task: `worktree add` brings nothing ignored), so it
// comes back. git runs outside the sandbox on config the worker can write, as the Stop hook's does;
// the file system monitor, a command that config names, is off.
function committed(root: string, paths: string[]): boolean {
  const status = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      '--no-optional-locks',
      // A folder may be named like pathspec magic (`:(top)x`), which would point git elsewhere.
      '--literal-pathspecs',
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--',
      ...paths,
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  )
  return status.exitCode === 0 && status.stdout.length === 0
}

// Whether `command` loses files, as far as its words tell: rm, git's own (a branch or a stash too), and
// a few more, wherever they stand: behind rtk or env, in a shell of its own, in a script's text. The
// person wants to see these, so none goes back. Not what only writes over a file (`>`, mv, cp).
// ponytail: by its words. One it misses goes back, which runs nothing: auto mode judges it alone.
const VALUE = String.raw`(?!-)(?:"[^"]*"|'[^']*'|\\.|[^\s"'\\])+`
const GIT = String.raw`(?<![\w.-])git(?:\s+(?:-[Cc]|--(?:git-dir|work-tree|namespace))\s+${VALUE}|\s+-\S+)*\s+`
const LOSES = new RegExp(
  [
    String.raw`(?<![\w.-])(?:rm|shred|unlink|rimraf)(?![\w./-])`,
    String.raw`\s--?delete(?:-\w+)*(?![\w-])`,
    String.raw`(?:\brm(?:tree|Sync|dir|dirSync)|\bunlink(?:Sync)?|\.rm|\bos\.remove(?:dirs)?)\s*\(|\brm_(?:r|f|rf)\b`,
    String.raw`${GIT}(?:clean|reset|restore|rm|checkout(?!\s+-b\s)|filter-branch|filter-repo)(?![\w-])`,
    String.raw`${GIT}(?:stash\s+(?:drop|clear)|worktree\s+(?:remove|prune)|reflog\s+(?:expire|delete)|update-ref\s+-d)(?![\w-])`,
    String.raw`${GIT}branch(?:\s+[^\s;&|]+)*?\s+-(?:[A-Za-z]*[dDfM]|-force)(?![\w-])`,
    String.raw`${GIT}switch(?:\s+[^\s;&|]+)*?\s+-(?:[fC]|-force(?:-create)?|-discard-changes)(?![\w-])`,
  ].join('|'),
)
export const loses = (command: string): boolean => LOSES.test(command.replace(/\\\n/g, ' '))

// How many of a task's calls go back in how long (mayGoBack). In the open so a test can lower them.
export const LIMITS = { backs: 30, backsMs: 10 * 60_000 }

// A command goes back once in a task (`before`: what went back so far), so it never goes round: the
// second time is the person's. Nor do more than LIMITS.backs of them in LIMITS.backsMs: something
// makes each one anew (a hook that writes the time into it, a worker that keeps rewording one auto
// mode denies), which would go round with nobody to see it.
const mayGoBack = (command: string, before: Notice[]): boolean =>
  !before.some((n) => n.note === command) &&
  before.filter((n) => Date.now() - Date.parse(n.createdAt) < LIMITS.backsMs).length < LIMITS.backs

// What the dialog says under the command, around how many times in a row (2.1.331's binary, and as
// nod's decisions show it since 2.1.321): only of calls a hook changed, or that ran beside one. And
// what every dialog of a command's ends with.
const ASKS = squeeze('Auto mode needs your confirmation for this command.')
const UNJUDGED = squeeze(
  'consecutive actions were blocked. Please review the transcript before continuing. Latest blocked action: A call in this response changed (or may have changed) after auto mode reviewed it, so auto mode could not check what would run',
)
const PROCEED = squeeze('Do you want to proceed?')

// Whether auto mode asks the person only as its check gave no verdict, three responses running: a hook
// changed this command, or one beside it, after the check saw it (2.1.317 on). Not a prompt that a
// rule of the repo's forces, nor one of a call the check denied as unsafe: neither the hook's input
// nor the transcript says why a prompt shows, so nod reads the dialog (says). A background subagent's
// shows only once this hook is done (2.1.331's and 2.1.332's binary), so of those nod cannot tell: one
// a rule forces, or the check denied, goes back too, and shows the second time. Nor in a session where
// the check denied any call before: those count toward the three, and the person is to see them.
// ponytail: by Claude Code's own words; words it changes leave the prompt to the person. While nod
// waits for the dialog, a message may still go in, whose Enter answers it (as onPermissionAsk says).
function unjudged(
  event: z.infer<typeof PermissionEvent>,
  command: string,
  screen: () => string,
): boolean {
  const { permission_mode, transcript_path, agent_id } = event
  if (permission_mode !== 'auto' || !transcript_path) return false
  try {
    const unseen = agent_id !== undefined && inBackground(transcript_path, agent_id)
    return (unseen || says(command, screen)) && !autoModeDenied(transcript_path, agent_id)
  } catch (error) {
    console.error(`nod: could not tell why the prompt shows: ${message(error)}`)
    return false
  }
}

// Whether the dialog of `command`, the one that shows, says under the command that auto mode had
// nothing to judge; waits for it to show (it may not be drawn yet, or other calls' come first).
function says(command: string, screen: () => string): boolean {
  const dialog = `─${squeeze(command)}─`
  for (const until = Date.now() + WAIT.dialogMs; ; Bun.sleepSync(100)) {
    const under = squeeze(screen()).split(dialog).slice(1).at(-1) ?? ''
    // With no other dialog under it, which would be the one that shows.
    if (under !== '' && !under.includes('─')) {
      const [, before, after] = /^(\D*)\d+(.*)$/s.exec(under) ?? []
      if (before === ASKS && after?.startsWith(UNJUDGED)) return true
      if (under.includes(PROCEED)) return false
    }
    if (Date.now() >= until) return false
  }
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
