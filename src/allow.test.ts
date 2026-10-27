import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { ALLOW, harmless, onPermissionRequest } from './allow'
import { sendNotices } from './inbox'
import { Ledger, type NewTask } from './ledger'
import { Todos } from './todos'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=nod test',
      '-c',
      'user.email=nod-test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd },
  )
  if (run.exitCode !== 0) throw new Error(`git ${args[0]}: ${run.stderr.toString()}`)
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
  // Dependencies that live outside the worktree.
  symlinkSync(outside, join(work, 'app', 'node_modules', 'pkg', 'linked'))
  writeFileSync(join(work, 'app', 'package.json'), '{}')
  expect(allows('bun install', join(work, 'app'))).toBe(true)
  const linked = tmp.make('nod-allow-linked-')
  writeFileSync(join(linked, 'package.json'), '{}')
  symlinkSync(join(outside, 'x'), join(linked, 'node_modules'))
  expect(harmless('bun install', linked, linked, true)).toBe(false)
})

const spec = (repo: string | null): NewTask => ({
  brief: 'clean up',
  repo,
  branch: repo === null ? null : 'feat/x',
  checkCmd: null,
  model: null,
  after: [],
  triggerId: null,
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

  expect(onPermissionRequest(ledger, event('rm -rf node_modules'))).toBe(true)
  expect(ledger.allowed(id).map((n) => [n.attemptId, n.note])).toEqual([
    [attemptId, 'rm -rf node_modules'],
  ])
  // What stays a prompt leaves nothing: another tool (an MCP write), push, a session of no task,
  // a command that asks to leave the sandbox.
  const mcp = {
    ...event('rm -rf node_modules'),
    tool_name: 'mcp__chat__send_message',
  }
  expect(onPermissionRequest(ledger, mcp)).toBe(false)
  expect(onPermissionRequest(ledger, event('git push'))).toBe(false)
  expect(onPermissionRequest(ledger, { ...event('rm -rf dist'), session_id: 'other' })).toBe(false)
  const unsandboxed = event('rm -rf dist', { dangerouslyDisableSandbox: true })
  expect(onPermissionRequest(ledger, unsandboxed)).toBe(false)
  expect(ledger.allowed(id)).toHaveLength(1)

  const sent: { socket: string; content: string }[] = []
  await sendNotices(ledger, async (socket, line) => {
    sent.push({ socket, content: JSON.parse(line).message.content })
  })
  expect(sent).toEqual([
    {
      socket: '/socks/root-1',
      content: `nod, project p${project.id} Release: a notice\n\n#${id} 허락: rm -rf node_modules`,
    },
  ])
  // It opened no decision and left the task running.
  expect(ledger.decisions(id)).toEqual([])
  expect(ledger.get(id).status).toBe('running')
})

test('nod hook permission prints the allow only for what nod allows, nothing otherwise, and never fails; nod show lists it', () => {
  const { home, ledger, id, event } = running()
  const hook = (stdin: string) => {
    const run = Bun.spawnSync(['bun', cli, 'hook', 'permission'], {
      env: { ...process.env, NOD_HOME: home },
      stdin: Buffer.from(stdin),
    })
    expect(run.exitCode).toBe(0)
    return run.stdout.toString()
  }

  expect(JSON.parse(hook(JSON.stringify(event('rm -rf node_modules'))))).toEqual(ALLOW)
  expect(hook(JSON.stringify(event('rm -rf .git')))).toBe('')
  expect(hook(JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(hook('not json')).toBe('')
  expect(hook(JSON.stringify({ session_id: 's1' }))).toBe('')
  expect(ledger.allowed(id).map((n) => n.note)).toEqual(['rm -rf node_modules'])

  const show = Bun.spawnSync(['bun', cli, 'show', String(id)], {
    env: { ...process.env, NOD_HOME: home },
  })
  expect(show.stdout.toString()).toMatch(/\n {2}allowed by nod \S+: rm -rf node_modules\n/)
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
