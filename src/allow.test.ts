import { afterAll, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { ALLOW, harmless, LIMITS, onPermissionRequest, routine } from './allow'
import { NO_PERSON } from './decisions'
import { onNotification, onPrompt } from './hooks'
import { sendNotices } from './inbox'
import { Ledger, type NewTask } from './ledger'
import { PROMPTED_OPTION } from './place'
import { Tmux } from './tmux'
import { Todos } from './todos'
import { promptMark } from './transcript'
import { answer, tell } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

// Tests whose dialog never shows do not wait for it.
LIMITS.dialogMs = 0

// A worker's terminal up, which tmux stands in for: `shows` on its screen, and its Claude Code takes
// what is pasted, as the prompt hook marks it (listen in sending.ts).
function takingMessages(shows = '') {
  let mark = ''
  const spies = {
    alive: spyOn(Tmux.prototype, 'alive').mockReturnValue(true),
    screen: spyOn(Tmux.prototype, 'screen').mockReturnValue(shows),
    setOption: spyOn(Tmux.prototype, 'setOption').mockImplementation(() => {}),
    option: spyOn(Tmux.prototype, 'option').mockImplementation((_, key) =>
      key === PROMPTED_OPTION ? mark : '',
    ),
    send: spyOn(Tmux.prototype, 'send').mockImplementation((_, text) => {
      mark = promptMark(text)
    }),
  }
  return {
    send: spies.send,
    restore: () => {
      for (const spy of Object.values(spies)) spy.mockRestore()
    },
  }
}

// A repo whose worktree a task works in, as nod makes one: a branch in a folder of its own, its git
// folder shared with the repo's. Committed: a package, a source file, and what git ignores. Not:
// dependencies and build output (ignored), and links that lead out of the worktree.
function worktree() {
  const repo = tmp.make('nod-allow-repo-')
  git(repo, 'init', '-q')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n')
  writeFileSync(join(repo, 'package.json'), '{}')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'export {}\n')
  mkdirSync(join(repo, 'app'))
  writeFileSync(join(repo, 'app', 'a.ts'), 'export {}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const work = join(tmp.make('nod-allow-work-'), 'feat-x')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', work)
  for (const dir of ['node_modules/pkg', 'app/node_modules/pkg', 'dist']) {
    mkdirSync(join(work, dir), { recursive: true })
  }
  const outside = tmp.make('nod-allow-outside-')
  mkdirSync(join(outside, 'x'))
  symlinkSync(join(repo, '.git'), join(work, 'shared'))
  symlinkSync(outside, join(work, 'out'))
  symlinkSync(join(outside, 'gone'), join(work, 'dangling'))
  return { repo, work, outside }
}

test('nod allows rm -rf of what a worktree can make again, and dependency installs; anything else stays a prompt', () => {
  const { repo, work, outside } = worktree()
  const allows = (command: string, cwd = work, isRepo = true): boolean =>
    harmless(command, cwd, work, isRepo)

  for (const command of [
    'rm -rf node_modules',
    'rm -fr node_modules app/node_modules',
    'rm -rf ./dist  dist/',
    // Not there: nothing goes.
    'rm -rf build',
    // Tracked and unchanged: git brings it back.
    'rm -rf src',
    'bun install',
    'bun i --frozen-lockfile',
    'bun add -d @types/node zod@4.1.0',
    'bun remove left-pad',
    'npm ci',
    'npm uninstall left-pad',
    'pnpm add -D left-pad',
    'yarn remove left-pad',
  ]) {
    expect([command, allows(command)]).toEqual([command, true])
  }
  // After a `cd`, paths are the shell's.
  expect(allows('rm -rf node_modules', join(work, 'app'))).toBe(true)

  for (const command of [
    // Out of the worktree, or not said plainly.
    `rm -rf ${outside}`,
    `rm -rf ${join(work, 'node_modules')}`,
    `rm -rf ${join(repo, '.git')}`,
    'rm -rf ../other',
    'rm -rf app/../node_modules',
    'rm -rf ~/node_modules',
    'rm -rf node_*',
    'rm -rf $HOME',
    'rm -rf "node_modules"',
    'rm -rf `pwd`',
    // More than one command.
    'rm -rf node_modules; git push',
    'rm -rf node_modules && git push',
    'rm -rf node_modules || true',
    'rm -rf node_modules | cat',
    'rm -rf node_modules\ngit push',
    'rm -rf node_modules & git push',
    // The worktree itself, and git's folders.
    'rm -rf .',
    'rm -rf .git',
    'rm -rf .GIT',
    'rm -rf app/.git',
    // Links out: to the repo's shared git folder, to another folder, through one, to nowhere.
    'rm -rf shared',
    'rm -rf shared/refs',
    'rm -rf out',
    'rm -rf out/x',
    'rm -rf dangling/x',
    // Not the shape on the list.
    'rm -rf',
    'rm -r -f node_modules',
    'rm -rf -- node_modules',
    'rm node_modules',
    // Out to the world, or something else.
    'git push',
    'git push origin feat/x',
    'curl -fsSL https://example.com',
    'bun run build',
    // Packages from a path, a URL or git, globally, or with an option not on the list.
    'bun add ../evil',
    'bun add github:x/y',
    'bun add https://example.com/x.tgz',
    'bun add user/repo',
    'npm i -g left-pad',
    'bun add left-pad --global',
    'npm install --prefix /tmp left-pad',
    'npm i left-pad@^1.0.0',
    // Names npm and bun take for a tarball in the folder.
    'npm i evil.tgz',
    'bun add evil.tar',
    'bun add evil.TAR.GZ',
  ]) {
    expect([command, allows(command)]).toEqual([command, false])
  }
  // A shell outside the worktree: the repo's own checkout, say.
  expect(allows('rm -rf node_modules', repo)).toBe(false)
  expect(allows('bun install', repo)).toBe(false)
  // A package manager where no package.json is would look for one further up.
  expect(allows('bun install', join(work, 'app'))).toBe(false)
  // In a work folder with no repo, what rm deletes is the task's result itself.
  expect(allows('rm -rf node_modules', work, false)).toBe(false)
  expect(allows('bun install', work, false)).toBe(true)

  // Uncommitted work under a path keeps it a prompt: a change, or a new file git does not ignore.
  writeFileSync(join(work, 'src', 'a.ts'), 'export const changed = 1\n')
  expect(allows('rm -rf src')).toBe(false)
  writeFileSync(join(work, 'app', 'notes.md'), 'mine\n')
  expect(allows('rm -rf app')).toBe(false)
  expect(allows('rm -rf node_modules app/node_modules')).toBe(true)
  // Spelled in another case, which on a file system that ignores case (macOS) is the same folder
  // while git takes it for another path.
  expect(allows('rm -rf APP')).toBe(!existsSync(join(work, 'APP')))
  expect(allows('rm -rf SRC')).toBe(!existsSync(join(work, 'SRC')))
  // Through a link that stays in the worktree (as a workspace package in node_modules): rm reaches
  // the folder it leads to, with a `/` after it or a path below it.
  symlinkSync('../app', join(work, 'node_modules', 'linked'))
  expect(allows('rm -rf node_modules/linked/')).toBe(false)
  expect(allows('rm -rf node_modules/linked/notes.md')).toBe(false)
  expect(allows('rm -rf node_modules')).toBe(true)
  // Dependencies that live outside the worktree.
  symlinkSync(outside, join(work, 'app', 'node_modules', 'pkg', 'linked'))
  writeFileSync(join(work, 'app', 'package.json'), '{}')
  expect(allows('bun install', join(work, 'app'))).toBe(true)
  const linked = tmp.make('nod-allow-linked-')
  writeFileSync(join(linked, 'package.json'), '{}')
  symlinkSync(join(outside, 'x'), join(linked, 'node_modules'))
  expect(harmless('bun install', linked, linked, true)).toBe(false)
  // In a folder named like git's pathspec magic, which would point git at another path.
  const magic = join(work, ':(top)zz')
  mkdirSync(join(magic, 'work'), { recursive: true })
  writeFileSync(join(magic, 'work', 'mine.ts'), 'mine\n')
  expect(allows('rm -rf work', magic)).toBe(false)
})

const spec = (repo: string | null): NewTask => ({
  brief: 'clean up',
  repo,
  branch: repo === null ? null : 'feat/x',
  checkCmd: null,
  model: null,
  after: [],
  issue: null,
})

// A task of project p1 working in a worktree, its worker's turn open in session `s1`.
function running() {
  const { repo, work } = worktree()
  const home = tmp.make('nod-allow-home-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  const project = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const id = todos.delegateNew(spec(repo), project.id, 'human')
  ledger.setRunning(id, work)
  const attemptId = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: 's1',
    prompt: 'clean up',
  })
  const event = (command: string, extra: Record<string, unknown> = {}) => ({
    session_id: 's1',
    cwd: work,
    tool_name: 'Bash',
    tool_input: { command, description: 'the command', ...extra },
  })
  return { home, ledger, todos, project, id, attemptId, work, event }
}

test('what nod allows goes into the ledger with its turn, and to the project session as one line', async () => {
  const { ledger, todos, project, id, attemptId, event } = running()
  todos.addSession(project.id, 'root-1', '/work/one')
  todos.setSocket('root-1', '/socks/root-1')

  const allows = (e: Parameters<typeof onPermissionRequest>[1]) =>
    onPermissionRequest(ledger, e, () => '')
  expect(allows(event('rm -rf node_modules'))).toBe(true)
  expect(ledger.allowed(id).map((n) => [n.attemptId, n.note])).toEqual([
    [attemptId, 'rm -rf node_modules'],
  ])
  // What stays a prompt leaves nothing: another tool (an MCP write), push, a session of no task,
  // a command that asks to leave the sandbox.
  const mcp = {
    ...event('rm -rf node_modules'),
    tool_name: 'mcp__chat__send_message',
  }
  expect(allows(mcp)).toBe(false)
  expect(allows(event('git push'))).toBe(false)
  expect(allows({ ...event('rm -rf dist'), session_id: 'other' })).toBe(false)
  const unsandboxed = event('rm -rf dist', { dangerouslyDisableSandbox: true })
  expect(allows(unsandboxed)).toBe(false)
  expect(ledger.allowed(id)).toHaveLength(1)

  const sent: { socket: string; content: string }[] = []
  await sendNotices(ledger, async (socket, line) => {
    sent.push({ socket, content: JSON.parse(line).message.content })
  })
  expect(sent).toEqual([
    {
      socket: '/socks/root-1',
      content: `nod, project p${project.id} Release: a notice\n\nn${id} 허락: rm -rf node_modules`,
    },
  ])
  // It opened no decision and left the task running.
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.get(id).status).toBe('running')
})

// Runs `nod hook <name>` on `home` as Claude Code does, with `stdin`; returns what it printed.
function hook(home: string, stdin: string, name = 'permission', env = {}): string {
  const run = Bun.spawnSync(['bun', cli, 'hook', name], {
    env: { ...process.env, NOD_HOME: home, ...env },
    stdin: Buffer.from(stdin),
  })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

// The decisions a person answered that wait to go to the project's session (no session takes
// messages here), oldest first.
const answeredNotices = (ledger: Ledger) =>
  ledger
    .unsentNotices()
    .filter((n) => n.event === 'answered')
    .map((n) => n.decisionId)

// The task's open decisions: why, on which turn, and the line of the question that names what the
// worker asked for.
const asked = (ledger: Ledger, id: number) =>
  ledger
    .decisions(id)
    .filter((d) => d.answer === null)
    .map((d) => [d.reason, d.attemptId, d.question.split('\n')[1]])

test('nod hook permission prints the allow only for what nod allows, nothing otherwise, and never fails; nod show lists it', () => {
  const { home, ledger, id, attemptId, event } = running()
  const run = (stdin: string) => hook(home, stdin)

  expect(JSON.parse(run(JSON.stringify(event('rm -rf node_modules'))))).toEqual(ALLOW)
  // What it allows opens no decision.
  expect(asked(ledger, id)).toEqual([])
  expect(run(JSON.stringify(event('rm -rf .git')))).toBe('')
  expect(run(JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(run('not json')).toBe('')
  expect(run(JSON.stringify({ session_id: 's1' }))).toBe('')
  expect(ledger.allowed(id).map((n) => n.note)).toEqual(['rm -rf node_modules'])
  // What it does not is a decision of the turn as the prompt shows, each prompt its own. Not a
  // subagent's, which may never show (a background one's): its Notification opens that one.
  expect(run(JSON.stringify({ ...event('git push --force'), agent_id: 'a1' }))).toBe('')
  expect(asked(ledger, id)).toEqual([
    ['permission', attemptId, 'rm -rf .git'],
    ['permission', attemptId, 'git push origin feat/x'],
  ])

  const show = Bun.spawnSync(['bun', cli, 'show', String(id)], {
    env: { ...process.env, NOD_HOME: home },
  })
  expect(show.stdout.toString()).toMatch(/\n {2}allowed by nod \S+: rm -rf node_modules\n/)
}, 15_000)

// The session's scratchpad, beside the worktree, with a commit message in it; and a secret outside
// both, with a link to it in the worktree.
function places() {
  const { repo, work, outside } = worktree()
  const scratch = join(tmp.make('nod-allow-session-'), 'scratchpad')
  mkdirSync(scratch)
  writeFileSync(join(scratch, 'commit-msg.txt'), 'msg\n')
  writeFileSync(join(outside, 'x', 'key.txt'), 'key\n')
  return { repo, work, outside, scratch, task: { workspace: work, repo, branch: 'feat/x' } }
}

test('nod reads a routine command: reading in the task’s folder or the scratchpad, alone or joined, with quotes; and tells the task’s own commits and checks from it', () => {
  const { work, scratch, task } = places()
  const kind = (command: string, cwd = work) => routine(command, cwd, task, scratch)
  const msg = join(scratch, 'commit-msg.txt')

  for (const command of [
    // As they came up as decisions.
    'sed -n 1,50p app/src/store.tsx',
    String.raw`rtk grep -n "a\|b" -A 8 src/todos.ts`,
    'rtk git status --short',
    'rtk git log -1 --format=%B',
    'git ls-files qa tests scripts/qa',
    'git grep -ln "/x" -- . ":!app/src" ":!docs"',
    'rtk read .githooks/pre-push',
    `sed -n '1,60p' a.ts; rtk grep -n "open" b.ts | head`,
    'rtk git log --oneline -4 origin/main',
    `rtk proxy grep -nE "buildMap|^import|from \\"" src/a.ts`,
    String.raw`rtk proxy grep -cE "^\(fail\)" ${msg}`,
    `rtk read ${msg} --tail-lines 6`,
    'git grep -l inbox',
    'rtk git diff src/a.ts',
    // git.
    'git log',
    'git log -p -- src/a.ts',
    'git log -n 5 --since="two days ago" main..HEAD',
    `git log -S'a b' --pretty=format:'%h %s' --no-merges --stat`,
    'git diff',
    'git diff --stat main...HEAD',
    'git diff --cached -U0 src/a.ts',
    'git show HEAD:src/a.ts',
    'git show --stat --format= HEAD',
    'git status',
    'git status -sb',
    `git grep -n -e one -e 'two$' -- 'src/*.ts'`,
    "git log -- . ':^docs' ':!app/a.ts'",
    'git ls-files -o --exclude-standard',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --short HEAD',
    'git blame -L 1,1 src/a.ts',
    'rtk proxy git log --oneline',
    // Files.
    'cat src/a.ts app/a.ts',
    'cat -n ./src/a.ts',
    'head -20 src/a.ts',
    'head -n 20 src/a.ts',
    'tail -n +5 src/a.ts',
    'wc -l src/a.ts package.json',
    'ls',
    'ls -la src app',
    'grep -c "a|b" src/a.ts',
    'grep -rn export src app',
    `grep -rn --include='*.ts' -- x src`,
    'grep -n export src/a.ts -i -C2',
    "grep -n '=ls' src/a.ts",
    'rtk grep -ln export src',
    'rtk proxy grep -l export src/a.ts',
    'find . -name "*.ts" -type f',
    `find src app -maxdepth 2 '!' -name 'a*' -print`,
    'rtk ls src',
    'rtk find src -name a.ts',
    `cat ${join(work, 'src', 'a.ts')}`,
    `cat ${msg}`,
    `ls ${scratch}`,
    'cat src/gone.ts',
    // Joined, and what only quotes hold.
    'git status --short && git diff | head -50',
    'git log 2>&1 | tail -3',
    'git show HEAD 2>/dev/null;cat src/a.ts',
    'cat src/a.ts|grep -n export|wc -l',
    'git log | grep fix | sed -n 1,5p',
    `grep -n "a && b; rm -rf c | d > e" src/a.ts`,
    `grep -n 'x $HOME \`pwd\` $(ls) *' src/a.ts`,
    `git log --grep='rm -rf'`,
    `gr"ep" -n ''export src/a.ts`,
    'sed -n 3p src/a.ts',
  ]) {
    expect([command, kind(command)]).toEqual([command, 'read'])
  }

  for (const command of [
    'git add src/a.ts app',
    'git add -- src/a.ts',
    'git commit -m "msg"',
    `git commit -q -m 'fix: a' -m "- b; rm -rf c\n- \\"d\\""`,
    `git commit -qF ${msg}`,
    `rtk proxy git commit -F ${msg}`,
    'rtk git add src && rtk git commit -q -m x && git log -1',
    'bun test',
    'bun test src/worker.test.ts -t "held back|rests|an hour of ticks"',
    'bun test --timeout 20000 src',
    'rtk bun test 2>&1 | tail -5',
    'bun run typecheck 2>&1 | tail -5',
    'bun run test',
    'bun run lint && bun run check',
  ]) {
    expect([command, kind(command)]).toEqual([command, 'work'])
  }
  // After a `cd`, paths are the shell's; the scripts are the package's above.
  expect(kind('cat a.ts', join(work, 'src'))).toBe('read')
  expect(kind('bun run test', join(work, 'src'))).toBe('work')
  // Through a link that stays in the worktree.
  symlinkSync('src', join(work, 'also'))
  expect(kind('cat also/a.ts')).toBe('read')
  // With no repo there is no git to read; the files are the task's.
  const bare = tmp.make('nod-allow-bare-')
  const alone = { workspace: bare, repo: null, branch: null }
  expect(routine('cat a.txt', bare, alone)).toBe('read')
  expect(routine('git log', bare, alone)).toBeNull()
  expect(routine('git add a.txt', bare, alone)).toBeNull()
  expect(routine('bun run test', bare, alone)).toBeNull()
  // A session with no scratchpad.
  expect(routine(`cat ${msg}`, work, task)).toBeNull()
  // A folder that is gone.
  expect(kind('cat a.ts', join(work, 'gone'))).toBeNull()
})

test('no routine command deletes or overwrites: rm in any command of a joined one or with quotes, find and git that delete, mv, cp and redirections stay prompts', () => {
  const { work, scratch, task } = places()
  writeFileSync(join(work, 'dist', 'a.js'), 'a\n')
  for (const command of [
    // What nod allows of rm is a plain command of its own, as before.
    'rm -rf dist; git status',
    'git status; rm -rf dist',
    'git status;rm -rf dist',
    'git status && rm -rf dist',
    'rm -rf dist && rm -rf node_modules',
    'cat src/a.ts | rm -rf dist',
    'rm -rf dist 2>/dev/null',
    'rm -rf "dist"',
    "rm -rf 'dist'",
    "'rm' -rf dist",
    'r"m" -rf dist',
    'rtk rm -rf dist',
    'rtk proxy rm -rf dist',
    'rmdir dist',
    'unlink dist/a.js',
    'bun install && bun test',
    'find . -delete',
    'find dist -name a.js -delete',
    `find dist -exec rm {} ';'`,
    `find dist -type f -exec rm -f '{}' '+'`,
    `find dist -execdir rm a.js ';'`,
    `find dist -ok rm a.js ';'`,
    `find dist -okdir rm a.js ';'`,
    'find dist -fprint src/a.ts',
    'find dist -fprint0 src/a.ts',
    'find dist -fprintf src/a.ts x',
    'find dist -fls src/a.ts',
    'rtk find dist -delete',
    'git clean -fd',
    'git rm src/a.ts',
    'git rm --cached src/a.ts',
    'git mv src/a.ts src/b.ts',
    'git checkout -- src/a.ts',
    'git checkout main',
    'git switch main',
    'git restore src/a.ts',
    'git reset --hard',
    'git reset',
    'git stash',
    'git stash drop',
    'git stash list',
    'git branch -D feat/y',
    'git tag -d v1',
    'git update-ref -d refs/heads/feat/y',
    'git worktree remove x',
    'git revert HEAD',
    'git merge main',
    'git rebase main',
    'git push',
    'git fetch',
    'git config core.pager x',
    'mv src/a.ts src/b.ts',
    'cp src/a.ts app/a.ts',
    'ln -sf a b',
    'touch src/a.ts',
    'tee src/a.ts',
    'cat app/a.ts | tee src/a.ts',
    'truncate -s 0 src/a.ts',
    'dd if=app/a.ts of=src/a.ts',
    'cat app/a.ts > src/a.ts',
    'cat app/a.ts >src/a.ts',
    'cat app/a.ts >> src/a.ts',
    'cat app/a.ts 2> src/a.ts',
    'cat app/a.ts 1>src/a.ts',
    'cat app/a.ts &> src/a.ts',
    'cat app/a.ts >| src/a.ts',
    'git log --output=src/a.ts',
    'git diff --output src/a.ts',
    // rtk leaves the `--` out.
    'rtk git log -- --output=src/a.ts',
    'rtk git show -- --output=src/a.ts',
    'git diff -- --output=src/a.ts',
    'git log -S --output=src/a.ts',
    'sed -i 1,5p src/a.ts',
    'sed -n 1,5p src/a.ts -i',
    'sed -n 1,5p src/a.ts --in-place',
    "sed -n '1,5w src/a.ts' app/a.ts",
    "sed -n '1,5p;w src/a.ts' app/a.ts",
    'bun test -u',
    'bun test --update-snapshots',
  ]) {
    const allowed = harmless(command, work, work, true) || routine(command, work, task, scratch)
    expect([command, allowed]).toEqual([command, null])
  }
  // The one nod allowed before is as it was.
  expect(harmless('rm -rf dist', work, work, true)).toBe(true)
  expect(routine('rm -rf dist', work, task, scratch)).toBeNull()
})

test('what nod cannot read, or is no routine command, is none: other shell syntax, options that run, write or read elsewhere, commits and checks of another shape', () => {
  const { work, scratch, task } = places()
  const kind = (command: string) => routine(command, work, task, scratch)
  for (const command of [
    // Expansions, joins and redirections nod does not read.
    '',
    ' ',
    'git log $HOME',
    'git log $' + '{x}',
    'git log "$HOME"',
    'git log "\\$HOME"',
    'git log $(rm -rf dist)',
    'git log "$(rm -rf dist)"',
    'git log `rm -rf dist`',
    'git log "`rm -rf dist`"',
    'git log "a\\\\$(rm -rf dist)"',
    "git log $'a'",
    'cat src/*.ts',
    'cat src/a.t?',
    'cat src/[a].ts',
    'cat {src,app}/a.ts',
    'cat ~/a.ts',
    'git log HEAD~1',
    'git log HEAD^',
    'cat =ls',
    "cat ''=ls",
    'cat ""\'\'=ls',
    'cat src/a\\.ts',
    'git log \\\n-1',
    'cat < src/a.ts',
    'cat << EOF',
    'cat <<< x',
    'cat <(git log)',
    'git log &',
    'git log & git status',
    'git log || git status',
    'git log |& cat',
    'git log;; git status',
    'git log;',
    'git log &&',
    '; git log',
    '| cat',
    'git log | | cat',
    'git log\ngit push',
    'git log\n',
    'git log\r',
    'git log\tsrc',
    'git log "a\tb"',
    '(git log)',
    '{ git log; }',
    'git log # x',
    '! git log',
    'git log "x',
    "git log 'x",
    'git log "a\n"\ngit push',
    "git log 'a'\n'b'",
    'git log 2>&1x',
    'git log 2>&2',
    'git log 2>/dev/nullx',
    'git log 2>/dev/null/../x',
    'git log 2>&1>x',
    'FOO=1 bun test',
    'GIT_EXTERNAL_DIFF=x git diff',
    'env bun test',
    'time git log',
    'command git log',
    'exec git log',
    'eval git log',
    'noglob cat a',
    'xargs cat',
    'sudo cat src/a.ts',
    'sh -c "git log"',
    // git run elsewhere, or with a program, a file or a folder an option names.
    'git',
    'git -C app log',
    'git --git-dir=x log',
    'git --git-dir x log',
    'git --work-tree=x status',
    'git -c core.pager=x log',
    'git --exec-path=x log',
    'git --config-env=core.pager=X log',
    'git -p log',
    'git --paginate log',
    'rtk git -C app log',
    'rtk proxy git -c diff.external=x diff',
    'git log --outp=x',
    'git diff -Oorder',
    'git diff -O order',
    'git grep -Oless x',
    'git grep -O x',
    'git grep -nO x',
    'git grep --open-files-in-pager x',
    'git grep --open=less x',
    'git diff --ext-diff',
    'git log -p --ext-diff',
    'git log -p --textconv',
    'git diff --textc',
    'git log --show-signature',
    "git log --format='%h %G?'",
    'git log --pretty=format:%GS',
    "git log --format='%h%+G?'",
    "git show --format='% GK'",
    'git diff --no-index a b',
    'git grep --no-index x',
    'git grep --untracked x',
    'git grep -f pats',
    'git grep -fpats',
    'git blame --contents x src/a.ts',
    'git ls-files -X x',
    'git ls-files --exclude-from=x',
    'git rev-parse --git-dir',
    'git rev-parse --parseopt',
    'git log --stdin',
    "git log -- ':(top)src'",
    'git show :/fix',
    "git ls-files '*'",
    "git grep x -- 'src/[a].ts'",
    'git remote -v',
    'git ls-remote',
    'git cat-file -p HEAD',
    'git archive HEAD',
    'git bisect run x',
    // A commit of another shape, and what hooks or the last commit it passes by.
    'git commit',
    'git commit -a -m x',
    'git commit -am x',
    'git commit --amend',
    'git commit --amend -m x',
    'git commit -m x --amend',
    'git commit -m x --no-verify',
    'git commit --no-veri -m x',
    'git commit -n -m x',
    'git commit -nm x',
    'git commit -qnm x',
    'git commit -m',
    'git commit -q',
    'git commit -m x -- src/a.ts',
    'git commit -m x src/a.ts',
    'git commit -F -',
    'git commit -F /etc/hosts',
    'git commit -C HEAD',
    'git commit --fixup HEAD',
    'git commit -S -m x',
    'git commit -m x -e',
    'git add',
    'git add -A',
    'git add -u',
    'git add -f dist',
    'git add -- -A',
    'rtk git add -- -f',
    'git add -p src/a.ts',
    'git add --chmod=+x src/a.ts',
    "git add '*.ts'",
    "git add ':/src'",
    `git add ${scratch}/commit-msg.txt`,
    'git add shared/config',
    // A check of another shape.
    'bun',
    'bun run build',
    'bun run',
    'bun run test src',
    'bun run test --watch',
    'bun run test:e2e',
    'bun run ./evil.ts',
    'bun evil.ts',
    'bun -e 1',
    'bun x biome',
    'bunx biome check',
    'bun --cwd=app test',
    'bun --preload x test',
    'bun test --preload ./x.ts',
    'bun test /tmp/x.test.ts',
    'bun test ../x.test.ts',
    'npm test',
    'rtk test ls',
    // Reading of another shape.
    'sed 1,5p src/a.ts',
    'sed -n /x/p src/a.ts',
    "sed -n '1e ls' src/a.ts",
    "sed -n '1,5p;6,9p' src/a.ts",
    "sed -n '$p' src/a.ts",
    'sed -n -f x src/a.ts',
    'sed -ne 1,5p src/a.ts',
    'tail -f src/a.ts',
    'tail --follow src/a.ts',
    'wc --files0-from=x',
    'ls -L src',
    'grep -f pats src/a.ts',
    'grep -e -f src/a.ts',
    'grep -rn -- -f src',
    // BSD's, past the first path, take an option for a path.
    'cat src/a.ts -n',
    'head src/a.ts -5',
    'tail src/a.ts -n 5',
    'tail 5 -n 5',
    'wc src/a.ts -l',
    'ls src -la',
    'ls src -- app',
    'rtk cat src/a.ts -n',
    'cat -- -n',
    // rtk's own -l takes a number.
    'rtk grep -l 5 -r TOKEN',
    'rtk grep -l +5 -r TOKEN',
    'rtk grep -n -l 5 TOKEN',
    'grep -R x src',
    'grep -S x src',
    'grep --file=x src/a.ts',
    'grep -nf pats src/a.ts',
    'grep --pre=x y src',
    'grep -rd recurse x src',
    'find -L . -name x',
    'find . -follow',
    'find . -newer x',
    'find . -files0-from x',
    'less src/a.ts',
    'awk 1 src/a.ts',
    'env',
    'rtk',
    'rtk proxy',
    'rtk env',
    'rtk -v git log',
    'rtk rtk git log',
    'rtk proxy rtk git log',
    'rtk proxy read src/a.ts',
    'read src/a.ts',
    'rtk read src/a.ts --write',
  ]) {
    expect([command, kind(command)]).toEqual([command, null])
  }
})

test('a routine command reaches only the task’s folder and the scratchpad, by real paths, and no secret’s name', () => {
  const { repo, work, outside, scratch, task } = places()
  const kind = (command: string, cwd = work) => routine(command, cwd, task, scratch)
  const none = (command: string, cwd = work) =>
    expect([command, kind(command, cwd)]).toEqual([command, null])

  // Out of them, as typed, through links or by `..`, which may go through one.
  for (const path of [
    outside,
    join(outside, 'x', 'key.txt'),
    join(repo, 'src', 'a.ts'),
    join(repo, '.git', 'config'),
    '/etc/hosts',
    '/dev/stdin',
    '..',
    '../x',
    'src/../../x',
    'src/../app/a.ts',
    'out',
    'out/x/key.txt',
    'shared/config',
    'dangling',
    'dangling/x',
    '.git',
    '.GIT',
    '.git/config',
    `${scratch}/../x`,
    `${scratch}-2/x`,
    `${work}-2/x`,
  ]) {
    for (const command of ['cat', 'ls', 'find', 'grep x', 'git log --', 'rtk read', 'git add']) {
      none(`${command} ${path}`)
    }
    none(`sed -n 1,5p '${path}'`)
    none(`git commit -F ${path}`)
    none(`bun test ${path}`)
  }
  symlinkSync(join(outside, 'x'), join(scratch, 'out'))
  none(`cat ${scratch}/out/key.txt`)
  none(`git diff ${outside} src`)
  // What git diff takes for outside its worktree, it reads as files, tracked or not.
  for (const path of [
    scratch,
    join(work, 'app'),
    work.toUpperCase(),
    `/System/Volumes/Data${work}`,
  ]) {
    none(`git diff ${path} app`)
    none(`git diff -- app ${path}`)
    none(`git diff --stat app '${path}'`)
  }
  none("git diff src ':!o/../../x/key.txt'")
  none("git diff src ':^/../x'")
  none('cat src/a.ts out/x/key.txt')
  none('cat src/a.ts; cat out/x/key.txt')
  none('cat src/a.ts | grep -r x out')
  // From outside: the repo's own checkout, another folder.
  none('git log', repo)
  none('cat src/a.ts', repo)
  none('ls', outside)
  none('git log', scratch)
  // Where a secret may be.
  for (const name of [
    '.env',
    '.ENV',
    '.env.local',
    '.env.example',
    '.envrc',
    'prod.env',
    'a.pem',
    'a.KEY',
    'id_rsa',
    'id_ed25519.pub',
    'credentials',
    'credentials.json',
    'aws-credentials',
    '.npmrc',
    '.netrc',
    '.pgpass',
    '.ssh/config',
    '.aws/config',
    'prod.env.local',
    'env.production',
    'server.key.bak',
    'server.pem~',
    '.npmrc.bak',
    '.dev.vars',
    'auth.json',
  ]) {
    const path = join('app', name)
    for (const command of ['cat', 'ls', 'grep x', 'git log --', 'git add', 'rtk read', 'wc -l']) {
      none(`${command} ${path}`)
    }
    none(`cat ${join(work, path)}`)
    none(`cat ${join(scratch, name)}`)
    none(`git show HEAD:${path}`)
    none(`git show HEAD:${name}`)
    none(`git grep x -- ${path}`)
    none(`head -5 '${path}'`)
  }
  none("git grep x -- '*.pem'")
  none("git grep x -- '*.npmrc'")
  none("git grep x -- 'app/*.env.local'")
  none("git grep x -- '.e*.local'")
  none("git grep x -- '.en*'")
  none(String.raw`git grep x -- '\.env'`)
  none("git grep x -- ':(icase).ENV'")
  // By another name, or in a folder read whole.
  for (const command of [
    'grep -rn x .',
    'grep -rn x app',
    'rtk grep x',
    'grep -r x',
    'git add app',
  ]) {
    expect([command, kind(command)]).toEqual([command, command === 'git add app' ? 'work' : 'read'])
  }
  writeFileSync(join(work, 'app', '.env'), 'TOKEN=1\n')
  symlinkSync('app/.env', join(work, 'notes'))
  none('cat notes')
  symlinkSync('../src/a.ts', join(work, 'app', '.netrc'))
  none('cat app/.netrc')
  none(`cat ${join(work, 'app', '.netrc')}`)
  for (const command of [
    'grep -rn x .',
    'grep -rn x app',
    'rtk grep x',
    'grep -r x',
    'git add app',
  ]) {
    none(command)
  }
  none('cat src/a.ts | grep -r x')
  none('cat src/a.ts | rtk grep x')
  expect(kind('cat src/a.ts | grep x')).toBe('read')
  expect(kind('grep -rn x src')).toBe('read')
  // A git folder in it, and more files than nod looks through.
  mkdirSync(join(work, 'src', 'in', '.git'), { recursive: true })
  none('grep -rn x src')
  expect(kind('grep -n x src/a.ts')).toBe('read')
  rmSync(join(work, 'src', 'in'), { recursive: true })
  LIMITS.files = 0
  try {
    none('grep -rn x src')
    expect(kind('grep -n x src/a.ts')).toBe('read')
  } finally {
    LIMITS.files = 20_000
  }
  // The scripts of a package outside.
  expect(kind('bun run test')).toBe('work')
  rmSync(join(work, 'package.json'))
  symlinkSync(join(outside, 'x', 'key.txt'), join(work, 'package.json'))
  none('bun run test')
  // Beside what is read, its name only.
  expect(kind('ls app')).toBe('read')
})

test('git is read only in the task’s own worktree, and a commit is one of its own only there, on its branch', () => {
  const { repo, work, outside, scratch, task } = places()
  const kind = (command: string, cwd = work) => routine(command, cwd, task, scratch)
  expect(kind('git commit -m x')).toBe('work')
  expect(kind('git commit -m x', join(work, 'src'))).toBe('work')
  expect(kind('git log', join(work, 'src'))).toBe('read')
  // Another repo inside it: its own, one that a link or a file leads to, and by its setting the
  // task's folder or one outside.
  const other = join(outside, 'other')
  const inner = (name: string) => {
    mkdirSync(join(work, name))
    return join(work, name)
  }
  const start = (cwd: string) => {
    git(cwd, 'init', '-q', '-b', 'feat/x')
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  mkdirSync(other)
  start(other)
  const nested = inner('nested')
  start(nested)
  const linked = inner('linked')
  symlinkSync(join(other, '.git'), join(linked, '.git'))
  const pointed = inner('pointed')
  writeFileSync(join(pointed, '.git'), `gitdir: ${join(other, '.git')}\n`)
  const out = inner('set-out')
  start(out)
  git(out, 'config', 'core.worktree', outside)
  const back = inner('set-back')
  start(back)
  git(back, 'config', 'core.worktree', work)
  for (const cwd of [nested, linked, pointed, out, back]) {
    for (const command of [
      'git commit -m x',
      'git add a',
      'git log',
      'git show HEAD:x',
      'git grep x',
    ]) {
      expect([cwd, command, kind(command, cwd)]).toEqual([cwd, command, null])
    }
    expect(kind('ls', cwd)).toBe('read')
  }
  // No repo to compare with, or another task's.
  expect(routine('git log', work, { ...task, repo: null }, scratch)).toBeNull()
  expect(routine('git log', work, { ...task, repo: join(repo, 'gone') }, scratch)).toBeNull()
  expect(routine('git log', work, { ...task, repo: other }, scratch)).toBeNull()
  // No branch, and another one.
  git(work, 'checkout', '-q', '--detach')
  expect(kind('git commit -m x')).toBeNull()
  expect(kind('git add src')).toBeNull()
  git(work, 'checkout', '-q', '-b', 'feat/y')
  expect(kind('git commit -m x')).toBeNull()
  expect(kind('git add src && git status')).toBeNull()
  expect(kind('git log && git status')).toBe('read')
  // A folder git tracks files in, now a link out, past which git grep reads.
  expect(kind('git grep x')).toBe('read')
  rmSync(join(work, 'src'), { recursive: true })
  symlinkSync(outside, join(work, 'src'))
  expect(kind('git grep x')).toBeNull()
  expect(kind("git grep x -- '*.ts'")).toBeNull()
  expect(kind('git diff')).toBe('read')
  // Another worktree of the repo's inside it, and its own set to another folder.
  git(work, 'worktree', 'add', '-q', '-b', 'feat/z', join(work, 'second'))
  expect(kind('git log', join(work, 'second'))).toBeNull()
  git(work, 'config', 'extensions.worktreeConfig', 'true')
  git(work, 'config', '--worktree', 'core.worktree', outside)
  expect(kind('git grep x')).toBeNull()
})

// The dialog as Claude Code draws it (2.1.331), under what the terminal showed before: `says`, why
// it shows; for auto mode's, the last call it blocked.
const UNCHECKED =
  'A call in this response changed (or may have changed) after auto mode reviewed it, so auto mode could not check what would run'
const blocked = (why = UNCHECKED, times = '3 consecutive actions were blocked.'): string =>
  `Auto mode needs your confirmation for this command.\n${times} Please review the transcript before continuing.\n\nLatest blocked action: ${why}`
function dialog(command: string, says = blocked(), width = 60): string {
  const boxed = (body: string): string[] =>
    body
      .split('\n')
      .flatMap((l) => l.match(new RegExp(`.{1,${width}}`, 'g')) ?? [''])
      .map((l) => ` │ ${l}`)
  return [
    `  Bash(${command})`,
    '  ⎿  Waiting…',
    '─'.repeat(width),
    ' Bash command',
    ' Show it',
    '╌'.repeat(width),
    ...boxed(command),
    '╌'.repeat(width),
    ...boxed(says),
    ' ⚠ Claude Code will automatically block this request in 1:53, to avoid holding up an unattended session',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n')
}

// A prompt of auto mode's in a running task's session: its transcript, kept as Claude Code keeps it,
// and its scratchpad.
function asking() {
  const task = running()
  const config = tmp.make('nod-allow-transcripts-')
  const transcript = join(config, 's1.jsonl')
  const scratch = join(tmp.make('nod-allow-session-'), 'scratchpad')
  mkdirSync(scratch)
  const row = (content: string, more: object = {}) =>
    `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content }],
      },
      ...more,
    })}\n`
  writeFileSync(
    transcript,
    row(
      `The server-side auto mode classifier gave no verdict for Bash: a hook changed this call's input`,
    ),
  )
  const event = (command: string, extra: Record<string, unknown> = {}) => ({
    ...task.event(command),
    permission_mode: 'auto',
    transcript_path: transcript,
    scratchpad_dir: scratch,
    ...extra,
  })
  return { ...task, config, transcript, scratch, row, event }
}

test('a routine command is allowed as auto mode had nothing to judge: a read goes into the ledger only, a commit or a check to the session too', async () => {
  const { ledger, todos, project, id, attemptId, event } = asking()
  todos.addSession(project.id, 'root-1', '/work/one')
  todos.setSocket('root-1', '/socks/root-1')
  const allows = (command: string) =>
    onPermissionRequest(ledger, event(command), () => dialog(command))

  expect(allows('rtk git status --short')).toBe(true)
  expect(allows(`sed -n '1,60p' src/a.ts; rtk grep -n "open" src/a.ts | head`)).toBe(true)
  expect(allows('git commit -q -m "fix: a\n\n- b"')).toBe(true)
  expect(allows('bun run typecheck 2>&1 | tail -5')).toBe(true)
  expect(ledger.allowed(id).map((n) => [n.attemptId, n.note])).toEqual([
    [attemptId, 'rtk git status --short'],
    [attemptId, `sed -n '1,60p' src/a.ts; rtk grep -n "open" src/a.ts | head`],
    [attemptId, 'git commit -q -m "fix: a\n\n- b"'],
    [attemptId, 'bun run typecheck 2>&1 | tail -5'],
  ])
  const sent: string[] = []
  await sendNotices(ledger, async (_, line) => {
    sent.push(JSON.parse(line).message.content)
  })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.split('\n\n').filter((l) => l.startsWith(`n${id} `))).toEqual([
    `n${id} 허락: git commit -q -m "fix: a  - b"`,
    `n${id} 허락: bun run typecheck 2>&1 | tail -5`,
  ])
  expect(ledger.decisions(id)).toEqual([])
})

test('a routine command is not allowed on a prompt with another reason: a rule of the repo’s, a denial of the check’s, another command’s dialog, none nod can see', () => {
  const { ledger, id, event } = asking()
  const command = 'git log -1'
  const allows = (screen: string, extra: Record<string, unknown> = {}) =>
    onPermissionRequest(ledger, event(command, extra), () => screen)

  for (const screen of [
    '',
    `  Bash(${command})\n  ⎿  Waiting…`,
    // A rule's, as Claude Code words it; a denial of the check's; too many of them in all.
    dialog(command, 'Rule Bash(git log*) from project settings overrides auto mode.'),
    dialog(command, 'Ask rule Bash(git log*) overrides auto mode for this command'),
    dialog(command, blocked('[Unauthorized Access]')),
    dialog(command, blocked(`[Unauthorized Access] ${UNCHECKED}`)),
    dialog(command, blocked(UNCHECKED, '20 actions were blocked this session.')),
    dialog(command, blocked().replace('Auto mode needs', 'A rule needs')),
    dialog(command, ''),
    // Another call's comes first, also one that ends as this.
    dialog('git push'),
    dialog(`rm -rf src; ${command}`),
    dialog(`${command} --all`),
    `${dialog('git push', blocked('[Unauthorized Access]'))}\n  Bash(${command})`,
    // The last one drawn is what shows.
    `${dialog(command)}\n${dialog(command, blocked('[Unauthorized Access]'))}`,
    `${dialog(command)}\n${dialog(command, 'Ask rule Bash(git log*) overrides auto mode for this command')}`,
    `${dialog(command)}\n${dialog('git push')}`,
  ]) {
    expect([screen, allows(screen)]).toEqual([screen, false])
  }
  // Not in auto mode, or with no transcript to read.
  for (const extra of [
    { permission_mode: 'default' },
    { permission_mode: undefined },
    { transcript_path: undefined },
    { transcript_path: '' },
    { transcript_path: '/nowhere/s1.jsonl' },
  ]) {
    expect([extra, allows(dialog(command), extra)]).toEqual([extra, false])
  }
  const unseen = () => {
    throw new Error('tmux capture-pane failed')
  }
  expect(onPermissionRequest(ledger, event(command), unseen)).toBe(false)
  // What may open the sandbox for it.
  for (const extra of [
    { dangerouslyDisableSandbox: true },
    { dangerouslyDisableSandbox: 'true' },
    { allowed_domains: ['example.com'] },
    { to_come: 1 },
  ]) {
    const input = { tool_input: { command, ...extra } }
    expect([extra, allows(dialog(command), input)]).toEqual([extra, false])
    const before = { tool_input: { command: 'rm -rf dist', ...extra } }
    expect(onPermissionRequest(ledger, event('', before), unseen)).toBe(false)
  }
  expect(ledger.allowed(id)).toEqual([])
  expect(allows(dialog(command))).toBe(true)
  // Drawn wider, narrower, for the fifteenth call in a row, under another.
  expect(allows(dialog(command, blocked(), 190))).toBe(true)
  expect(allows(dialog(command, blocked(), 7))).toBe(true)
  const fifteenth = blocked(UNCHECKED, '15 consecutive actions were blocked.')
  expect(allows(dialog(command, fifteenth))).toBe(true)
  for (const above of [
    dialog('git push', blocked('[Unauthorized Access]')),
    dialog(command, 'x'),
  ]) {
    expect(allows(`${above}\n${dialog(command)}`)).toBe(true)
  }
  // rm, as before, whatever put its prompt up.
  expect(
    onPermissionRequest(ledger, event('rm -rf dist', { permission_mode: 'default' }), unseen),
  ).toBe(true)
})

test('nod waits for the dialog of a routine command: until it is drawn, and while another call’s comes first', () => {
  const { ledger, event } = asking()
  const command = 'git log -1'
  const shown = ['', dialog('git status'), dialog(command)]
  LIMITS.dialogMs = 60_000
  try {
    expect(onPermissionRequest(ledger, event(command), () => shown.shift() ?? '')).toBe(true)
  } finally {
    LIMITS.dialogMs = 0
  }
  expect(shown).toEqual([])
  // Its own, whole, with another reason: there is nothing to wait for.
  const other = [dialog(command, 'Ask rule Bash(git log*) overrides auto mode for this command')]
  LIMITS.dialogMs = 60_000
  try {
    expect(onPermissionRequest(ledger, event(command), () => other.pop() ?? dialog(command))).toBe(
      false,
    )
  } finally {
    LIMITS.dialogMs = 0
  }
})

test('a session whose check denied a call, in any turn or subagent, keeps its routine commands prompts; no verdict, or the words elsewhere, does not', () => {
  const { ledger, config, transcript, row, event } = asking()
  const command = 'git log -1'
  const allows = (extra: Record<string, unknown> = {}) =>
    onPermissionRequest(ledger, event(command, extra), () => dialog(command))
  const DENIAL =
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Unauthorized Access]. If you have other tasks'
  const decision = (reasonCode: string, decision = 'reject') => ({
    permissionDecision: { decision, source: 'config', reasonType: 'classifier', reasonCode },
  })
  const said = (text: string) =>
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
  const start = readFileSync(transcript, 'utf8')

  // Not denied: no verdict, in its words and marks; the words in a file it read or a message; a
  // prompt of auto mode's the person allowed; another refusal.
  const fine = [
    row(
      'The server-side auto mode classifier gave no verdict for Bash: another call in this response was changed',
      decision('classifier:auto-mode:unavailable'),
    ),
    row(`docs/design.md:1: ${DENIAL}`),
    said(DENIAL),
    row('ok', decision('classifier:auto-mode', 'accept')),
    row("The user doesn't want to proceed with this tool use."),
    row('Permission to use Bash with command x has been denied.'),
    row(DENIAL).replace('"is_error":true', '"is_error":false'),
  ].join('')
  writeFileSync(transcript, start + fine)
  expect(allows()).toBe(true)

  for (const denied of [
    row(DENIAL, decision('classifier:auto-mode')),
    row(DENIAL),
    row('Permission for this action has been denied. Reason: [Destructive]'),
    // In words to come, by its mark.
    row('Auto mode says no.', decision('classifier:auto-mode')),
    // Cut short, as it is being written.
    row(DENIAL).slice(0, -20),
    // Turns ago.
    row(DENIAL) + said('go on') + fine,
  ]) {
    writeFileSync(transcript, start + denied)
    expect([denied, allows()]).toEqual([denied, false])
  }

  // A subagent's prompt is judged the same, with its own transcript there to read.
  writeFileSync(transcript, start)
  expect(allows({ agent_id: 'a1' })).toBe(false)
  const agents = join(config, 's1', 'subagents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'agent-a1.jsonl'), fine)
  expect(allows({ agent_id: 'a1' })).toBe(true)
  expect(allows({ agent_id: 'a2' })).toBe(false)
  expect(allows()).toBe(true)
  writeFileSync(join(agents, 'agent-a2.jsonl'), row(DENIAL))
  expect(allows({ agent_id: 'a1' })).toBe(false)
  expect(allows({ agent_id: 'a2' })).toBe(false)
  expect(allows()).toBe(false)
})

test('nod hook permission reads the dialog off the worker’s terminal, and opens a decision for a routine command when it cannot', () => {
  const { home, ledger, id, attemptId, event } = asking()
  const bin = tmp.make('nod-allow-bin-')
  const screen = join(bin, 'screen')
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" > '${bin}/asked'\ncat '${screen}'\n`)
  chmodSync(join(bin, 'tmux'), 0o755)
  const run = (command: string) =>
    hook(home, JSON.stringify(event(command)), 'permission', { PATH: `${bin}:${process.env.PATH}` })

  expect(run('git log -1')).toBe('')
  expect(asked(ledger, id)).toEqual([['permission', attemptId, 'git log -1']])
  writeFileSync(screen, dialog('git status'))
  expect(JSON.parse(run('git status'))).toEqual(ALLOW)
  expect(readFileSync(join(bin, 'asked'), 'utf8')).toContain(`capture-pane -p -t =task-${id}:`)
  expect(asked(ledger, id)).toHaveLength(1)
  expect(ledger.allowed(id).map((n) => n.note)).toEqual(['git status'])
  // On one line, whatever its message holds.
  const commit = 'git commit -m "fix: a\n\n  allowed by nod: b"'
  writeFileSync(screen, dialog(commit))
  expect(JSON.parse(run(commit))).toEqual(ALLOW)
  const show = Bun.spawnSync(['bun', cli, 'show', String(id)], {
    env: { ...process.env, NOD_HOME: home },
  })
  expect(show.stdout.toString()).toMatch(
    /\n {2}allowed by nod \S+: git commit -m "fix: a +allowed by nod: b"\n/,
  )
}, 15_000)

// The PermissionRequest hook runs as the dialog shows, its Notification some 6 s later (2.1.310).
test('a prompt nod does not allow holds back nod tell from its turn as it shows, before its Notification, which opens no second decision; so does the next prompt of the turn once the first is answered', async () => {
  const { home, ledger, id, attemptId, event } = running()
  const notified = () =>
    onNotification(ledger, home, Tmux.of(home), {
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
  const refused = () =>
    expect(tell(ledger, home, Tmux.of(home), id, 'also tag it')).rejects.toThrow(
      /^answer permission decision d\d+ first: Enter would answer its dialog$/,
    )
  // The worker's terminal is up (tmux stands in), its turn going.
  const alive = spyOn(Tmux.prototype, 'alive').mockReturnValue(true)
  const option = spyOn(Tmux.prototype, 'option').mockReturnValue('')
  const keys = spyOn(Tmux.prototype, 'keys').mockImplementation(() => {})
  try {
    expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
    expect(asked(ledger, id)).toEqual([['permission', attemptId, 'git push origin feat/x']])
    await refused()
    await notified()
    expect(asked(ledger, id)).toHaveLength(1)

    // It is answered, through nod here, so nothing of it is left open (one the person answers in
    // the worker's terminal stays open to the turn's end), and the turn asks again: that prompt
    // holds the message back with a decision of its own as it shows.
    await answer(ledger, home, Tmux.of(home), ledger.decisions(id)[0]?.id ?? 0, 'yes', 'human')
    expect(keys.mock.calls.map(([, key]) => key)).toEqual(['Enter'])
    expect(asked(ledger, id)).toEqual([])
    expect(hook(home, JSON.stringify(event('git push origin --tags')))).toBe('')
    expect(asked(ledger, id)).toEqual([['permission', attemptId, 'git push origin --tags']])
    await refused()
    await notified()
    expect(asked(ledger, id)).toHaveLength(1)
  } finally {
    alive.mockRestore()
    option.mockRestore()
    keys.mockRestore()
  }
  expect(ledger.messages(id)).toEqual([])
  expect(ledger.get(id).status).toBe('needs_decision')
}, 15_000)

test("a question a person's nod tell goes on past goes to the project's session with their words, but not when its latest session, a worker or nod sent it", async () => {
  const { home, ledger, todos, project, id, attemptId } = running()
  todos.addSession(project.id, 'root-0', '/work/zero')
  todos.addSession(project.id, 'root-1', '/work/one')
  // The worker asks as each turn ends.
  const question = (turn: number): number => {
    ledger.endAttempt(turn, { outcome: 'needs_decision', summary: 'which?', report: 'which?' })
    return ledger.ask(id, turn, 'question', 'Which branch?')
  }
  const terminal = takingMessages()
  const attached = spyOn(Tmux.prototype, 'attached').mockReturnValue(false)
  const told: number[] = []
  try {
    // From a shell or the web UI, the project's older session, its latest, a worker, and nod (a
    // watch that passed, which names no one).
    const from: [string, (text: string) => Promise<void>][] = [
      ['shell', (text) => tell(ledger, home, Tmux.of(home), id, text, null)],
      ['root-0', (text) => tell(ledger, home, Tmux.of(home), id, text, 'root-0')],
      ['root-1', (text) => tell(ledger, home, Tmux.of(home), id, text, 'root-1')],
      ['worker', (text) => tell(ledger, home, Tmux.of(home), id, text, NO_PERSON)],
      ['nod', (text) => tell(ledger, home, Tmux.of(home), id, text)],
    ]
    for (const [who, send] of from) {
      const d = question(ledger.openAttempt(id)?.id ?? attemptId)
      told.push(d)
      await send(`use main (${who})`)
      expect(ledger.decision(d).answer).toBe('(it went on without an answer)')
    }
  } finally {
    terminal.restore()
    attached.mockRestore()
  }
  const [shell = 0, older = 0] = told
  expect(answeredNotices(ledger)).toEqual([shell, older])
  todos.setSocket('root-1', '/socks/root-1')
  const sent: string[] = []
  await sendNotices(ledger, async (_, line) => {
    sent.push((JSON.parse(line) as { message: { content: string } }).message.content)
  })
  const lines = (sent[0] ?? '').split('\n\n').filter((l) => l.includes('answered by'))
  expect(lines.map((l) => l.split('\n')[0])).toEqual([
    `decision d${shell} question answered by the person (task n1 t1): (told the worker) use main (shell)`,
    `decision d${older} question answered by the person (task n1 t1): (told the worker) use main (root-0)`,
  ])
}, 15_000)

test("a prompt's decision whose turn the person stopped with Escape closes as the next message goes in; while the turn goes on, it holds the message back", async () => {
  const { home, ledger, id, attemptId, event } = running()
  // Claude Code keeps the session's transcript in the account the worker runs as.
  const config = tmp.make('nod-allow-claude-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  ledger.setAccount(id, config)
  const transcript = (...entries: object[]) =>
    writeFileSync(
      join(config, 'projects', 'work', 's1.jsonl'),
      entries.map((e) => `${JSON.stringify(e)}\n`).join(''),
    )
  const asking = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  }
  const stop = { type: 'text', text: '[Request interrupted by user for tool use]' }
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  const terminal = takingMessages()
  try {
    transcript(asking)
    await expect(tell(ledger, home, Tmux.of(home), id, 'push to the fork')).rejects.toThrow(
      /^answer permission/,
    )
    // Escape on the dialog ends the turn with no Stop (2.1.290).
    transcript(asking, { type: 'user', message: { role: 'user', content: [stop] } })
    await tell(ledger, home, Tmux.of(home), id, 'push to the fork')
    expect(terminal.send.mock.calls.map(([, text]) => text)).toEqual(['push to the fork'])
  } finally {
    terminal.restore()
  }
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['permission', '(the person stopped its turn)'],
  ])
  expect(ledger.messages(id).map((m) => [m.attemptId, m.text])).toEqual([
    [attemptId, 'push to the fork'],
  ])
  expect(ledger.get(id).status).toBe('running')
}, 15_000)

test("a prompt's decision whose turn the person stopped with Escape closes as they type the next message into its terminal: nod's messages follow theirs into the turn", async () => {
  const { home, ledger, id, attemptId, event } = running()
  const config = tmp.make('nod-allow-claude-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  ledger.setAccount(id, config)
  const transcript = (...entries: object[]) =>
    writeFileSync(
      join(config, 'projects', 'work', 's1.jsonl'),
      entries.map((e) => `${JSON.stringify(e)}\n`).join(''),
    )
  const said = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })
  const stop = { type: 'text', text: '[Request interrupted by user for tool use]' }
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  // A person at the worker's terminal, which tmux stands in for.
  const terminal = takingMessages()
  const attached = spyOn(Tmux.prototype, 'attached').mockReturnValue(true)
  try {
    // They answer the dialog no with Escape, which ends the turn with no Stop (2.1.290), and type
    // what to do instead: the prompt hook runs before Claude Code keeps it.
    transcript(said([stop]))
    await onPrompt(ledger, home, Tmux.of(home), { session_id: 's1', prompt: 'push to the fork' })
    expect(ledger.get(id).status).toBe('running')
    transcript(said([stop]), said('push to the fork'))
    await tell(ledger, home, Tmux.of(home), id, 'and tag it')
    expect(terminal.send.mock.calls.map(([, text]) => text)).toEqual(['and tag it'])
    // The project's session hears they answered it, as it heard it open.
    expect(answeredNotices(ledger)).toEqual(ledger.decisions(id).map((d) => d.id))
  } finally {
    terminal.restore()
    attached.mockRestore()
  }
  expect(ledger.decisions(id).map((d) => [d.reason, d.answer])).toEqual([
    ['permission', '(the person stopped its turn)'],
  ])
  expect(ledger.messages(id).map((m) => [m.attemptId, m.text])).toEqual([
    [attemptId, '(typed into the terminal)\npush to the fork'],
    [attemptId, 'and tag it'],
  ])
  expect(ledger.get(id).status).toBe('running')
}, 15_000)

test('what a person types into a turn they stopped is kept even when closing its dialog’s decision fails', async () => {
  const { home, ledger, id, attemptId, event } = running()
  const config = tmp.make('nod-allow-claude-')
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  ledger.setAccount(id, config)
  const stop = { type: 'text', text: '[Request interrupted by user for tool use]' }
  writeFileSync(
    join(config, 'projects', 'work', 's1.jsonl'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [stop] } })}\n`,
  )
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  const attached = spyOn(Tmux.prototype, 'attached').mockReturnValue(true)
  const option = spyOn(Tmux.prototype, 'option').mockReturnValue('')
  // The ledger is busy as the decision closes.
  const dismiss = spyOn(Ledger.prototype, 'dismiss').mockImplementation(() => {
    throw new Error('database is locked')
  })
  try {
    await expect(
      onPrompt(ledger, home, Tmux.of(home), { session_id: 's1', prompt: 'push to the fork' }),
    ).rejects.toThrow('database is locked')
  } finally {
    attached.mockRestore()
    option.mockRestore()
    dismiss.mockRestore()
  }
  expect(ledger.messages(id).map((m) => [m.attemptId, m.text])).toEqual([
    [attemptId, '(typed into the terminal)\npush to the fork'],
  ])
  // The decision is left as it was, to close as before.
  expect(ledger.decisions(id).map((d) => d.answer)).toEqual([null])
}, 15_000)

test("a tool that ran closes its dialog's decision, as allowed in the terminal, and only its own; nod's answer to it after types nothing into the worker", async () => {
  const { home, ledger, id, event } = running()
  // Two pushes at once, each its dialog.
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(hook(home, JSON.stringify(event('git push origin --tags')))).toBe('')
  const [first = 0, second = 0] = ledger.decisions(id).map((d) => d.id)
  const open = () => ledger.decisions(id).map((d) => [d.id, d.answer])
  // The person picks Yes on the first in the terminal: it runs. The other's dialog still shows.
  expect(hook(home, JSON.stringify(event('git push origin feat/x')), 'tool')).toBe('')
  expect(open()).toEqual([
    [first, '(allowed in the terminal)'],
    [second, null],
  ])
  expect(ledger.get(id).status).toBe('needs_decision')
  // Then on the second, which runs and fails (PostToolUseFailure, the same hook).
  const failed = { ...event('git push origin --tags'), error: 'exit 1', is_interrupt: false }
  expect(hook(home, JSON.stringify(failed), 'tool')).toBe('')
  expect(open()).toEqual([
    [first, '(allowed in the terminal)'],
    [second, '(allowed in the terminal)'],
  ])
  expect(ledger.get(id).status).toBe('running')
  // The project's session hears the person answered each, in the terminal.
  expect(answeredNotices(ledger)).toEqual([first, second])
  // The root, a moment late, answers what it was shown: nothing reaches the worker, at work.
  const alive = spyOn(Tmux.prototype, 'alive').mockReturnValue(true)
  const keys = spyOn(Tmux.prototype, 'keys').mockImplementation(() => {})
  try {
    for (const [decision, reply] of [
      [first, 'no'],
      [second, 'yes'],
    ] as const) {
      await expect(answer(ledger, home, Tmux.of(home), decision, reply, 'human')).rejects.toThrow(
        /already answered/,
      )
    }
    expect(keys).not.toHaveBeenCalled()
  } finally {
    alive.mockRestore()
    keys.mockRestore()
  }
  expect(answeredNotices(ledger)).toEqual([first, second])
}, 15_000)

test("a tool that ran leaves a dialog's decision for the same command open when nod answered one like it in the turn: the run may be the one nod allowed", async () => {
  const { home, ledger, id, event } = running()
  // The same push twice at once, each its dialog.
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  const [first = 0, second = 0] = ledger.decisions(id).map((d) => d.id)
  const alive = spyOn(Tmux.prototype, 'alive').mockReturnValue(true)
  const option = spyOn(Tmux.prototype, 'option').mockReturnValue('')
  const keys = spyOn(Tmux.prototype, 'keys').mockImplementation(() => {})
  try {
    await answer(ledger, home, Tmux.of(home), first, 'yes', 'human')
    expect(keys.mock.calls.map(([, key]) => key)).toEqual(['Enter'])
  } finally {
    alive.mockRestore()
    option.mockRestore()
    keys.mockRestore()
  }
  // The push nod allowed runs. The second's dialog still shows, its decision holding nod tell back.
  expect(hook(home, JSON.stringify(event('git push origin feat/x')), 'tool')).toBe('')
  expect(ledger.decisions(id).map((d) => [d.id, d.answer])).toEqual([
    [first, 'yes'],
    [second, null],
  ])
}, 15_000)

test("no to one of the prompts tools that ran at once queued closes the others' decisions too: Escape ends the turn and every dialog of it", async () => {
  const { home, ledger, id, attemptId, event } = running()
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(hook(home, JSON.stringify(event('git push origin --tags')))).toBe('')
  const [first] = ledger.decisions(id)
  // Claude Code shows the turn stopped once Escape is in.
  const terminal = takingMessages('Interrupted')
  const attached = spyOn(Tmux.prototype, 'attached').mockReturnValue(false)
  const keys = spyOn(Tmux.prototype, 'keys').mockImplementation(() => {})
  try {
    await answer(ledger, home, Tmux.of(home), first?.id ?? 0, 'no, not yet', 'human')
    expect(keys.mock.calls.map(([, key]) => key)).toEqual(['Escape'])
    expect(terminal.send.mock.calls.map(([, text]) => text)).toEqual([
      'Human decision: permission denied. no, not yet',
    ])
  } finally {
    terminal.restore()
    attached.mockRestore()
    keys.mockRestore()
  }
  expect(ledger.decisions(id).map((d) => [d.attemptId, d.answer])).toEqual([
    [attemptId, 'no, not yet'],
    [attemptId, '(its turn ended)'],
  ])
  expect(ledger.get(id).status).toBe('running')
}, 15_000)

test('the decision goes in before what the turn closed as it opened is told, which may take a while', () => {
  const { home, ledger, id, attemptId, event } = running()
  // The worker asked as its turn ended, and the person typed into its terminal: this prompt's
  // turn is theirs, which closes the question as it opens.
  ledger.endAttempt(attemptId, { outcome: 'needs_decision', summary: 'which?', report: 'which?' })
  ledger.ask(id, attemptId, 'question', 'which?')
  const heard = join(home, 'heard')
  writeFileSync(join(home, 'notify'), `#!/bin/sh\ncat >> '${heard}'\necho >> '${heard}'\n`)
  chmodSync(join(home, 'notify'), 0o755)
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  const told = readFileSync(heard, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(told.map((e) => [e.event, e.decision.reason])).toEqual([
    ['decision', 'permission'],
    ['answered', 'question'],
  ])
  expect(asked(ledger, id).map(([reason]) => reason)).toEqual(['permission'])
}, 15_000)

test('the worktree and the shell are compared by their real paths, so a link to the worktree is the worktree', () => {
  const { work } = worktree()
  const alias = join(tmp.make('nod-allow-alias-'), 'wt')
  symlinkSync(work, alias)
  expect(realpathSync(alias)).toBe(realpathSync(work))
  expect(harmless('rm -rf node_modules', alias, work, true)).toBe(true)
  expect(harmless('rm -rf node_modules', work, alias, true)).toBe(true)
  expect(harmless('rm -rf .', alias, work, true)).toBe(false)
})
