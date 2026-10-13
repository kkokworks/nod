import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'

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
  ledger.collected(done)
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
