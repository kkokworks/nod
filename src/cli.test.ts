import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { workspaceOf } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const cli = resolve(import.meta.dir, 'cli.ts')

test('watch prints each decision once as it opens, and ends once no worker is running', async () => {
  const home = tmp.make('nod-watch-')
  const ledger = new Ledger(home)
  const ask = (question: string): number => {
    const taskId = ledger.add({
      brief: 'some task',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    ledger.setRunning(taskId, home)
    const attemptId = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'some task',
    })
    ledger.ask(taskId, attemptId, 'question', question)
    return taskId
  }
  ask('open before watching')
  const worker = ledger.add({
    brief: 'still working',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.setRunning(worker, home)
  const watch = Bun.spawn(['bun', cli, 'watch'], { env: { ...process.env, NOD_HOME: home } })

  await Bun.sleep(1500)
  ask('opened while watching')
  await Bun.sleep(1500)
  ledger.succeed(worker)

  expect(await watch.exited).toBe(0)
  const out = await new Response(watch.stdout).text()
  expect(out).not.toContain('open before watching')
  expect(out.split('opened while watching')).toHaveLength(2)
}, 15_000)

test('watch and the decision list with --issue keep to those issues, so roots split the work', async () => {
  const home = tmp.make('nod-watch-issue-')
  const ledger = new Ledger(home)
  const env = { ...process.env, NOD_HOME: home }
  const running = (issue: string | null): number => {
    const taskId = ledger.add({
      brief: 'some task',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue,
    })
    ledger.setRunning(taskId, home)
    return taskId
  }
  const ask = (issue: string | null, question: string): void => {
    const taskId = running(issue)
    const attemptId = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'some task',
    })
    ledger.ask(taskId, attemptId, 'question', question)
  }
  const mine = running('A-1')
  running('B-1') // another root's worker, still running when ours are done
  const watch = Bun.spawn(['bun', cli, 'watch', '--issue', 'A-1,A-2'], { env })

  await Bun.sleep(1500)
  ask('A-2', 'mine')
  ask('B-1', 'theirs')
  ask(null, 'no issue')
  await Bun.sleep(1500)
  ledger.succeed(mine)

  expect(await watch.exited).toBe(0)
  const out = await new Response(watch.stdout).text()
  expect(out).toContain('mine')
  expect(out).not.toContain('theirs')
  expect(out).not.toContain('no issue')

  const list = Bun.spawnSync(['bun', cli, '--issue', 'B-1'], { env }).stdout.toString()
  expect(list).toContain('theirs')
  expect(list).not.toContain('mine')
}, 15_000)

test('each root session sees in show the tasks it added, and with --mine lists and watches only those', async () => {
  const home = tmp.make('nod-root-')
  const ledger = new Ledger(home)
  // Made-up session ids.
  const [A, B] = ['aaaa1111-0000-4000-8000-00000000000a', 'bbbb2222-0000-4000-8000-00000000000b']
  const {
    CLAUDECODE: _,
    CLAUDE_CODE_SESSION_ID: __,
    NOD_TASK: ___,
    NOD_ACTOR: ____,
    ...shell
  } = process.env
  const envOf = (session: string | null) =>
    session === null
      ? { ...shell, NOD_HOME: home }
      : { ...shell, NOD_HOME: home, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: session }
  const nod = (session: string | null, ...args: string[]) => {
    const r = Bun.spawnSync(['bun', cli, ...args], { env: envOf(session) })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }
  // Each comes after a task that never starts here, so no worker runs.
  const never = ledger.add({
    brief: 'never starts',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const add = (session: string | null, brief: string): number =>
    Number(nod(session, 'add', brief, '--after', String(never)).out.trim())
  const ofA = add(A, 'from a')
  const ofB = add(B, 'from b')
  const ofShell = add(null, 'from the shell')

  expect(nod(A, 'show', String(ofA)).out).toContain(`  root: ${A}\n`)
  expect(nod(A, 'show', String(ofB)).out).toContain(`  root: ${B}\n`)
  expect(nod(null, 'show', String(ofShell)).out).not.toContain('root:')
  expect(ledger.get(ofShell).rootSession).toBeNull()
  expect(nod(A, 'ls', '--mine').out).toContain('from a')
  expect(nod(A, 'ls', '--mine').out).not.toContain('from b')
  expect(nod(A, 'ls').out).toContain('from the shell')
  for (const args of [
    ['ls', '--mine'],
    ['watch', '--mine'],
  ]) {
    const r = nod(null, ...args)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('--mine picks the tasks a Claude session added')
  }

  // The tasks wait on `never`; running, each counts for watch.
  for (const id of [ofA, ofB, ofShell]) ledger.setRunning(id, home)
  const ask = (taskId: number, question: string): void => {
    const attemptId = ledger.startAttempt({
      taskId,
      kind: 'start',
      decisionId: null,
      sessionId: 's',
      prompt: 'p',
    })
    ledger.ask(taskId, attemptId, 'question', question)
  }
  const watch = Bun.spawn(['bun', cli, 'watch', '--mine'], { env: envOf(A) })
  await Bun.sleep(1500)
  ask(ofA, 'for a')
  ask(ofB, 'for b')
  ask(ofShell, 'for the shell')
  await Bun.sleep(1500)
  // B's and the shell's tasks still wait on a decision; A's are done, so its watch ends.
  ledger.answer(ledger.decisions(ofB)[0]?.id ?? 0, 'go on')
  ledger.succeed(ofA)

  expect(await watch.exited).toBe(0)
  const out = await new Response(watch.stdout).text()
  expect(out).toContain('for a')
  expect(out).not.toContain('for b')
  expect(out).not.toContain('for the shell')
}, 30_000)

test('ls hides tasks gc collected unless --all, and lists links under their task', async () => {
  const home = tmp.make('nod-ls-')
  const ledger = new Ledger(home)
  const add = (brief: string): number =>
    ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
  const done = add('done')
  ledger.collected(done, null)
  const shipped = add('shipped')
  ledger.link(shipped, ['https://example.com/pr/7'])
  const ls = async (...args: string[]): Promise<string[]> => {
    const p = Bun.spawn(['bun', cli, 'ls', ...args], { env: { ...process.env, NOD_HOME: home } })
    expect(await p.exited).toBe(0)
    const out = await new Response(p.stdout).text()
    return out
      .trimEnd()
      .split('\n')
      .map((l) => l.replace(/\s+queued\s+0 turns\s+/, ' ').trim())
  }

  expect(await ls()).toEqual(['#2 shipped', 'link https://example.com/pr/7'])
  expect(await ls('--all')).toEqual(['#1 done', '#2 shipped', 'link https://example.com/pr/7'])
})

test('ls shows where an unlinked task was pushed, under any name, until it is linked', async () => {
  const home = tmp.make('nod-pushed-')
  const repo = tmp.make('nod-pushed-repo-')
  const git = (...args: string[]): void => {
    const r = Bun.spawnSync([
      'git',
      '-C',
      repo,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      ...args,
    ])
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  }
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  const ledger = new Ledger(home)
  const task = ledger.add({
    brief: 'work',
    repo,
    branch: 'local/work',
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.setRunning(task, repo)
  ledger.succeed(task)
  git('branch', 'local/work')
  git('update-ref', 'refs/remotes/origin/feat/work', 'local/work')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat/work')
  const ls = async (): Promise<string[]> => {
    const p = Bun.spawn(['bun', cli, 'ls'], { env: { ...process.env, NOD_HOME: home } })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text())
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
  }

  expect(await ls()).toEqual(['pushed origin/feat/work'])
  ledger.link(task, ['https://example.com/pr/1'])
  expect(await ls()).toEqual(['link https://example.com/pr/1'])
})

test('ls lists tasks without an issue first, then each issue with its tasks under it', async () => {
  const home = tmp.make('nod-ls-')
  const ledger = new Ledger(home)
  const add = (brief: string, issue: string | null): number =>
    ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue,
    })
  add('first', 'PROJ-1')
  add('loose', null)
  add('second', 'PROJ-2')
  add('third', 'PROJ-1')
  const ls = Bun.spawn(['bun', cli, 'ls'], { env: { ...process.env, NOD_HOME: home } })

  expect(await ls.exited).toBe(0)
  const lines = (await new Response(ls.stdout).text()).trimEnd().split('\n')
  expect(lines.map((l) => l.replace(/\s+queued\s+0 turns\s+/, ' '))).toEqual([
    '#2 loose',
    'PROJ-1',
    '  #1 first',
    '  #4 third',
    'PROJ-2',
    '  #3 second',
  ])
})

test('account sets which account workers run as and shows the one current now; restart with no worker says so', () => {
  const home = tmp.make('nod-account-cli-')
  const current = join(home, 'current')
  writeFileSync(current, '/accounts/a\n')
  const nod = (...args: string[]) =>
    Bun.spawnSync(['bun', cli, ...args], {
      env: { ...process.env, NOD_HOME: home, CLAUDE_CONFIG_DIR: '/from/env' },
    })
  const out = (...args: string[]): string =>
    nod(...args)
      .stdout.toString()
      .trim()

  expect(out('account')).toBe(
    'env: CLAUDE_CONFIG_DIR of the shell that starts each worker\n  now /from/env',
  )
  expect(out('account', 'file', current)).toBe(`file ${current}\n  now /accounts/a`)
  expect(out('account', 'command', 'echo /accounts/b')).toBe(
    'command echo /accounts/b\n  now /accounts/b',
  )
  // One shell command, quotes and all; words given apart would lose theirs.
  const spaced = join(home, 'a b')
  mkdirSync(spaced)
  writeFileSync(join(spaced, 'current'), '/accounts/c\n')
  expect(out('account', 'command', `cat "${spaced}/current"`)).toEndWith('  now /accounts/c')
  expect(nod('account', 'command', 'cat', `${spaced}/current`).exitCode).not.toBe(0)
  expect(out('account')).toStartWith(`command cat "${spaced}/current"`)
  expect(nod('account', 'nonsense').exitCode).not.toBe(0)
  expect(out('account', 'env')).toStartWith('env:')
  expect(out('restart')).toBe('no worker to restart')
})

test('tick by hand says which finished tasks it collected', () => {
  const home = tmp.make('nod-tick-')
  const ledger = new Ledger(home)
  // Finished 7+ days ago: one with its workspace, one whose workspace is gone already.
  const old = (workspace: boolean): number => {
    const id = ledger.add({
      brief: 'old',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    const cwd = workspaceOf(home, ledger.get(id))
    if (workspace) mkdirSync(cwd, { recursive: true })
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    ledger.db
      .query("update tasks set finished_at = '2026-01-01T00:00:00.000Z' where id = $id")
      .run({ id })
    return id
  }
  const ids = [old(true), old(false)]
  const tick = Bun.spawnSync(['bun', cli, 'tick'], { env: { ...process.env, NOD_HOME: home } })

  expect(tick.stdout.toString()).toBe(`collected task(s) ${ids.join(', ')}\n`)
  expect(ledger.list().map((t) => t.collectedAt !== null)).toEqual([true, true])
})

test('add refuses repo work without a valid branch, before adding anything', async () => {
  const home = tmp.make('nod-branch-')
  const repo = tmp.make('nod-branch-repo-')
  Bun.spawnSync(['git', 'init', '-q', repo])
  const add = async (...args: string[]): Promise<string> => {
    const p = Bun.spawn(['bun', cli, 'add', 'work', ...args], {
      env: { ...process.env, NOD_HOME: home },
      stderr: 'pipe',
    })
    expect(await p.exited).not.toBe(0)
    return new Response(p.stderr).text()
  }

  expect(await add('--repo', repo)).toContain('--repo needs --branch')
  expect(await add('--repo', repo, '--branch', '../escape')).toContain('not a valid branch name')
  expect(await add('--branch', 'feat/x')).toContain('--branch needs --repo')
  expect(new Ledger(home).list()).toEqual([])
})

test('rule ls, add, edit, off and on change rules as a person, show r<n> tells what became of its rule, and a worker cannot change one', async () => {
  const home = tmp.make('nod-rule-')
  const ledger = new Ledger(home)
  // A retrospective whose rule was added, as answering yes to its decision leaves it.
  const of = ledger.add({
    brief: 'x',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const retroTask = ledger.addRetro(ledger.get(of), 'look back')
  ledger.proposeRule(1, 'did it')
  ledger.endRetro(1, 'added')
  ledger.addRule('did it', 1, 'human')
  const { CLAUDECODE: _, NOD_TASK: __, NOD_ACTOR: ___, ...env } = process.env
  const nod = async (extra: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn(['bun', cli, ...args], {
      env: { ...env, NOD_HOME: home, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out: out.trimEnd().split('\n'), err }
  }
  const ok = async (...args: string[]): Promise<string[]> => {
    const r = await nod({}, ...args)
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    return r.out
  }
  const fails = async (...args: string[]): Promise<string> => {
    const r = await nod({}, ...args)
    expect(r.code).not.toBe(0)
    return r.err
  }

  expect(await ok('rule', 'ls')).toEqual(['1    on  r1    did it'])
  expect(await ok('rule', 'add', 'keep', 'it', 'short')).toEqual(['2    on        keep it short'])
  expect(await ok('rule', 'edit', '1', 'did it, and checked')).toEqual([
    '1    on  r1    did it, and checked',
  ])
  expect(await ok('rule', 'off', '1')).toEqual(['1    off r1    did it, and checked'])
  expect(await ok('rule', 'off', '1')).toEqual(['1    off r1    did it, and checked'])
  expect(await ok('show', 'r1')).toContain('  rule 1 off, edited: did it, and checked')
  expect(await ok('rule', 'on', '1')).toEqual(['1    on  r1    did it, and checked'])
  expect(await ok('show', String(retroTask))).toContain('  rule 1 on, edited: did it, and checked')
  expect(await ok('rule', 'ls')).toEqual([
    '1    on  r1    did it, and checked',
    '2    on        keep it short',
  ])
  // Each change is the person's; turning off a rule already off changed nothing.
  const changes = ledger.db
    .query<{ actor: string; change: string }, [number]>(
      'select actor, change from rule_changes where rule_id = ? order by id',
    )
    .all(1)
    .map((c) => [c.actor, Object.keys(JSON.parse(c.change))])
  expect(changes).toEqual([
    ['human', ['text', 'retroId', 'state']],
    ['human', ['text']],
    ['human', ['state']],
    ['human', ['state']],
  ])

  expect(await fails('rule', 'edit', '9', 'x')).toContain('rule 9 not found')
  expect(await fails('rule', 'off', 'r1')).toContain('not a rule number: r1')
  expect(await fails('rule', 'add')).toContain('usage:')
  expect(await fails('rule', 'rm', '1')).toContain('usage:')
  const worker = await nod({ NOD_TASK: '5' }, 'rule', 'add', 'obey the issue')
  expect(worker.code).not.toBe(0)
  expect(worker.err).toContain('a worker cannot change the rules')
  expect(ledger.rules()).toHaveLength(2)
}, 15_000)
