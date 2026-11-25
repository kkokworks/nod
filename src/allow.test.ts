import { afterAll, expect, setSystemTime, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { blocked, dialog, UNCHECKED } from '../test/dialog'
import { marking, workerSubmodules } from '../test/git-commands'
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { ALLOW, back, harmless, LIMITS, loses, onPermissionRequest } from './allow'
import { NO_PERSON } from './decisions'
import { WAIT } from './dialog'
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
WAIT.dialogMs = 0

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

test("nod's look at what rm -rf takes runs none of the commands named in the config of a submodule its worker made", () => {
  const { work } = worktree()
  const { command, ran } = marking(tmp.make('nod-allow-marks-'))
  workerSubmodules(work, command)

  expect(harmless('rm -rf a b', work, work, true)).toBe(false)
  expect(ran()).toEqual([])
}, 30_000)

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
  expect(allows(event('rm -rf node_modules'))).toBe(ALLOW)
  expect(ledger.allowed(id).map((n) => [n.attemptId, n.note])).toEqual([
    [attemptId, 'rm -rf node_modules'],
  ])
  // What stays a prompt leaves nothing: another tool (an MCP write), push, a session of no task,
  // a command that asks to leave the sandbox.
  const mcp = {
    ...event('rm -rf node_modules'),
    tool_name: 'mcp__chat__send_message',
  }
  expect(allows(mcp)).toBeNull()
  expect(allows(event('git push'))).toBeNull()
  expect(allows({ ...event('rm -rf dist'), session_id: 'other' })).toBeNull()
  const unsandboxed = event('rm -rf dist', { dangerouslyDisableSandbox: true })
  expect(allows(unsandboxed)).toBeNull()
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

  // One is a line, cut, whatever it holds.
  const long = `rm -rf a\n\n  b ${'c'.repeat(400)}`
  ledger.addNotice({ taskId: id, attemptId, event: 'allowed', note: long })
  await sendNotices(ledger, async (socket, line) => {
    sent.push({ socket, content: JSON.parse(line).message.content })
  })
  const line = sent[1]?.content.split('\n\n')[1] ?? ''
  expect(line).toStartWith(`n${id} 허락: rm -rf a`)
  expect(line).toContain(' b ccc')
  expect(line.length).toBeLessThan(320)
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

// A prompt of auto mode's in a running task's session: its transcript, kept as Claude Code keeps it.
function asking() {
  const task = running()
  const config = tmp.make('nod-allow-transcripts-')
  const transcript = join(config, 's1.jsonl')
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
    ...extra,
  })
  return { ...task, config, transcript, row, event }
}

test('a call auto mode had nothing to judge goes back, whatever it runs: nothing is allowed, and nobody is told or asked', async () => {
  const { ledger, todos, project, id, attemptId, event } = asking()
  todos.addSession(project.id, 'root-1', '/work/one')
  todos.setSocket('root-1', '/socks/root-1')
  const commands = [
    'rtk git status --short',
    'TZ=UTC bun test src/a.test.ts',
    'git commit --amend -q -m "fix: a\n\n- \\`b\\`"',
    'cat src/a.ts | sh',
    'git push origin feat/x',
  ]
  for (const command of commands) {
    const answer = onPermissionRequest(ledger, event(command), () => dialog(command))
    expect(answer).toEqual(back(command))
  }
  // One that asks for a host goes back too: nothing is opened for it.
  const input = { tool_input: { command: 'curl example.com', allowed_domains: ['example.com'] } }
  const asks = onPermissionRequest(ledger, event('', input), () => dialog('curl example.com'))
  expect(asks).toEqual(back('curl example.com'))
  expect(ledger.sentBack(id).map((n) => [n.attemptId, n.note])).toEqual(
    [...commands, 'curl example.com'].map((command) => [attemptId, command]),
  )
  expect(ledger.allowed(id)).toEqual([])
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.get(id).status).toBe('running')
  const sent: string[] = []
  await sendNotices(ledger, async (_, line) => {
    sent.push(line)
  })
  expect(sent).toEqual([])
  expect(ledger.unsentNotices()).toEqual([])
})

test('what goes back tells the worker to send it alone, in the form the hook left it in, and does not end its turn', () => {
  const { decision } = back('rtk git log -1').hookSpecificOutput
  expect(Object.keys(decision)).toEqual(['behavior', 'message'])
  expect(decision.behavior).toBe('deny')
  expect(decision.message).toContain('Send it again as the only tool call of a response')
  expect(decision.message).toContain('in the form the hook leaves it, here:\nrtk git log -1\n')
  // A long one is not said over.
  const long = back(`echo ${'x'.repeat(500)}`).hookSpecificOutput.decision.message
  expect(long).toContain('in the form the hook leaves it.\n')
  expect(long).not.toContain('xx')
})

test('a command goes back once in a task, so it never goes round; and no more than so many of them in so long', () => {
  const { ledger, id, attemptId, work, event } = asking()
  const asks = (command: string, extra: Record<string, unknown> = {}) =>
    onPermissionRequest(ledger, event(command, extra), () => dialog(command))
  const turn = (taskId: number, sessionId: string) =>
    ledger.startAttempt({ taskId, kind: 'start', decisionId: null, sessionId, prompt: '' })
  expect(asks('git log -1')).toEqual(back('git log -1'))
  // The person's at once: there is no dialog to wait for.
  let reads = 0
  const again = () =>
    onPermissionRequest(ledger, event('git log -1'), () => {
      reads += 1
      return dialog('git log -1')
    })
  expect([1, 2, 3].map(again)).toEqual([null, null, null])
  expect(reads).toBe(0)
  expect(asks('git log -2')).toEqual(back('git log -2'))
  // In a later turn too; for another worker's nothing of this counts.
  ledger.endAttempt(attemptId, { outcome: 'succeeded', summary: '', report: '' })
  turn(id, 's1')
  expect(asks('git log -1')).toBeNull()
  const other = ledger.add(spec(null))
  ledger.setRunning(other, work)
  turn(other, 's2')
  expect(asks('git log -1', { session_id: 's2' })).toEqual(back('git log -1'))
  expect(asks('git log -1', { session_id: 's2' })).toBeNull()
  expect(ledger.sentBack(id).map((n) => n.note)).toEqual(['git log -1', 'git log -2'])

  // One whose command is another each time: the same loop, with nothing else to stop it.
  const { backs, backsMs } = LIMITS
  LIMITS.backs = 4
  try {
    expect([3, 4, 5, 6].map((n) => asks(`git log -${n}`) !== null)).toEqual([
      true,
      true,
      false,
      false,
    ])
    LIMITS.backsMs = 0
    expect(asks('git log -7')).toEqual(back('git log -7'))
  } finally {
    Object.assign(LIMITS, { backs, backsMs })
  }
})

test('of two calls of the same command that ask at once, one goes back', () => {
  const { home, ledger, id, event } = asking()
  const command = 'git log -1'
  // The other's hook, a process of its own, runs to its end while this one's reads the screen.
  const other: unknown[] = []
  const screen = (): string => {
    other.push(onPermissionRequest(new Ledger(home), event(command), () => dialog(command)))
    return dialog(command)
  }
  expect(onPermissionRequest(ledger, event(command), screen)).toBeNull()
  expect(other).toEqual([back(command)])
  expect(ledger.sentBack(id)).toHaveLength(1)
})

test('what loses files never goes back: its prompt is the person’s, but for the rm nod allows', () => {
  const { ledger, id, work, event, config } = asking()
  const agents = join(config, 's1', 'subagents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'agent-a1.jsonl'), '')
  writeFileSync(join(agents, 'agent-a1.meta.json'), '{"requestShape":"background"}')
  for (const command of [
    'rm -rf .git',
    'rm -rf "src"',
    'rm -r src',
    'rm src/a.ts',
    '/bin/rm -f src/a.ts',
    'rtk rm -rf src',
    'TZ=UTC rm -f src/a.ts',
    'cd src && rm -rf a.ts',
    'bash -c "rm -rf src"',
    'ls src | xargs rm',
    'find src -name "*.ts" -exec rm {} +',
    'find src -name "*.ts" -delete',
    'rsync -a --delete-after a/ b/',
    'shred -u src/a.ts',
    'unlink src/a.ts',
    'bunx rimraf src',
    'rsync -a --del a/ b/',
    `ruby -e "File.delete('src/a.ts')"`,
    `ruby -e "FileUtils.rm 'src/a.ts'"`,
    `bun -e "await Bun.file('src/a.ts').delete()"`,
    `deno eval "Deno.removeSync('src')"`,
    'git checkout -b x -f',
    'git checkout -b x --force',
    'git checkout -B x',
    'git --git-dir="a b/.git" reset --hard',
    "git --work-tree='a b' clean -fdx",
    'git -C $(git rev-parse --show-toplevel) reset --hard',
    'git "reset" --hard',
    'git read-tree --reset -u HEAD',
    'git checkout-index -f -a',
    'git push -d origin feat/y',
    'git push origin :feat/y',
    'git push --force origin feat/x',
    'git push --force-with-lease origin feat/x',
    'git push origin +feat/x',
    'git clean -fdx',
    'git \\\n  clean -fdx',
    'git -C src clean -fd',
    'git -C "a b" clean -fd',
    "git -C '/a b' reset --hard",
    'git -C a\\ b reset --hard',
    'git -c user.name="a b" reset --hard',
    'git --git-dir .git --work-tree "a b" reset --hard',
    'git --git-dir=.git reset --hard',
    'rtk git reset --hard',
    'git -c core.pager=cat --no-pager reset --hard HEAD~1',
    'git checkout -- src/a.ts',
    'git checkout .',
    'git checkout main',
    'git restore src/a.ts',
    'git rm -r src',
    'git stash drop',
    'git stash clear',
    'git branch -D feat/y',
    'git branch feat/y --delete',
    'git branch -f main HEAD~1',
    'git switch -f main',
    'git switch main --discard-changes',
    'git worktree remove x',
    'git reflog expire --all',
    'git update-ref -d refs/heads/feat/y',
    'git push origin --delete feat/y',
    `python3 -c "import shutil; shutil.rmtree('src')"`,
    `python3 -c "import os; os.remove('src/a.ts')"`,
    `python3 -c "import os; os.rmdir('src')"`,
    `python3 -c "from pathlib import Path; Path('src/a.ts').unlink()"`,
    `node -e "require('fs').promises.unlink('src/a.ts')"`,
    `ruby -e "FileUtils.rm_rf 'src'"`,
    `bun -e "fs.rmSync('src', { recursive: true })"`,
    `node -e "fs.unlinkSync('src/a.ts')"`,
    `perl -e 'unlink glob "src/*"'`,
  ]) {
    expect([command, loses(command)]).toEqual([command, true])
    const asks = (extra: Record<string, unknown>) =>
      onPermissionRequest(ledger, event(command, extra), () => dialog(command))
    expect([command, asks({}), asks({ agent_id: 'a1' })]).toEqual([command, null, null])
  }
  expect(ledger.sentBack(id)).toEqual([])
  for (const command of [
    'git log -1 --diff-filter=D',
    'git -C "a b" log -1 -- clean',
    'git log --grep "reset --hard"',
    'git checkout -b feat/y origin/main && git status',
    'git push origin feat/x',
    'git push -u origin HEAD:feat/x',
    `cat > src/a.ts <<'EOF'\nseen.delete(key)\ngit push\n--force\nEOF`,
    'git log -1\npush -f',
    'git checkout -b feat/y',
    'git switch -c feat/y',
    'git switch main',
    'git branch --list',
    'git branch -a --merged main',
    'git stash list',
    'git worktree list',
    'git commit -m "form the rms of it"',
    'cat src/rm.ts src/rm/a.ts',
    'bun run rm-cache',
    'rtk grep -rn "delete" src/a.ts',
    'bun test src/reset.test.ts && git diff --stat',
    'mv src/a.ts src/b.ts',
  ]) {
    expect([command, loses(command)]).toEqual([command, false])
  }
  // Long, and nearly one: read at once.
  const long = `git ${'-c '.repeat(20_000)}x; git branch ${'-a '.repeat(20_000)}x`
  expect(loses(long)).toBe(false)
  expect(onPermissionRequest(ledger, event('rm -rf dist'), () => dialog('rm -rf dist'))).toBe(ALLOW)
  expect(existsSync(join(work, 'dist'))).toBe(true)
})

test('a call does not go back on a prompt with another reason: a rule of the repo’s, a denial of the check’s, another command’s dialog, none nod can see', () => {
  const { ledger, id, event } = asking()
  const command = 'git log -1'
  const answers = (screen: string, extra: Record<string, unknown> = {}) =>
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
    expect([screen, answers(screen)]).toEqual([screen, null])
  }
  // Not in auto mode, or with no transcript to read.
  for (const extra of [
    { permission_mode: 'default' },
    { permission_mode: undefined },
    { transcript_path: undefined },
    { transcript_path: '' },
    { transcript_path: '/nowhere/s1.jsonl' },
  ]) {
    expect([extra, answers(dialog(command), extra)]).toEqual([extra, null])
  }
  const unseen = () => {
    throw new Error('tmux capture-pane failed')
  }
  expect(onPermissionRequest(ledger, event(command), unseen)).toBeNull()
  // One that asks to leave the sandbox, also rm; and for rm, what may open it.
  for (const sandbox of [true, 'true']) {
    const input = { tool_input: { command, dangerouslyDisableSandbox: sandbox } }
    expect([sandbox, answers(dialog(command), input)]).toEqual([sandbox, null])
  }
  for (const extra of [
    { dangerouslyDisableSandbox: true },
    { dangerouslyDisableSandbox: 'true' },
    { allowed_domains: ['example.com'] },
    { to_come: 1 },
  ]) {
    const input = { tool_input: { command: 'rm -rf dist', ...extra } }
    expect([extra, onPermissionRequest(ledger, event('', input), unseen)]).toEqual([extra, null])
  }
  expect([ledger.allowed(id), ledger.sentBack(id)]).toEqual([[], []])
  // Drawn wider, narrower, for the fifteenth call in a row, under another.
  const fifteenth = blocked(UNCHECKED, '15 consecutive actions were blocked.')
  const drawn: ((c: string) => string)[] = [
    (c) => dialog(c),
    (c) => dialog(c, blocked(), 190),
    (c) => dialog(c, blocked(), 7),
    (c) => dialog(c, fifteenth),
    (c) => `${dialog('git push', blocked('[Unauthorized Access]'))}\n${dialog(c)}`,
    (c) => `${dialog(c, 'x')}\n${dialog(c)}`,
  ]
  for (const [i, draw] of drawn.entries()) {
    const c = `git log -${i}`
    const answer = onPermissionRequest(ledger, event(c), () => draw(c))
    expect([draw(c), answer]).toEqual([draw(c), back(c)])
  }
  // rm, as before, whatever put its prompt up.
  expect(
    onPermissionRequest(ledger, event('rm -rf dist', { permission_mode: 'default' }), unseen),
  ).toBe(ALLOW)
})

test('nod waits for the dialog: until it is drawn, and while another call’s comes first', () => {
  const { ledger, event } = asking()
  const command = 'git log -1'
  const shown = ['', dialog('git status'), dialog(command)]
  WAIT.dialogMs = 60_000
  try {
    expect(onPermissionRequest(ledger, event(command), () => shown.shift() ?? '')).toEqual(
      back(command),
    )
    expect(shown).toEqual([])
    // Its own, whole, with another reason: there is nothing to wait for.
    const again = 'git log -2'
    const other = [dialog(again, 'Ask rule Bash(git log*) overrides auto mode for this command')]
    expect(onPermissionRequest(ledger, event(again), () => other.pop() ?? dialog(again))).toBeNull()
  } finally {
    WAIT.dialogMs = 0
  }
})

test('in a session whose check denied a call, in any turn or subagent, no call goes back; no verdict, the words elsewhere, or a call nod sent back, does not count', () => {
  const { ledger, config, transcript, row, event } = asking()
  let calls = 0
  const goesBack = (extra: Record<string, unknown> = {}): boolean => {
    const command = `git log -${++calls}`
    return onPermissionRequest(ledger, event(command, extra), () => dialog(command)) !== null
  }
  const DENIAL =
    'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Unauthorized Access]. If you have other tasks'
  const decision = (reasonCode: string, decision = 'reject') => ({
    permissionDecision: { decision, source: 'config', reasonType: 'classifier', reasonCode },
  })
  const said = (text: string) =>
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`
  const start = readFileSync(transcript, 'utf8')

  // Not denied: no verdict, in its words and marks; the words in a file it read or a message; a
  // prompt of auto mode's the person allowed; another refusal; what nod sent back, as Claude Code
  // keeps it (2.1.331's binary).
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
    row(back('git log -1').hookSpecificOutput.decision.message, {
      permissionDecision: {
        decision: 'reject',
        source: 'hook',
        reasonType: 'hook',
        reasonCode: 'hook:PermissionRequest',
      },
    }),
  ].join('')
  writeFileSync(transcript, start + fine)
  expect(goesBack()).toBe(true)

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
    expect([denied, goesBack()]).toEqual([denied, false])
  }

  // A subagent's prompt is judged the same, with its own transcript there to read.
  writeFileSync(transcript, start)
  expect(goesBack({ agent_id: 'a1' })).toBe(false)
  const agents = join(config, 's1', 'subagents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'agent-a1.jsonl'), fine)
  expect(goesBack({ agent_id: 'a1' })).toBe(true)
  expect(goesBack({ agent_id: 'a2' })).toBe(false)
  expect(goesBack()).toBe(true)
  writeFileSync(join(agents, 'agent-a2.jsonl'), row(DENIAL))
  writeFileSync(join(agents, 'agent-a3.jsonl'), '')
  writeFileSync(join(agents, 'agent-a3.meta.json'), '{"requestShape":"background"}')
  for (const agent of ['a1', 'a2', 'a3', undefined]) {
    expect([agent, goesBack({ agent_id: agent })]).toEqual([agent, false])
  }
})

test('a background subagent’s call goes back without its dialog, which shows only once the hook is done; another subagent’s needs it', () => {
  const { ledger, id, config, event } = asking()
  const agents = join(config, 's1', 'subagents')
  const started = (agent: string, meta: string | null, dir = agents): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `agent-${agent}.jsonl`), '')
    if (meta !== null) writeFileSync(join(dir, `agent-${agent}.meta.json`), meta)
  }
  const background = JSON.stringify({ agentType: 'general-purpose', requestShape: 'background' })
  started('a1', background)
  started('a2', background, join(agents, 'workflows', 'w1'))
  started('b1', JSON.stringify({ agentType: 'general-purpose', requestShape: 'foreground' }))
  started('b2', '{"agentType":"general-purpose"}')
  started('b3', 'not json')
  started('b4', null)
  const unseen = () => {
    throw new Error('read the screen')
  }
  // Each time another command: they go back once.
  let calls = 0
  const command = () => `sed -n '1,${++calls}p' src/a.ts`
  const ask = (agent_id: string, c: string, screen: () => string, extra = {}) =>
    onPermissionRequest(ledger, event(c, { agent_id, ...extra }), screen)
  for (const agent of ['a1', 'a2']) {
    const c = command()
    expect([agent, ask(agent, c, unseen)]).toEqual([agent, back(c)])
    // Its second prompt is the person's: one a rule forces, say, or the check denied, which nod
    // cannot tell from these.
    expect([agent, ask(agent, c, unseen), ask(agent, c, () => dialog(c))]).toEqual([
      agent,
      null,
      null,
    ])
  }
  for (const agent of ['b1', 'b2', 'b3', 'b4']) {
    const c = command()
    expect([agent, ask(agent, c, unseen)]).toEqual([agent, null])
    expect([agent, ask(agent, c, () => dialog('git push'))]).toEqual([agent, null])
    expect([agent, ask(agent, c, () => dialog(c))]).toEqual([agent, back(c)])
  }
  // Not one that asks to leave the sandbox, not in auto mode, nor one whose transcript is gone.
  const c = command()
  const input = { command: c, dangerouslyDisableSandbox: true }
  expect(ask('a1', c, unseen, { tool_input: input })).toBeNull()
  expect(ask('a1', c, unseen, { permission_mode: 'default' })).toBeNull()
  writeFileSync(join(agents, 'agent-a3.meta.json'), background)
  expect(ask('a3', c, unseen)).toBeNull()
  expect(ledger.sentBack(id)).toHaveLength(6)
  expect(ledger.allowed(id)).toEqual([])
})

test('nod hook permission reads the dialog off the worker’s terminal and prints the deny; a decision opens when it cannot, and the second time; nod show and nod stats have it', () => {
  const { home, ledger, id, attemptId, config, event } = asking()
  const bin = tmp.make('nod-allow-bin-')
  const screen = join(bin, 'screen')
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> '${bin}/asked'\ncat '${screen}'\n`)
  chmodSync(join(bin, 'tmux'), 0o755)
  const run = (command: string, extra = {}) =>
    hook(home, JSON.stringify(event(command, extra)), 'permission', {
      PATH: `${bin}:${process.env.PATH}`,
    })

  expect(run('git log -1')).toBe('')
  expect(asked(ledger, id)).toEqual([['permission', attemptId, 'git log -1']])
  writeFileSync(screen, dialog('git status'))
  expect(JSON.parse(run('git status'))).toEqual(back('git status'))
  expect(readFileSync(join(bin, 'asked'), 'utf8')).toContain(`capture-pane -p -t =task-${id}:`)
  expect(asked(ledger, id)).toHaveLength(1)
  expect(run('git status')).toBe('')
  expect(asked(ledger, id)).toEqual([
    ['permission', attemptId, 'git log -1'],
    ['permission', attemptId, 'git status'],
  ])
  const commit = 'git commit -m "fix: a\n\n  sent back by nod: b"'
  writeFileSync(screen, dialog(commit))
  expect(JSON.parse(run(commit))).toEqual(back(commit))
  // A background subagent's: no terminal is read. Its second opens with its Notification.
  const agents = join(config, 's1', 'subagents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'agent-a1.jsonl'), '')
  writeFileSync(join(agents, 'agent-a1.meta.json'), '{"requestShape":"background"}')
  const reads = readFileSync(join(bin, 'asked'), 'utf8')
  expect(JSON.parse(run('git diff', { agent_id: 'a1' }))).toEqual(back('git diff'))
  expect(run('git diff', { agent_id: 'a1' })).toBe('')
  expect(readFileSync(join(bin, 'asked'), 'utf8')).toBe(reads)
  expect(asked(ledger, id)).toHaveLength(2)
  expect(ledger.allowed(id)).toEqual([])

  const nod = (...args: string[]): string =>
    Bun.spawnSync(['bun', cli, ...args], {
      env: { ...process.env, NOD_HOME: home },
    }).stdout.toString()
  // On one line, whatever its message holds.
  expect(nod('show', String(id))).toMatch(
    /\n {2}sent back by nod \S+: git status\n {2}sent back by nod \S+: git commit -m "fix: a +sent back by nod: b"\n {2}sent back by nod \S+: git diff\n/,
  )
  const { sentBack } = JSON.parse(nod('stats')) as { sentBack: Record<string, number> }
  expect(Object.values(sentBack).reduce((a, b) => a + b, 0)).toBe(3)
}, 20_000)

test('nod stats counts the calls sent back by the days where it runs', () => {
  const { home, ledger, id } = running()
  setSystemTime(new Date('2026-01-15T20:00:00Z'))
  try {
    ledger.sendBack(id, 'git log -1', () => true)
  } finally {
    setSystemTime()
  }
  const days = (TZ: string): unknown => {
    const env = { ...process.env, NOD_HOME: home, TZ }
    return JSON.parse(Bun.spawnSync(['bun', cli, 'stats'], { env }).stdout.toString()).sentBack
  }
  expect(days('Asia/Seoul')).toEqual({ '2026-01-16': 1 })
  expect(days('America/New_York')).toEqual({ '2026-01-15': 1 })
})

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
