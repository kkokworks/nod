import { afterAll, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolder } from '../test/projects'
import { tempDirs } from '../test/tmp'
import { doneTasks, type PrLookup, type PullRequest, sweep } from './done'
import { collect } from './gc'
import { Ledger, type NewTask } from './ledger'
import { workspaceOf } from './place'
import { Tmux } from './tmux'
import { Todos } from './todos'
import { restore } from './worker'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const PR = 'https://git.example.com/o/r/pulls/'
const NOW = new Date('2026-03-10T00:00:00.000Z')
const RECENT = '2026-03-09T00:00:00.000Z'
const OLD = '2026-03-01T00:00:00.000Z'
const HEAD_REPO = 'https://git.example.com/o/r'
const OPEN: PullRequest = {
  state: 'open',
  head: 'feat/other',
  headRepo: HEAD_REPO,
  mergedAt: null,
  approvedAt: null,
}
// Merged after any commit a test makes, so only the branch's name or repo can hold a task back.
const MERGED: PullRequest = { ...OPEN, state: 'merged', mergedAt: '2099-01-01T00:00:00Z' }

test('done signals: dropped, taken over, merged into the default branch, every pull request closed or approved, or old', async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')

  const spec = (brief: string, branch: string | null): NewTask => ({
    brief,
    repo: branch === null ? null : repo,
    branch,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  // A task added and finished at `at`; with a branch, a worktree on it, and a commit when `commit`
  // is set.
  const finish = (id: number, at: string, commit = false): number => {
    const task = ledger.get(id)
    const cwd = workspaceOf(home, task)
    if (task.branch === null) mkdirSync(cwd, { recursive: true })
    else {
      git(repo, 'worktree', 'add', '-q', '-b', task.branch, cwd)
      if (commit) {
        writeFileSync(join(cwd, `${id}.txt`), task.brief)
        git(cwd, 'add', '.')
        git(cwd, 'commit', '-q', '-m', task.brief)
      }
    }
    ledger.setRunning(id, cwd)
    ledger.succeed(id)
    ledger.db
      .query('update tasks set created_at = $at, finished_at = $at where id = $id')
      .run({ id, at })
    return id
  }
  const add = (brief: string, branch: string | null = null): number =>
    ledger.add(spec(brief, branch))
  const drop = (id: number): void => {
    ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id })
  }

  const dropped = finish(add('dropped', 'chore/dropped'), RECENT)
  drop(dropped)
  // A plain workspace's files are the task's output: only age lets it go.
  const droppedPlain = finish(add('dropped plain'), RECENT)
  drop(droppedPlain)

  const todos = new Todos(ledger)
  const todo = todos.capture(
    { title: 'review', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  ).todo
  const replaced = finish(ledger.addTodoTask(spec('first round', 'chore/first'), todo.id), RECENT)
  const takeover = finish(ledger.addTodoTask(spec('second round', 'chore/second'), todo.id), RECENT)

  const approved = finish(add('approved review', 'chore/approved'), RECENT)
  ledger.link(approved, [`${PR}1#issuecomment-9`])
  const earlierRound = finish(add('review after an earlier approval', 'chore/again'), RECENT)
  ledger.link(earlierRound, [`${PR}6`])
  const changes = finish(add('review asking for changes', 'chore/changes'), RECENT)
  ledger.link(changes, [`${PR}2`])
  const merged = finish(add('merged pr', 'feat/merged'), RECENT, true)
  git(repo, 'update-ref', 'refs/remotes/origin/feat/merged', 'feat/merged')
  ledger.link(merged, [`${PR}3`])
  const oneOfTwo = finish(add('two prs, one merged', 'feat/two'), RECENT)
  ledger.link(oneOfTwo, [`${PR}3`, `${PR}5`])
  const unpushed = finish(add('unpushed', 'feat/unpushed'), OLD, true)
  ledger.link(unpushed, [`${PR}3`])
  // Made while the main clone sat on a branch with a commit no remote has: not the task's to push.
  git(repo, 'checkout', '-q', '-b', 'local')
  writeFileSync(join(repo, 'local.txt'), 'local')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'local only')
  const inherited = finish(add('made on a local branch', 'feat/inherited'), RECENT)
  drop(inherited)
  git(repo, 'checkout', '-q', '-')
  const waitedOn = finish(add('base of a queued task', 'feat/base'), RECENT)
  ledger.link(waitedOn, [`${PR}3`])
  ledger.add({ ...spec('after the base', 'feat/next'), after: [waitedOn] })
  const landed = finish(add('squashed', 'feat/squashed'), RECENT, true)
  writeFileSync(join(repo, `${landed}.txt`), 'squashed')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'squash')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  const old = finish(add('old plain'), OLD)
  const recent = finish(add('recent plain'), RECENT)
  const broken = finish(add('lookup fails', 'chore/broken'), RECENT)
  ledger.link(broken, [`${PR}4`])
  const brokenOld = finish(add('lookup fails, old', 'chore/broken-old'), OLD)
  ledger.link(brokenOld, [`${PR}4`])
  // An errored task goes with age (or a takeover, in the test below), not with a pull request or
  // the branch, and never with the only copy of commits or with a queued task on its branch.
  const error = (id: number, at: string): number => {
    ledger.error(id, 'crashed')
    ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at })
    return id
  }
  const errored = error(finish(add('errored'), OLD), OLD)
  const erroredMerged = error(finish(add('errored, its pr merged', 'feat/errored'), RECENT), RECENT)
  ledger.link(erroredMerged, [`${PR}3`])
  const erroredUnpushed = error(
    finish(add('errored, unpushed', 'feat/errored-unpushed'), OLD, true),
    OLD,
  )
  const erroredWaitedOn = error(finish(add('errored, base of a queued task'), OLD), OLD)
  ledger.add({ ...spec('after the errored base', null), after: [erroredWaitedOn] })
  // A pull request linked on the task's todo counts as one linked on the task; a link that is no
  // pull request does not.
  const linkedTodo = (title: string, url: string): number =>
    todos.capture({ title, notes: null, source: 'cli', sourceKey: null, url }, 'human').todo.id
  const merging = linkedTodo('merge it', 'https://chat.example.com/m/1')
  todos.link(merging, `${PR}3`, null, 'human')
  const viaTodo = finish(
    ledger.addTodoTask(spec('pr on its todo', 'feat/via-todo'), merging),
    RECENT,
  )
  const chatOnly = linkedTodo('answer it', 'https://chat.example.com/m/2')
  const viaChat = finish(
    ledger.addTodoTask(spec('chat on its todo', 'chore/chat'), chatOnly),
    RECENT,
  )
  // A retrospective's report and the answer to it are in the ledger, not its folder.
  const ruled = finish(ledger.addRetro(ledger.get(recent), 'retro, rule added or none'), RECENT)
  const turnedDown = finish(ledger.addRetro(ledger.get(old), 'retro, rule turned down'), RECENT)
  drop(turnedDown)

  const prs: Record<string, PullRequest> = {
    [`${PR}1#issuecomment-9`]: { ...OPEN, approvedAt: '2026-03-09T01:00:00Z' },
    [`${PR}2`]: OPEN,
    [`${PR}3`]: MERGED,
    [`${PR}5`]: OPEN,
    [`${PR}6`]: { ...OPEN, approvedAt: '2026-03-08T00:00:00Z' },
  }
  const lookup: PrLookup = async (url) => {
    if (url === `${PR}4`) throw new Error('tea exited 1')
    return prs[url] ?? null
  }

  const { done, unchecked } = await doneTasks(ledger, Tmux.of(home), lookup, NOW)

  expect(done).toEqual([
    { id: dropped, reason: 'dropped' },
    { id: replaced, reason: `n${takeover} took over t${todo.id}` },
    { id: approved, reason: `approved: ${PR}1#issuecomment-9` },
    { id: merged, reason: `merged: ${PR}3` },
    { id: inherited, reason: 'dropped' },
    { id: landed, reason: 'its changes are in the default branch' },
    { id: old, reason: 'finished 7+ days ago' },
    { id: brokenOld, reason: 'finished 7+ days ago' },
    { id: errored, reason: 'finished 7+ days ago' },
    { id: viaTodo, reason: `merged: ${PR}3` },
    { id: ruled, reason: 'retrospective done' },
    { id: turnedDown, reason: 'dropped' },
  ])
  // Not done: a plain workspace not yet old, the newer round, an approval from before the task,
  // changes asked for, a pull request still open, the only copy of commits, a branch a queued task
  // starts from, an errored task not yet old, a todo linking no pull request. A failed lookup is
  // reported, not taken as an answer.
  const ids = done.map((d) => d.id)
  for (const id of [droppedPlain, takeover, earlierRound, changes, oneOfTwo, unpushed, waitedOn]) {
    expect(ids).not.toContain(id)
  }
  for (const id of [erroredMerged, erroredUnpushed, erroredWaitedOn, viaChat]) {
    expect(ids).not.toContain(id)
  }
  expect(ids).not.toContain(recent)
  expect(unchecked).toEqual([{ id: broken, error: 'tea exited 1' }])

  const swept = await sweep(ledger, home, Tmux.of(home), lookup, NOW)
  expect(swept.report.removed).toEqual(ids)
  expect(ledger.get(approved).collectedAt).not.toBeNull()
  expect(ledger.get(unpushed).collectedAt).toBeNull()
  // Collected tasks are not looked at again.
  expect((await doneTasks(ledger, Tmux.of(home), lookup, NOW)).done).toEqual([])
}, 30_000)

test("the finished tasks' signals are read at once, a slow git service waited on once for all of them, and told in the tasks' order", async () => {
  const home = tmp.make('nod-done-at-once-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  sh(['git', 'init', '-q'], repo)
  const finished = (brief: string, url: string): number => {
    const id = ledger.add({
      brief,
      repo,
      branch: `feat/${brief}`,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    })
    ledger.setRunning(id, repo)
    ledger.succeed(id)
    ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: RECENT })
    ledger.link(id, [url])
    return id
  }
  const first = finished('first', `${PR}1`)
  const second = finished('second', `${PR}2`)
  // The first pull request answers only once the second has been asked about: asked one task after
  // the other, the signals would wait for good.
  let askedSecond = (): void => {}
  const secondAsked = new Promise<void>((resolve) => {
    askedSecond = resolve
  })
  const lookup: PrLookup = async (url) => {
    if (url === `${PR}1`) await secondAsked
    else askedSecond()
    return MERGED
  }

  expect(await doneTasks(ledger, Tmux.of(home), lookup, NOW)).toEqual({
    done: [
      { id: first, reason: `merged: ${PR}1` },
      { id: second, reason: `merged: ${PR}2` },
    ],
    unchecked: [],
  })
})

test("a task that never started leaves the branch it was named for alone: it is someone else's", async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], repo)
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  // The person's branches: two pushed, one with a commit no remote has.
  for (const branch of ['feat/mine', 'feat/theirs', 'feat/local']) git('branch', branch)
  git('update-ref', 'refs/remotes/origin/feat/mine', 'feat/mine')
  git('update-ref', 'refs/remotes/origin/feat/theirs', 'feat/theirs')
  git('checkout', '-q', 'feat/local')
  writeFileSync(join(repo, 'local.txt'), 'local')
  git('add', '.')
  git('commit', '-q', '-m', 'local only')
  git('checkout', '-q', 'main')
  const spec = (brief: string, branch: string | null, after: number[] = []): NewTask => ({
    brief,
    repo: branch === null ? null : repo,
    branch,
    checkCmd: null,
    model: null,
    after,
    issue: null,
  })
  // Tasks queued after one the human drops are cancelled with it, before they make a branch.
  const first = ledger.add(spec('first', null))
  const queued = ledger.add(spec('after the first', 'feat/mine', [first]))
  const local = ledger.add(spec('after the first, too', 'feat/local', [first]))
  const attempt = ledger.startAttempt({
    taskId: first,
    kind: 'start',
    decisionId: null,
    sessionId: 'session-first',
    prompt: 'first',
  })
  ledger.drop(ledger.ask(first, attempt, 'question', 'go on?'))
  expect(ledger.get(queued).status).toBe('cancelled')
  // `worktree add -b` failed: the branch was already there.
  const taken = ledger.add(spec('taken', 'feat/theirs'))
  ledger.error(taken, 'git worktree add failed: a branch named feat/theirs already exists')

  const swept = await sweep(ledger, home, Tmux.of(home), async () => null, NOW)
  const named = await collect(ledger, home, Tmux.of(home), { ids: [taken] })

  expect(swept.done).toEqual([
    { id: queued, reason: 'dropped' },
    { id: local, reason: 'dropped' },
  ])
  expect(named).toEqual({ removed: [], clean: [taken], skipped: [] })
  expect(git('branch', '--list', 'feat/*').split('\n').filter(Boolean)).toEqual([
    '  feat/local',
    '  feat/mine',
    '  feat/theirs',
  ])
})

test('sweep looks again for a person attached just before it closes the session', async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const id = ledger.add({
    brief: 'old plain',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const cwd = workspaceOf(home, ledger.get(id))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(id, cwd)
  ledger.succeed(id)
  ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id, at: OLD })
  // The person attaches once sweep has read the signals.
  let looks = 0
  const attached = spyOn(Tmux.prototype, 'attached').mockImplementation(() => looks++ > 0)

  const swept = await sweep(ledger, home, Tmux.of(home), async () => null, NOW).finally(() =>
    attached.mockRestore(),
  )

  expect(swept.done).toEqual([{ id, reason: 'finished 7+ days ago' }])
  expect(swept.report).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id, reason: 'a person is attached to its terminal' }],
  })
  expect(existsSync(cwd)).toBe(true)
  expect(ledger.get(id).collectedAt).toBeNull()
})

test('sweep collects a task only as its signal read it: one that ran again and finished is judged again', async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const spec = (brief: string, branch: string | null): NewTask => ({
    brief,
    repo: branch === null ? null : join(home, 'repo'),
    branch,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  const old = ledger.add(spec('old plain', null))
  const cwd = workspaceOf(home, ledger.get(old))
  mkdirSync(cwd, { recursive: true })
  ledger.setRunning(old, cwd)
  ledger.succeed(old)
  ledger.db.query('update tasks set finished_at = $at where id = $id').run({ id: old, at: OLD })
  // A later task's pull request is read after the old one is judged; meanwhile `nod tell` sets the
  // old one going again, and it finishes.
  const later = ledger.add(spec('later', 'feat/later'))
  ledger.setRunning(later, join(home, 'work', 'later'))
  ledger.succeed(later)
  ledger.link(later, [`${PR}1`])
  const lookup: PrLookup = async () => {
    ledger.setRunning(old, cwd)
    ledger.succeed(old)
    return OPEN
  }

  const swept = await sweep(ledger, home, Tmux.of(home), lookup, NOW)

  expect(swept.done).toEqual([{ id: old, reason: 'finished 7+ days ago' }])
  expect(swept.report).toEqual({
    removed: [],
    clean: [],
    skipped: [{ id: old, reason: 'changed while gc ran' }],
  })
  expect(existsSync(cwd)).toBe(true)
  expect(ledger.get(old).collectedAt).toBeNull()
})

test("an errored repo task goes once a task added after the error does its todo, its error still shown, unless it keeps the only copy of commits or a queued task's start", async () => {
  const home = tmp.make('nod-done-')
  process.env.CLAUDE_CONFIG_DIR = tmp.make('nod-done-claude-')
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const todos = new Todos(ledger)
  const spec = (brief: string, branch: string | null): NewTask => ({
    brief,
    repo: branch === null ? null : repo,
    branch,
    checkCmd: null,
    model: null,
    after: [],
    issue: null,
  })
  // A task for a new todo that errors, and another doing the same todo right after it (the next id).
  const errorThenRedo = (brief: string, branch: string | null, ran = false): number => {
    const todo = todos.capture(
      { title: brief, notes: null, source: 'cli', sourceKey: null, url: null },
      'human',
    ).todo.id
    const id = ledger.addTodoTask(spec(brief, branch), todo)
    const task = ledger.get(id)
    if (ran) {
      const cwd = workspaceOf(home, task)
      if (branch === null) mkdirSync(cwd, { recursive: true })
      else {
        git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
        writeFileSync(join(cwd, `${id}.txt`), brief)
        git(cwd, 'add', '.')
        git(cwd, 'commit', '-q', '-m', brief)
      }
      ledger.setRunning(id, cwd)
    }
    ledger.error(id, `${brief}: it broke`)
    ledger.addTodoTask(spec(`${brief}, again`, branch === null ? null : `${branch}-again`), todo)
    return id
  }
  // As when filling the submodules failed: it never started.
  const failedStart = errorThenRedo('failed start', 'feat/start')
  const unpushed = errorThenRedo('unpushed', 'feat/unpushed', true)
  const waitedOn = errorThenRedo('waited on', 'feat/base')
  ledger.add({ ...spec('after the base', 'feat/next'), after: [waitedOn] })
  // A plain workspace's files are its output: only age lets it go.
  const plain = errorThenRedo('plain', null, true)
  // A round on the same todo that was there before it errored: nobody has seen the error yet.
  const unseen = errorThenRedo('unseen', 'feat/unseen')
  const earlier = new Date(Date.parse(ledger.get(unseen).finishedAt ?? '') - 1000).toISOString()
  ledger.db
    .query('update tasks set created_at = $at where id = $id')
    .run({ id: unseen + 1, at: earlier })

  const swept = await sweep(ledger, home, Tmux.of(home), async () => null, NOW)

  const todoOf = (id: number) => ledger.get(id).todoId
  expect(swept.done).toEqual([
    { id: failedStart, reason: `n${failedStart + 1} took over t${todoOf(failedStart)}` },
  ])
  expect(swept.report).toEqual({ removed: [], clean: [failedStart], skipped: [] })
  for (const id of [unpushed, waitedOn, plain, unseen]) {
    expect(ledger.get(id).collectedAt).toBeNull()
  }
  // What went wrong stays on its row.
  const shown = Bun.spawnSync(
    ['bun', join(import.meta.dir, 'cli.ts'), 'show', String(failedStart)],
    {
      env: { ...process.env, NOD_HOME: home },
    },
  )
  expect(shown.stdout.toString()).toContain('failed start: it broke')
  expect(shown.stdout.toString()).toContain('collected:')
})

const BEFORE = '2026-03-08T00:00:00Z'
const MERGE = '2026-03-09T00:00:00Z'
const AFTER = '2026-03-09T01:00:00Z'

// A repo whose origin is HEAD_REPO written another way, and `finish` to make a finished task on
// feat/<name> with a commit no remote has, written before the merge and committed at `at`, and its
// pull request, from that branch in that repo and merged at MERGE unless `pr` says otherwise. The
// pull request is linked on the task, or on `todo` when given.
function unpushedTasks() {
  const home = tmp.make('nod-done-')
  const claude = tmp.make('nod-done-claude-')
  process.env.CLAUDE_CONFIG_DIR = claude
  const ledger = new Ledger(home)
  const repo = join(home, 'repo')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]): string =>
    sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], cwd)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'remote', 'add', 'origin', 'git@git.example.com:O/R.git')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const todos = new Todos(ledger)
  const prs = new Map<string, PullRequest>()
  const lookup: PrLookup = async (url) => prs.get(url) ?? null
  const finish = (name: string, at: string, pr: Partial<PullRequest> = {}, todo?: number) => {
    const branch = `feat/${name}`
    const spec: NewTask = {
      brief: name,
      repo,
      branch,
      checkCmd: null,
      model: null,
      after: [],
      issue: null,
    }
    const id = todo === undefined ? ledger.add(spec) : ledger.addTodoTask(spec, todo)
    const cwd = workspaceOf(home, ledger.get(id))
    git(repo, 'worktree', 'add', '-q', '-b', branch, cwd)
    writeFileSync(join(cwd, `${name}.txt`), name)
    git(cwd, 'add', '.')
    sh(
      [
        'env',
        `GIT_COMMITTER_DATE=${at}`,
        'git',
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        `--date=${BEFORE}`,
        '-m',
        name,
      ],
      cwd,
    )
    ledger.setRunning(id, cwd)
    const sessionId = `session-${id}`
    ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId, prompt: name })
    ledger.succeed(id)
    mkdirSync(projectFolder(claude, cwd), { recursive: true })
    writeFileSync(join(projectFolder(claude, cwd), `${sessionId}.jsonl`), '{}\n')
    const url = `${PR}${id}`
    prs.set(url, { ...MERGED, head: branch, mergedAt: MERGE, ...pr })
    if (todo === undefined) ledger.link(id, [url])
    else todos.link(todo, url, null, 'human')
    return id
  }
  return { home, ledger, repo, git, todos, prs, lookup, finish }
}

test('a succeeded task with commits no remote has goes once its own pull request merged after them, and they stay on its branch for resume', async () => {
  const { home, ledger, repo, git, todos, lookup, finish } = unpushedTasks()
  const todo = todos.capture(
    { title: 'do it', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  ).todo.id

  const pushedElsewhere = finish('elsewhere', BEFORE)
  const viaTodo = finish('via-todo', BEFORE, {}, todo)
  // Rewritten after the merge: its author's time is still before it.
  const rewritten = finish('rewritten', AFTER)
  const sameSecond = finish('same-second', MERGE)
  const otherBranch = finish('other-branch', BEFORE, { head: 'feat/someone-elses' })
  // Its branch's name, in a fork or another repo or host: someone else's too.
  const fork = finish('fork', BEFORE, { headRepo: 'https://git.example.com/someone/r' })
  const otherRepo = finish('other-repo', BEFORE, { headRepo: 'https://git.example.com/o/r2' })
  const otherHost = finish('other-host', BEFORE, { headRepo: 'https://github.com/o/r' })
  // The service does not say where its head is, a fork since deleted, say.
  const unknownRepo = finish('unknown-repo', BEFORE, { headRepo: null })
  const notMerged = finish('not-merged', BEFORE, { state: 'closed' })
  const stillOpen = finish('still-open', BEFORE, { state: 'open', mergedAt: null })
  const errored = finish('errored', BEFORE)
  ledger.error(errored, 'crashed')
  const dropped = finish('dropped', BEFORE)
  ledger.db.query("update tasks set status = 'cancelled' where id = $id").run({ id: dropped })
  const waitedOn = finish('waited-on', BEFORE)
  ledger.add({
    brief: 'after the base',
    repo,
    branch: 'feat/next',
    checkCmd: null,
    model: null,
    after: [waitedOn],
    issue: null,
  })
  const unread = finish('unread', BEFORE)
  const reading: PrLookup = async (url) => {
    if (url === `${PR}${unread}`) throw new Error('tea exited 1')
    return lookup(url)
  }
  const head = git(repo, 'rev-parse', 'feat/elsewhere').trim()

  const swept = await sweep(ledger, home, Tmux.of(home), reading, NOW)

  expect(swept.done).toEqual([
    { id: pushedElsewhere, reason: `merged: ${PR}${pushedElsewhere}` },
    { id: viaTodo, reason: `merged: ${PR}${viaTodo}` },
  ])
  expect(swept.report).toEqual({ removed: [pushedElsewhere, viaTodo], clean: [], skipped: [] })
  expect(swept.unchecked).toEqual([{ id: unread, error: 'tea exited 1' }])
  for (const id of [rewritten, sameSecond, otherBranch, notMerged, stillOpen, errored, dropped]) {
    expect(ledger.get(id).collectedAt).toBeNull()
  }
  for (const id of [fork, otherRepo, otherHost, unknownRepo]) {
    expect(ledger.get(id).collectedAt).toBeNull()
  }
  expect(ledger.get(waitedOn).collectedAt).toBeNull()
  // The only copy of the commits stays on the branch, and resume finds it there.
  const cwd = workspaceOf(home, ledger.get(pushedElsewhere))
  expect(existsSync(cwd)).toBe(false)
  expect(git(repo, 'rev-parse', 'feat/elsewhere').trim()).toBe(head)
  await restore(ledger, home, pushedElsewhere)
  expect(readFileSync(join(cwd, 'elsewhere.txt'), 'utf8')).toBe('elsewhere')
  expect(ledger.get(pushedElsewhere).collectedAt).toBeNull()
}, 30_000)

test('such a task waits on another linked pull request as a pushed task does, unless it is closed or the person approved it since the task was added, and age does not end the wait', async () => {
  const { home, ledger, prs, lookup, finish } = unpushedTasks()
  const alsoLinked = (name: string, pr: Partial<PullRequest> = {}): number => {
    const id = finish(name, BEFORE)
    prs.set(`${PR}${id}-also`, { ...OPEN, ...pr })
    ledger.link(id, [`${PR}${id}-also`])
    return id
  }
  const open = alsoLinked('also-open')
  const approvedBefore = alsoLinked('also-approved-before', { approvedAt: OLD })
  const approved = alsoLinked('also-approved', { approvedAt: '2099-01-01T00:00:00Z' })
  const closed = alsoLinked('also-closed', { state: 'closed' })
  const later = new Date(Date.now() + 8 * 86_400_000)

  const swept = await sweep(ledger, home, Tmux.of(home), lookup, later)

  expect(swept.done).toEqual([
    { id: approved, reason: `merged: ${PR}${approved}` },
    { id: closed, reason: `merged: ${PR}${closed}` },
  ])
  expect(ledger.get(open).collectedAt).toBeNull()
  expect(ledger.get(approvedBefore).collectedAt).toBeNull()
}, 30_000)

test('such a task waits while the address of origin, where nod pushes, is missing or one nod cannot read', async () => {
  const { home, ledger, repo, git, lookup, finish } = unpushedTasks()
  const id = finish('no-origin', BEFORE)
  const done = async () => (await doneTasks(ledger, Tmux.of(home), lookup, NOW)).done

  git(repo, 'config', 'remote.origin.url', '/srv/repos/r')
  expect(await done()).toEqual([])
  git(repo, 'config', '--unset', 'remote.origin.url')
  expect(await done()).toEqual([])
  git(repo, 'config', 'remote.origin.url', 'https://git.example.com/o/r.git')
  expect(await done()).toEqual([{ id, reason: `merged: ${PR}${id}` }])
}, 30_000)

test("with pushurls on origin, the pull request's head is one of theirs, not origin's url", async () => {
  const { home, ledger, repo, git, lookup, finish } = unpushedTasks()
  const id = finish('pushurl', BEFORE)
  const done = async () => (await doneTasks(ledger, Tmux.of(home), lookup, NOW)).done

  // Pushes go to a fork: the pull request from the branch in origin's url is someone else's.
  git(repo, 'config', 'remote.origin.pushurl', 'git@git.example.com:me/r.git')
  expect(await done()).toEqual([])
  // Any of several pushurls.
  git(repo, 'config', '--add', 'remote.origin.pushurl', 'git@git.example.com:o/r.git')
  expect(await done()).toEqual([{ id, reason: `merged: ${PR}${id}` }])
  // Origin's url another repo, its pushurl this one.
  git(repo, 'config', 'remote.origin.url', 'https://git.example.com/upstream/r')
  git(repo, 'config', '--unset', 'remote.origin.pushurl', 'me/r')
  expect(await done()).toEqual([{ id, reason: `merged: ${PR}${id}` }])
  // An empty pushurl drops those before it (git 2.46 and later): pushes go only to the fork.
  git(repo, 'config', '--add', 'remote.origin.pushurl', '')
  git(repo, 'config', '--add', 'remote.origin.pushurl', 'git@git.example.com:me/r.git')
  expect(await done()).toEqual([])
}, 30_000)

test('a signature that log.showSignature prints does not hide the last commit time', async () => {
  const { home, ledger, repo, git, lookup, finish } = unpushedTasks()
  sh(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(home, 'key')], home)
  git(repo, 'config', 'gpg.format', 'ssh')
  git(repo, 'config', 'user.signingKey', join(home, 'key'))
  git(repo, 'config', 'commit.gpgSign', 'true')
  git(repo, 'config', 'log.showSignature', 'true')
  const id = finish('signed', BEFORE)

  const swept = await sweep(ledger, home, Tmux.of(home), lookup, NOW)

  expect(swept.done).toEqual([{ id, reason: `merged: ${PR}${id}` }])
})

test('a git log that fails is reported on the task with commits no remote has, and holds back no other', async () => {
  const { home, ledger, repo, git, lookup, finish } = unpushedTasks()
  const unpushed = finish('unpushed', BEFORE)
  const pushed = finish('pushed', BEFORE)
  git(repo, 'update-ref', 'refs/remotes/origin/feat/pushed', 'feat/pushed')
  git(repo, 'config', 'log.date', 'nonsense')

  const swept = await sweep(ledger, home, Tmux.of(home), lookup, NOW)

  expect(swept.done).toEqual([{ id: pushed, reason: `merged: ${PR}${pushed}` }])
  expect(swept.unchecked).toEqual([{ id: unpushed, error: expect.stringContaining('git log in') }])
})

function sh(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}
