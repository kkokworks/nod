import { afterAll, expect, spyOn, test } from 'bun:test'
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
import { git } from '../test/remote'
import { tempDirs } from '../test/tmp'
import { ALLOW, harmless, onPermissionRequest } from './allow'
import { sendNotices } from './inbox'
import { Ledger, type NewTask, type Task } from './ledger'
import { Terminals } from './tmux'
import { Todos } from './todos'
import { allowedLine, watch } from './view'
import { answer, onNotification, onPrompt, tell } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

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

test('a root session that watches hears the line too, for the tasks it watches, from when it started', async () => {
  const { ledger, id, event } = running()
  onPermissionRequest(ledger, event('rm -rf dist'))
  const heard = async (counts: (t: Task) => boolean): Promise<string[]> => {
    const printed: string[] = []
    let looks = 0
    const wait = async (): Promise<void> => {
      looks += 1
      if (looks === 1) onPermissionRequest(ledger, event(`rm -rf build${looks}`))
      if (looks === 2) ledger.succeed(id)
    }
    await watch(
      ledger,
      counts,
      () => {},
      () => {},
      wait,
      (n) => printed.push(allowedLine(n)),
    )
    return printed
  }
  expect(await heard((t) => t.id === id)).toEqual([`#${id} 허락: rm -rf build1`])
  ledger.setRunning(id, ledger.get(id).workspace ?? '')
  expect(await heard((t) => t.id !== id)).toEqual([])
})

// Runs `nod hook permission` on `home` as Claude Code does, with `stdin`; returns what it printed.
function hook(home: string, stdin: string): string {
  const run = Bun.spawnSync(['bun', cli, 'hook', 'permission'], {
    env: { ...process.env, NOD_HOME: home },
    stdin: Buffer.from(stdin),
  })
  expect(run.exitCode).toBe(0)
  return run.stdout.toString()
}

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

// The PermissionRequest hook runs as the dialog shows, its Notification some 6 s later (2.1.310).
test('a prompt nod does not allow holds back nod tell from its turn as it shows, before its Notification, which opens no second decision; so does the next prompt of the turn once the first is answered', async () => {
  const { home, ledger, id, attemptId, event } = running()
  const notified = () =>
    onNotification(ledger, home, {
      session_id: 's1',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    })
  const refused = () =>
    expect(tell(ledger, home, id, 'also tag it')).rejects.toThrow(
      /^answer permission decision #\d+ first: Enter would answer its dialog$/,
    )
  // The worker's terminal is up (tmux stands in), its turn going.
  const alive = spyOn(Terminals.prototype, 'alive').mockReturnValue(true)
  const option = spyOn(Terminals.prototype, 'option').mockReturnValue('')
  const keys = spyOn(Terminals.prototype, 'keys').mockImplementation(() => {})
  try {
    expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
    expect(asked(ledger, id)).toEqual([['permission', attemptId, 'git push origin feat/x']])
    await refused()
    await notified()
    expect(asked(ledger, id)).toHaveLength(1)

    // It is answered, through nod here, so nothing of it is left open (one the person answers in
    // the worker's terminal stays open to the turn's end), and the turn asks again: that prompt
    // holds the message back with a decision of its own as it shows.
    await answer(ledger, home, ledger.decisions(id)[0]?.id ?? 0, 'yes', 'human')
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
  const alive = spyOn(Terminals.prototype, 'alive').mockReturnValue(true)
  const option = spyOn(Terminals.prototype, 'option').mockReturnValue('')
  const send = spyOn(Terminals.prototype, 'send').mockImplementation(() => {})
  try {
    transcript(asking)
    await expect(tell(ledger, home, id, 'push to the fork')).rejects.toThrow(/^answer permission/)
    // Escape on the dialog ends the turn with no Stop (2.1.290).
    transcript(asking, { type: 'user', message: { role: 'user', content: [stop] } })
    await tell(ledger, home, id, 'push to the fork')
    expect(send.mock.calls.map(([, text]) => text)).toEqual(['push to the fork'])
  } finally {
    alive.mockRestore()
    option.mockRestore()
    send.mockRestore()
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
  const alive = spyOn(Terminals.prototype, 'alive').mockReturnValue(true)
  const attached = spyOn(Terminals.prototype, 'attached').mockReturnValue(true)
  const option = spyOn(Terminals.prototype, 'option').mockReturnValue('')
  const send = spyOn(Terminals.prototype, 'send').mockImplementation(() => {})
  try {
    // They answer the dialog no with Escape, which ends the turn with no Stop (2.1.290), and type
    // what to do instead: the prompt hook runs before Claude Code keeps it.
    transcript(said([stop]))
    await onPrompt(ledger, home, { session_id: 's1', prompt: 'push to the fork' })
    expect(ledger.get(id).status).toBe('running')
    transcript(said([stop]), said('push to the fork'))
    await tell(ledger, home, id, 'and tag it')
    expect(send.mock.calls.map(([, text]) => text)).toEqual(['and tag it'])
  } finally {
    alive.mockRestore()
    attached.mockRestore()
    option.mockRestore()
    send.mockRestore()
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
  const attached = spyOn(Terminals.prototype, 'attached').mockReturnValue(true)
  const option = spyOn(Terminals.prototype, 'option').mockReturnValue('')
  // The ledger is busy as the decision closes.
  const dismiss = spyOn(Ledger.prototype, 'dismiss').mockImplementation(() => {
    throw new Error('database is locked')
  })
  try {
    await expect(
      onPrompt(ledger, home, { session_id: 's1', prompt: 'push to the fork' }),
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

test("no to one of the prompts tools that ran at once queued closes the others' decisions too: Escape ends the turn and every dialog of it", async () => {
  const { home, ledger, id, attemptId, event } = running()
  expect(hook(home, JSON.stringify(event('git push origin feat/x')))).toBe('')
  expect(hook(home, JSON.stringify(event('git push origin --tags')))).toBe('')
  const [first] = ledger.decisions(id)
  const alive = spyOn(Terminals.prototype, 'alive').mockReturnValue(true)
  const option = spyOn(Terminals.prototype, 'option').mockReturnValue('')
  const attached = spyOn(Terminals.prototype, 'attached').mockReturnValue(false)
  const keys = spyOn(Terminals.prototype, 'keys').mockImplementation(() => {})
  // Claude Code shows the turn stopped once Escape is in.
  const screen = spyOn(Terminals.prototype, 'screen').mockReturnValue('Interrupted')
  const send = spyOn(Terminals.prototype, 'send').mockImplementation(() => {})
  try {
    await answer(ledger, home, first?.id ?? 0, 'no, not yet', 'human')
    expect(keys.mock.calls.map(([, key]) => key)).toEqual(['Escape'])
    expect(send.mock.calls.map(([, text]) => text)).toEqual([
      'Human decision: permission denied. no, not yet',
    ])
  } finally {
    for (const spy of [alive, option, attached, keys, screen, send]) spy.mockRestore()
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
