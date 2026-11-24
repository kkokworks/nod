import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Ledger } from './ledger'
import { message } from './proc'
import { autoModeDenied } from './transcript'

// nod answers a worker's permission prompt itself when it is sure the command only touches what the
// task's own folder can make again (harmless): Claude Code's PermissionRequest hook runs as it is
// about to ask, in auto mode too, and also for a prompt an ask rule of the repo forces (measured on
// 2.1.310, with `Bash(rm -rf *)` as an ask rule). An ask rule keeps the person's own checkout safe,
// not a worktree of nod's. And when the command is one nobody hesitates on (routine: reads, the
// task's own commits and checks) and auto mode only asks because it had nothing to judge (unjudged).
// The judgment is code, a short list: anything not on it, or that nod cannot read, gets no answer, so
// the prompt shows, and the hook makes it a decision as it does (onPermissionAsk).
// ponytail: only the shapes asked about; add a shape once it keeps coming up as a decision nobody
// hesitates on.

// What the hook prints to allow (docs: PermissionRequest decision control).
export const ALLOW = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
}

// What Claude Code passes the hook on stdin (measured on 2.1.310); only the fields nod reads. `cwd`
// is where the shell is, after a `cd` the worker ran before. `agent_id`: only in a subagent's
// (2.1.310's binary). The transcript is the session's in a subagent's too, '' where Claude Code keeps
// none, and the scratchpad's only where there is one (2.1.331's binary).
export const PermissionEvent = z.object({
  session_id: z.string(),
  cwd: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  agent_id: z.string().optional(),
  permission_mode: z.string().optional(),
  transcript_path: z.string().optional(),
  scratchpad_dir: z.string().optional(),
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

// Records and returns whether nod allows this prompt of a worker's. Only Bash, only in the folder of
// the task the session works for. `screen`: what that task's terminal shows.
export function onPermissionRequest(
  ledger: Ledger,
  event: z.infer<typeof PermissionEvent>,
  screen: (taskId: number) => string,
): boolean {
  const { command, dangerouslyDisableSandbox = false, ...rest } = event.tool_input
  if (event.tool_name !== 'Bash' || typeof command !== 'string') return false
  if (dangerouslyDisableSandbox !== false) return false
  if (!Object.keys(rest).every((key) => INPUT.includes(key))) return false
  const taskId = ledger.taskOfSession(event.session_id)
  const task = taskId === null ? null : ledger.get(taskId)
  if (task?.workspace == null) return false
  const { workspace, repo, branch } = task
  let kind: Kind | null = 'work'
  if (!harmless(command, event.cwd, workspace, repo !== null)) {
    kind = routine(command, event.cwd, { workspace, repo, branch }, event.scratchpad_dir)
    if (kind === null || !unjudged(event, command, () => screen(task.id))) return false
  }
  const attemptId = ledger.openAttempt(task.id)?.id ?? null
  const notice = { taskId: task.id, attemptId, event: 'allowed', note: command } as const
  const id = ledger.addNotice(notice)
  // Reads come in rows and leave nothing to tell: kept for nod show, sent to no session.
  if (kind === 'read') ledger.claimNotices([id], null)
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

// How long nod waits for the dialog (it may not be drawn yet, or other calls' come first), and how
// many files it looks through for a secret's name (secretless); past it, it cannot tell. In the open
// so a test can lower them.
export const LIMITS = { dialogMs: 2000, files: 20_000 }
// What the dialog says under the command, around how many times in a row (2.1.331's binary, and as
// nod's decisions show it since 2.1.321): only of calls a hook changed, or that ran beside one. And
// what every dialog of a command's ends with.
const squeeze = (text: string): string => text.replace(/[─╌]{3,}/g, '─').replace(/[\s│]/g, '')
const ASKS = squeeze('Auto mode needs your confirmation for this command.')
const UNJUDGED = squeeze(
  'consecutive actions were blocked. Please review the transcript before continuing. Latest blocked action: A call in this response changed (or may have changed) after auto mode reviewed it, so auto mode could not check what would run',
)
const PROCEED = squeeze('Do you want to proceed?')

// Whether auto mode asks the person only as its check gave no verdict, three calls running: a hook
// changed this command, or one beside it, after the check saw it (2.1.317 on). Not a prompt that a
// rule of the repo's forces, nor one of a call the check denied as unsafe: neither the hook's input
// nor the transcript says why a prompt shows, so nod reads the dialog, the command in it and what it
// says right under it. Nor in a session where the check denied any call before: those count toward
// the three, and the person is to see them.
// ponytail: by Claude Code's own words; words it changes leave the prompt to the person. While nod
// waits for the dialog, a message may still go in, whose Enter answers it (as onPermissionAsk says).
function unjudged(
  event: z.infer<typeof PermissionEvent>,
  command: string,
  screen: () => string,
): boolean {
  if (event.permission_mode !== 'auto' || !event.transcript_path) return false
  const dialog = `─${squeeze(command)}─`
  try {
    for (const until = Date.now() + LIMITS.dialogMs; ; Bun.sleepSync(100)) {
      const says = squeeze(screen()).split(dialog).slice(1).at(-1) ?? ''
      // With no other dialog under it, which would be the one that shows.
      if (says !== '' && !says.includes('─')) {
        const [, before, after] = /^(\D*)\d+(.*)$/s.exec(says) ?? []
        if (before === ASKS && after?.startsWith(UNJUDGED)) break
        if (says.includes(PROCEED)) return false
      }
      if (Date.now() >= until) return false
    }
    return !autoModeDenied(event.transcript_path, event.agent_id)
  } catch (error) {
    console.error(`nod: could not tell why the prompt shows: ${message(error)}`)
    return false
  }
}

// `read` only shows something; `work` is the task's own: a commit on its branch, a check.
type Kind = 'read' | 'work'
// What of a task says where its commands may reach; `repo` and `branch` are null with no repo.
type Where = { workspace: string; repo: string | null; branch: string | null }
// Real paths: `root` of the task's folder, `scratch` of the session's scratchpad, `here` of the shell.
type Place = Where & { root: string; scratch: string | null; here: string }
type Command = { words: string[]; piped: boolean }

// What `command`, run in `cwd`, is when every command in it is a routine one: reading in the task's
// folder or the scratchpad, `git add`/`git commit` on the task's branch, the checks; null otherwise.
// Nothing here deletes or overwrites. The sandbox bounds all of it as any command of the worker's,
// with what they run by their own config (a pager, a hook, a script): `bun test` runs any code there.
export function routine(
  command: string,
  cwd: string,
  task: Where,
  scratchpad?: string,
): Kind | null {
  const root = realOf(task.workspace)
  const here = realOf(cwd)
  if (root === null || here === null || within(root, here) === null || !exists(here)) return null
  const at = { ...task, root, here, scratch: scratchpad ? realOf(scratchpad) : null }
  const kinds = commandsOf(command).map((c) => kindOf(c, at))
  if (kinds.length === 0 || kinds.includes(null)) return null
  return kinds.includes('work') ? 'work' : 'read'
}

// Spaces, a redirection of errors, what goes between commands, or a word: plain letters, single
// quotes, double quotes in which the shell expands nothing. No `=` first, which zsh expands, also
// after quotes that hold nothing.
const TOKEN =
  / +|2>(?:&1|\/dev\/null)(?=[ ;|&]|$)|&&|[;|]|(?!(?:''|"")*=)(?:[A-Za-z0-9._/@:,+%=-]|'[^']*'|"(?:[^"\\$`]|\\[^$`\n])*")+/gy

// The commands in `command`, in order, joined by `;`, `&&` or `|`; none when it holds anything else.
function commandsOf(command: string): Command[] {
  if (/[^\P{Cc}\n]/u.test(command)) return []
  const commands: Command[] = [{ words: [], piped: false }]
  let read = 0
  for (const [token] of command.matchAll(TOKEN)) {
    read += token.length
    if (token === ';' || token === '&&' || token === '|') {
      commands.push({ words: [], piped: token === '|' })
    } else if (!token.startsWith(' ') && !token.startsWith('2>')) {
      commands.at(-1)?.words.push(unquoted(token))
    }
  }
  return read === command.length && commands.every((c) => c.words.length > 0) ? commands : []
}

const unquoted = (word: string): string =>
  word.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/gs, (_, single, double) =>
    typeof single === 'string' ? single : double.replace(/\\(["\\])/g, '$1'),
  )

// What an option of a command may be: alone (`flag`), or with the next word, a number (`count`) or
// any (`text`). No other, so none that writes, runs or follows something, nor one cut short for it.
type Options = { flag?: RegExp; count?: RegExp; text?: RegExp }
const READERS = new Map<string, Options>([
  ['cat', { flag: /^-[bn]+$/ }],
  ['head', { flag: /^-[nc]?\d+$/, count: /^-[nc]$/ }],
  ['tail', { flag: /^-[nc]?\+?\d+$/, count: /^-[nc]$/ }],
  ['wc', { flag: /^-[clmw]+$/ }],
  ['ls', { flag: /^-[1AFRSadhlprt]+$/ }],
])
const RTK_READ: Options = {
  flag: /^(-n|--line-numbers)$/,
  count: /^(-m|--max-lines|--tail-lines)$/,
}
const GREP: Options = {
  flag: /^(-[EFGHIPachilnoqrsvwx]+|-[EFGHIPachilnoqrsvwx]*[ABCm]\d+|--(include|exclude|exclude-dir)=.*|--color=never)$/,
  count: /^-[EFGHIPachilnoqrsvwx]*[ABCm]$/,
  text: /^-[EFGHIPachilnoqrsvwx]*e$/,
}
// find's tests, and how many words each takes; none that deletes, runs or writes.
const FIND = new Map([
  ...'-not ! ( ) -o -or -a -and -print -prune -empty'.split(' ').map((t) => [t, 0] as const),
  ...'-name -iname -path -ipath -type -maxdepth -mindepth -size -mtime -mmin'
    .split(' ')
    .map((t) => [t, 1] as const),
])
const DIFF =
  'p|s|w|b|R|z|M|W|U\\d+|-patch|-no-patch|-stat|-shortstat|-numstat|-name-only|-name-status|-summary|-raw|-cached|-staged|-unified=\\d+|-ignore-all-space|-ignore-space-change|-no-color|-color=never|-no-ext-diff|-no-textconv|-no-renames|-find-renames|-diff-filter=[A-Za-z]+|-check|-exit-code|-quiet|-word-diff|-merge-base|-full-index|-function-context'
// Not `%G`, nor `%+G` and the like, which has git run the program that checks signatures.
const LOG =
  'i|\\d+|n\\d+|[SG].+|-oneline|-(format|pretty)=(?!.*%[+ -]?G).*|-abbrev-commit|-no-merges|-merges|-first-parent|-graph|-all|-branches|-remotes|-tags|-decorate|-no-decorate|-reverse|-follow|-date=[\\w:-]+|-(since|until|after|before|author|committer|grep)=.*|-max-count=\\d+|-skip=\\d+|-left-right|-cherry-pick|-boundary'
const GIT = new Map<string, Options>([
  ['log', { flag: new RegExp(`^-(${LOG}|${DIFF})$`), count: /^-n$/, text: /^-[SG]$/ }],
  ['show', { flag: new RegExp(`^-(${LOG}|${DIFF})$`), count: /^-n$/ }],
  ['diff', { flag: new RegExp(`^-(${DIFF}|[SG].+)$`) }],
  [
    'status',
    {
      flag: /^(-[sbz]+|-u(no|normal|all)?|--(short|branch|long|ignored|porcelain(=v[12])?|untracked-files(=\w+)?))$/,
    },
  ],
  ['grep', { ...GREP, flag: new RegExp(`${GREP.flag?.source}|^--cached$`) }],
  [
    'ls-files',
    {
      flag: /^(-[cdmostz]+|--(cached|deleted|modified|others|stage|exclude-standard|full-name))$/,
    },
  ],
  [
    'rev-parse',
    {
      flag: /^(-q|--(verify|quiet|short(=\d+)?|abbrev-ref|symbolic-full-name|show-toplevel|show-prefix|is-inside-work-tree))$/,
    },
  ],
  ['blame', { flag: /^(-[wse]+|-L\d+,[+-]?\d+|--(porcelain|date=[\w-]+))$/, text: /^-L$/ }],
])
const CHECKS = ['test', 'typecheck', 'lint', 'check']
const BUN_TEST: Options = {
  flag: /^--(bail|only|todo|dots|randomize|only-failures|(bail|timeout|rerun-each|seed|max-concurrency)=\d+|test-name-pattern=.*)$/,
  count: /^--(timeout|rerun-each|seed|max-concurrency)$/,
  text: /^(-t|--test-name-pattern)$/,
}

// Names a secret may be kept under, of a file or of a folder on the way to it.
const SECRET =
  /^(\.env.*|(.*\.(env|pem|key|p8|p12|pfx|jks|keystore|ppk|kdbx|tfvars)|[._]?(npmrc|netrc|pgpass|pypirc|htpasswd))([.~].*)?|env\.(local|dev|prod|stag).*|\.dev\.vars.*|id_.*|.*credential.*|secrets?(\..*)?|auth\.json|kubeconfig.*|service[-_]?account.*|\.(yarnrc.*|ssh|aws|gnupg|kube|docker|dockercfg))$/i

function kindOf({ words, piped }: Command, at: Place): Kind | null {
  const rtk = words[0] === 'rtk'
  const [name = '', ...args] = rtk ? words.slice(words[1] === 'proxy' ? 2 : 1) : words
  const reads = (paths: string[] | null, all = readable): Kind | null =>
    paths?.every((p) => all(at, p)) ? 'read' : null
  if (rtk && words[1] === 'read') return reads(operands(args, RTK_READ))
  const reader = READERS.get(name)
  // Past the first path, BSD's take an option for a path too.
  if (reader !== undefined) return reads(operands(args, reader, true))
  if (name === 'sed') {
    const [quiet, script = '', ...paths] = args
    if (quiet !== '-n' || !/^\d+(,\d+)?p$/.test(script)) return null
    return paths.some((p) => p.startsWith('-')) ? null : reads(paths)
  }
  if (name === 'grep') {
    // rtk's own takes a number: another word is the pattern.
    if (rtk && words[1] === 'grep' && args.includes('-l')) return null
    const paths = searched(args, GREP)
    if (paths === null) return null
    // With no path it reads what is piped in, or else all of the folder it runs in.
    const stdin = piped && !rtk && !args.some((w) => /^-[A-Za-z]*r/.test(w))
    return reads(paths.length > 0 || stdin ? paths : ['.'], searchable)
  }
  if (name === 'find') return reads(found(args))
  if (name === 'git') return gitKind(args, at)
  if (name !== 'bun') return null
  if (args[0] === 'run') {
    return args.length === 2 && CHECKS.includes(args[1] ?? '') && packaged(at) ? 'work' : null
  }
  if (args[0] !== 'test') return null
  return reads(operands(args.slice(1), BUN_TEST)) && 'work'
}

function gitKind([sub = '', ...args]: string[], at: Place): Kind | null {
  if (sub === 'add') {
    const paths = operands(args, {})
    if (paths === null || paths.length === 0) return null
    return paths.every((p) => addable(at, p)) && onBranch(at) ? 'work' : null
  }
  if (sub === 'commit') return commits(args, at) && onBranch(at) ? 'work' : null
  const options = GIT.get(sub)
  if (options === undefined) return null
  const words = sub === 'grep' ? searched(args, options) : operands(args, options)
  if (!words?.every((w) => gitReadable(at, w)) || branchAt(at) === null) return null
  return sub === 'grep' && !unlinked(at) ? null : 'read'
}

// The words of `args` that are no option, and none when an option is not one of `options`, or with
// `first` comes after such a word. Nor with a word that starts as an option past `--`, which rtk may
// leave out, or as an option's text.
function operands(args: string[], options: Options, first = false): string[] | null {
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? ''
    if (!word.startsWith('-')) words.push(word)
    else if (first && words.length > 0) return null
    else if (word === '--') {
      const rest = args.slice(i + 1)
      return rest.some((w) => w.startsWith('-')) ? null : [...words, ...rest]
    } else if (options.text?.test(word)) {
      if (args[++i]?.startsWith('-') !== false) return null
    } else if (options.count?.test(word)) {
      if (!/^\+?\d+$/.test(args[++i] ?? '')) return null
    } else if (!options.flag?.test(word)) return null
  }
  return words
}

// Those of grep, git's too, past the pattern.
function searched(args: string[], options: Options): string[] | null {
  const words = operands(args, options)
  return words === null || args.some((w) => options.text?.test(w)) ? words : words.slice(1)
}

// The paths find starts from, when all its tests are FIND's.
function found(args: string[]): string[] | null {
  const from = args.findIndex((w) => /^[-(!]/.test(w))
  const tests = from === -1 ? [] : args.slice(from)
  for (let i = 0; i < tests.length; i++) {
    const takes = FIND.get(tests[i] ?? '')
    if (takes === undefined) return null
    i += takes
  }
  return from === -1 ? args : args.slice(0, from)
}

// `git commit` of what is staged, with its message: -m, -F, -q, and no path.
function commits(args: string[], at: Place): boolean {
  let said = false
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? ''
    if (word === '-q' || word === '--quiet') continue
    const value = args[++i]
    if (value === undefined || !/^-q?[mF]$/.test(word)) return false
    if (word.endsWith('F') && (value.startsWith('-') || !readable(at, value))) return false
    said = true
  }
  return said
}

const onBranch = (at: Place): boolean => at.branch !== null && branchAt(at) === at.branch

// The branch git is on where the shell stands, null when that is not the task's worktree itself: no
// repo, or another one, in the folder or that a link, a file or a setting there leads git to. git
// only reads its own folder here: it runs nothing its config names.
function branchAt({ root, here, repo }: Place): string | null {
  if (repo === null || !exists(repo)) return null
  const ask = (cwd: string, ...args: string[]): string[] => {
    const asked = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return asked.exitCode === 0 ? asked.stdout.toString().split('\n') : []
  }
  const [shared, top, branch] = ask(here, '--show-toplevel', '--abbrev-ref', 'HEAD')
  const [own] = ask(repo)
  if (!shared || !top || !branch || !own || realOf(top) !== root) return null
  const real = realOf(resolve(repo, own))
  return real !== null && real === realOf(resolve(here, shared)) ? branch : null
}

// Whether every folder here that git tracks files in is still one in the task's folder: `git grep`
// reads past a link put in its place. git only lists its index here.
function unlinked({ root, here }: Place): boolean {
  const listed = Bun.spawnSync(['git', '-c', 'core.fsmonitor=false', 'ls-files', '-z'], {
    cwd: here,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const folders = new Set(listed.stdout.toString().split('\0').map(dirname))
  return (
    listed.exitCode === 0 &&
    [...folders].every((f) => {
      const real = realOf(join(here, f))
      return real !== null && within(root, real) !== null
    })
  )
}

// Whether bun run finds its scripts in the task's folder, not past it.
function packaged(at: Place): boolean {
  for (let dir = at.here; within(at.root, dir) !== null; dir = dirname(dir)) {
    const file = join(dir, 'package.json')
    if (exists(file)) return inside(at.root, realOf(file))
  }
  return false
}

const inside = (root: string | null, real: string | null): boolean => {
  const rel = root === null || real === null ? null : within(root, real)
  return rel !== null && !rel.split(sep).some((p) => isGit(p) || SECRET.test(p))
}

// Whether `path`, links resolved, is in the task's folder or the scratchpad, and no git folder nor
// the name of a secret is on the way, as typed (of an absolute path, whose folders may lead to the
// task's own, its end) or as resolved. `..` may go through a link, which is not where nod takes it. A
// `:` is git's, `<commit>:<path>`.
function readable(at: Place, path: string): boolean {
  const parts = path.split(/[/:]/)
  if (parts.includes('..')) return false
  const typed = isAbsolute(path) ? [basename(path)] : parts
  if (typed.some((p) => isGit(p) || SECRET.test(p))) return false
  const real = realOf(resolve(at.here, path))
  return inside(at.root, real) || inside(at.scratch, real)
}

// Nor, for a folder that is read whole, in anything under it.
const searchable = (at: Place, path: string): boolean =>
  readable(at, path) && secretless(resolve(at.here, path))

// A commit, or a path or pattern of git's: none of git's own spellings but one that leaves a path out,
// and of patterns only `*.ts` and the like, which names `.ts` too. Nor a path that git may take for
// one outside its worktree: `git diff` then reads files as they are, tracked or not.
const gitReadable = (at: Place, word: string): boolean => {
  if (isAbsolute(word)) return false
  if (/^:[!^]/.test(word)) return !word.split('/').includes('..')
  const named = word.replace(/(^|\/)\*(?=\.[\w.]+$)/, '$1')
  return !/^:|[\\*?[\]]/.test(named) && readable(at, word) && readable(at, named)
}

// What `git add` may take: a plain path in the worktree.
const addable = (at: Place, path: string): boolean =>
  !/[*?[\]\\:]/.test(path) && searchable({ ...at, scratch: null }, path)

// Whether no file or folder under `path` is named as a secret's, or is a git folder; links are not
// followed, as grep -r does not. True of what is no folder.
function secretless(path: string): boolean {
  let seen = 0
  const clear = (folder: string): boolean =>
    readdirSync(folder, { withFileTypes: true }).every((e) => {
      if (++seen > LIMITS.files || SECRET.test(e.name)) return false
      return !e.isDirectory() || (!isGit(e.name) && clear(join(folder, e.name)))
    })
  try {
    return !statSync(path, { throwIfNoEntry: false })?.isDirectory() || clear(path)
  } catch {
    return false
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
