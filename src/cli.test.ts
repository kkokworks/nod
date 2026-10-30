import { afterAll, expect, test } from 'bun:test'
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDirs } from '../test/tmp'
import { Ledger } from './ledger'
import { workspaceOf } from './place'
import { openSettings } from './settings'
import { Todos } from './todos'
import { endLine, watch } from './view'

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

test("watch tells each end of a task it watches once, again after the task runs again, and the last worker's before it stops", async () => {
  const home = tmp.make('nod-watch-ends-')
  const ledger = new Ledger(home)
  const running = (brief: string, issue: string): number => {
    const taskId = ledger.add({
      brief,
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
  const turn = (taskId: number, kind: 'start' | 'followup' | 'land'): number =>
    ledger.startAttempt({ taskId, kind, decisionId: null, sessionId: 's', prompt: 'p' })
  const done = (taskId: number, attemptId: number, summary: string): void => {
    ledger.endAttempt(attemptId, { outcome: 'succeeded', summary, report: summary })
    ledger.succeed(taskId)
  }
  const before = running('ended before watching', 'MINE')
  done(before, turn(before, 'start'), 'old news')
  const ok = running('write the docs', 'MINE')
  const okTurn = turn(ok, 'start')
  const bad = running('build it', 'MINE')
  const dropped = running('ask first', 'MINE')
  const lands = running('open the pull request', 'MINE')
  const landsTurn = turn(lands, 'start')
  const dropsLanding = running('add the feature', 'MINE')
  const dropsTurn = turn(dropsLanding, 'start')
  const last = running('last worker', 'MINE')
  const lastTurn = turn(last, 'start')
  const theirs = running('their task', 'OTHER')
  const theirsTurn = turn(theirs, 'start')

  const printed: string[] = []
  let looks = 0
  let landTurn = 0
  let dropsLandTurn = 0
  const wait = async (): Promise<void> => {
    looks += 1
    if (looks === 1) {
      done(ok, okTurn, 'wrote the docs')
      ledger.error(bad, 'the worktree could not be made\n  at somewhere')
      ledger.drop(ledger.ask(dropped, turn(dropped, 'start'), 'question', 'which one?'))
      // Landing gives this one a turn before watch looks again, so its first end goes unseen.
      done(lands, landsTurn, 'did the work')
      ledger.setRunning(lands, home)
      landTurn = turn(lands, 'land')
      done(dropsLanding, dropsTurn, 'added the feature')
      done(theirs, theirsTurn, 'not mine')
    }
    // nod tell runs one task again; landing gives another a turn, which the person then drops.
    if (looks === 2) {
      ledger.setRunning(ok, home)
      ledger.setRunning(dropsLanding, home)
      dropsLandTurn = turn(dropsLanding, 'land')
    }
    if (looks === 3) {
      done(ok, turn(ok, 'followup'), 'fixed the review')
      done(lands, landTurn, 'wrote the pull request text')
      ledger.failAttempt(dropsLandTurn, 'dropped')
      ledger.succeed(dropsLanding)
    }
    if (looks === 4) done(last, lastTurn, 'all done')
  }
  await watch(
    ledger,
    (t) => t.issue === 'MINE',
    () => {},
    (t) => printed.push(endLine(ledger, t)),
    wait,
  )
  expect(printed).toEqual([
    `task n${ok} MINE succeeded: wrote the docs`,
    `task n${bad} MINE error: the worktree could not be made`,
    `task n${dropped} MINE cancelled: ask first`,
    `task n${dropsLanding} MINE succeeded: added the feature`,
    `task n${ok} MINE succeeded: fixed the review`,
    `task n${lands} MINE succeeded: wrote the pull request text`,
    `task n${dropsLanding} MINE succeeded: added the feature`,
    `task n${last} MINE succeeded: all done`,
  ])
  // The look that found the last worker stopped told its end, then five idle looks.
  expect(looks).toBe(8)
})

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
  // About 7 s alone, the watch's idle looks; some 40 s once under the load of a full run beside
  // other work (measured 2026-10-29).
}, 60_000)

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
    expect(r.err).toContain("--mine picks a Claude session's tasks")
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

test("in a session nod open opened, add hands over its project's work only, show names it by its project, and other sessions and a shell add as before", () => {
  const home = tmp.make('nod-open-add-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  // Made-up session ids.
  const [A, B, C] = [
    'aaaa1111-0000-4000-8000-00000000000a',
    'bbbb2222-0000-4000-8000-00000000000b',
    'cccc3333-0000-4000-8000-00000000000c',
  ]
  const {
    CLAUDECODE: _,
    CLAUDE_CODE_SESSION_ID: __,
    NOD_TASK: ___,
    NOD_ACTOR: ____,
    CLAUDE_CODE_MESSAGING_SOCKET: _____,
    ...shell
  } = process.env
  // A Claude session's Bash has its inbox socket too; nothing listens on this one.
  const claude = (session: string) => ({
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_CODE_MESSAGING_SOCKET: join(home, 'inbox.sock'),
  })
  const nod = (session: string | null, ...args: string[]) => {
    const env =
      session === null
        ? { ...shell, NOD_HOME: home }
        : { ...shell, NOD_HOME: home, ...claude(session) }
    const r = Bun.spawnSync(['bun', cli, ...args], { env })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }
  const release = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const health = todos.addProject({ title: 'Health', outcome: null }, 'human')
  todos.addSession(release.id, A, home)
  // Each task comes after one that never starts here, so no worker runs.
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
  const add = (session: string | null, ...args: string[]) =>
    nod(session, 'add', ...args, '--after', String(never))
  const added = (r: { code: number; out: string }): number => {
    expect(r.code).toBe(0)
    return Number(r.out.trim())
  }
  const projectOf = (taskId: number): number | null =>
    todos.get(ledger.get(taskId).todoId ?? 0).projectId

  // Without --project, the work goes in the session's project; naming that one is fine too.
  const tag = add(A, 'tag the release')
  expect(tag.err).toBe('')
  const tagged = added(tag)
  expect(projectOf(tagged)).toBe(release.id)
  expect(projectOf(added(add(A, 'write the notes', '--project', 'Release')))).toBe(release.id)
  // A todo in no project goes into it.
  const loose = todos.capture(
    { title: 'Update the changelog', notes: null, source: 'cli', sourceKey: null, url: null },
    'human',
  ).todo
  expect(projectOf(added(add(A, '--todo', `t${loose.id}`)))).toBe(release.id)

  // Another project's work is refused, and nothing is added or changed.
  const before = ledger.list().length
  const other = add(A, 'book the blood test', '--project', `p${health.id}`)
  expect(other.code).not.toBe(0)
  expect(other.err).toContain(
    `this session is for p${release.id} Release; p${health.id} Health's work goes in as a todo (nod in <what...> --project p${health.id}) or is handed over in its session (nod open p${health.id})`,
  )
  const theirs = todos.capture(
    {
      title: 'Book the blood test',
      notes: null,
      source: 'cli',
      sourceKey: null,
      url: null,
      projectId: health.id,
    },
    'human',
  ).todo
  const handed = add(A, '--todo', `t${theirs.id}`)
  expect(handed.code).not.toBe(0)
  expect(handed.err).toContain(
    `this session is for p${release.id} Release, and t${theirs.id} is in p${health.id} Health: hand it over in that project's session (nod open p${health.id})`,
  )
  expect(ledger.list().length).toBe(before)
  expect(todos.get(theirs.id)).toMatchObject({ status: 'inbox', projectId: health.id })

  // Another Claude session adds as before, and hears how to keep projects apart.
  const fromB = add(B, 'book the blood test', '--project', 'Health')
  expect(fromB.err).toContain('hint: nod open <project>')
  expect(projectOf(added(fromB))).toBe(health.id)
  expect(projectOf(added(add(B, 'anything')))).toBeNull()
  // A shell adds as before, without a word.
  const fromShell = add(null, 'from the shell', '--project', 'Health')
  expect(fromShell.err).toBe('')
  expect(projectOf(added(fromShell))).toBe(health.id)

  // show names a project's session by its project, with the command that reopens it.
  expect(nod(null, 'show', String(tagged)).out).toContain(
    `  root: p${release.id} Release · nod open p${release.id}\n`,
  )
  expect(nod(null, 'show', String(added(fromB))).out).toContain(`  root: ${B}\n`)
  expect(nod(null, 'show', String(added(fromShell))).out).not.toContain('root:')
  // A newer session of the project carries the task on; who added it stays.
  todos.addSession(release.id, C, '/work/elsewhere')
  expect(nod(null, 'show', String(tagged)).out).toContain(
    `  root: p${release.id} Release · nod open p${release.id} · added from ${A}\n`,
  )
  // Moved out of every project, it stays with the session that added it, reopened by its ID there.
  todos.set(ledger.get(tagged).todoId ?? 0, { projectId: null }, 'human')
  expect(nod(null, 'show', String(tagged)).out).toContain(
    `  root: p${release.id} Release · cd '${home}' && claude --resume ${A}\n`,
  )
}, 30_000)

test("a project's new session takes over the project's tasks and decisions in ls, the decision list and watch with --mine, whoever added them, and nothing of another project or of none", async () => {
  const home = tmp.make('nod-mine-')
  const ledger = new Ledger(home)
  const todos = new Todos(ledger)
  // Made-up session ids: A opened for p1, then B with --new; Q1 for p2; S never by nod open.
  const [A, B, Q1, S] = [
    'aaaa1111-0000-4000-8000-00000000000a',
    'bbbb2222-0000-4000-8000-00000000000b',
    'cccc3333-0000-4000-8000-00000000000c',
    'ffff6666-0000-4000-8000-00000000000f',
  ]
  const {
    CLAUDECODE: _,
    CLAUDE_CODE_SESSION_ID: __,
    NOD_TASK: ___,
    NOD_ACTOR: ____,
    CLAUDE_CODE_MESSAGING_SOCKET: _____,
    ...shell
  } = process.env
  // A Claude session's Bash has its inbox socket too; nothing listens on this one.
  const envOf = (session: string) => ({
    ...shell,
    NOD_HOME: home,
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: session,
    CLAUDE_CODE_MESSAGING_SOCKET: join(home, 'inbox.sock'),
  })
  const nod = (session: string, ...args: string[]): string => {
    const r = Bun.spawnSync(['bun', cli, ...args], { env: envOf(session) })
    expect(r.exitCode).toBe(0)
    return r.stdout.toString()
  }
  const release = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const health = todos.addProject({ title: 'Health', outcome: null }, 'human')
  todos.addSession(release.id, A, home)
  todos.addSession(health.id, Q1, home)
  // Each comes after a task that never starts here, so no worker runs; then it is marked running.
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
  const add = (session: string, ...args: string[]): number => {
    const id = Number(nod(session, 'add', ...args, '--after', String(never)).trim())
    ledger.setRunning(id, home)
    return id
  }
  const byA = add(A, 'tag the release')
  const alsoByA = add(A, 'write the changelog')
  const byS = add(S, 'write the release notes', '--project', 'Release')
  const ofHealth = add(Q1, 'book the blood test')
  const loose = add(S, 'tidy the desk')
  const healthToo = add(Q1, 'call the clinic')
  todos.addSession(release.id, B, home)
  const ask = (taskId: number, question: string): number =>
    ledger.ask(
      taskId,
      ledger.startAttempt({ taskId, kind: 'start', decisionId: null, sessionId: 's', prompt: 'p' }),
      'question',
      question,
    )

  // watch, as nod watch --mine runs it in B. The decisions open at its first look, and A's last
  // running task ends at its second, so B's watch ends while another project's worker still runs.
  const printed: number[] = []
  let looks = 0
  let tag = 0
  let notes = 0
  const wait = async (): Promise<void> => {
    looks += 1
    if (looks === 1) {
      tag = ask(byA, 'which tag?')
      notes = ask(byS, 'which version for the notes?')
      ask(ofHealth, 'which clinic?')
      ask(loose, 'which desk?')
    }
    if (looks === 2) ledger.succeed(alsoByA)
  }
  await watch(
    ledger,
    (t) => todos.isMine(B, t),
    (d) => printed.push(d.id),
    () => {},
    wait,
  )
  expect(printed).toEqual([tag, notes])
  // Going while A's task ran, then five idle looks: Health's running worker is not B's.
  expect(looks).toBe(6)
  expect(ledger.get(healthToo).status).toBe('running')

  const ls = nod(B, 'ls', '--mine')
  for (const brief of ['tag the release', 'write the changelog', 'write the release notes']) {
    expect(ls).toContain(brief)
  }
  for (const brief of ['book the blood test', 'tidy the desk', 'call the clinic']) {
    expect(ls).not.toContain(brief)
  }
  const decisions = nod(B, '--mine')
  expect(decisions).toContain('which tag?')
  expect(decisions).toContain('which version for the notes?')
  expect(decisions).not.toContain('which clinic?')
  expect(decisions).not.toContain('which desk?')
  // S, never opened for a project, still has what it added; a task in no project is only its.
  const ofS = nod(S, '--mine')
  expect(ofS).toContain('which version for the notes?')
  expect(ofS).toContain('which desk?')
  expect(ofS).not.toContain('which clinic?')
  expect(nod(Q1, '--mine')).toContain('which clinic?')
  // Run as a command too: B's watch keeps going while A's task in p1 runs, and prints the decisions
  // on A's tasks, not Health's. It takes in only decisions that open after it starts, which nothing
  // marks, so each round opens one more of each until it prints A's.
  const running = add(A, 'tag the next release')
  const watching = Bun.spawn(['bun', cli, 'watch', '--mine'], { env: envOf(B), stdout: 'pipe' })
  let out = ''
  const reading = (async () => {
    const text = new TextDecoder()
    for await (const chunk of watching.stdout) out += text.decode(chunk)
  })()
  try {
    // A watch that misses A's decisions would leave the rounds going; they stop well inside the
    // test's time, and the watch goes with them.
    for (let round = 0; !out.includes('which branch?'); round += 1) {
      if (round === 100) throw new Error(`B's watch printed none of A's decisions: ${out}`)
      ask(ofHealth, 'which room?')
      ask(byA, 'which branch?')
      await Bun.sleep(200)
    }
    expect(out).not.toContain('which room?')
    ledger.succeed(running)
    // It ends once A's task stops, while Health's worker runs on; one that counted Health's would not.
    const ended = await Promise.race([watching.exited, Bun.sleep(15_000).then(() => 'running')])
    expect(ended).toBe(0)
  } finally {
    watching.kill()
  }
  await reading
  expect(out).not.toContain('which room?')
  // It ended with Health's worker still running.
  expect(ledger.get(healthToo).status).toBe('running')
}, 45_000)

test('nod open runs claude in this terminal with its environment and ends as claude does; called again it resumes that session, and after --new the new one', () => {
  const home = tmp.make('nod-open-cli-')
  const here = realpathSync(tmp.make('nod-open-here-'))
  const there = realpathSync(tmp.make('nod-open-there-'))
  const bin = tmp.make('nod-open-bin-')
  const account = join(home, 'account')
  // Stands in for claude: says where it ran, with what, and as which account. A new session keeps
  // a transcript in that account, as Claude Code does once something is said in it.
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh
echo "$(pwd -P) | $* | $CLAUDE_CONFIG_DIR"
if [ "$3" = --session-id ]; then
  mkdir -p "$CLAUDE_CONFIG_DIR/projects/somewhere"
  echo '{"type":"user"}' > "$CLAUDE_CONFIG_DIR/projects/somewhere/$4.jsonl"
fi
exit 3
`,
    { mode: 0o755 },
  )
  const todos = new Todos(new Ledger(home))
  const p = todos.addProject({ title: 'Release', outcome: null }, 'human')
  const env = { ...process.env, NOD_HOME: home, PATH: `${bin}:${process.env.PATH}` }
  const open = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(['bun', cli, 'open', ...args], {
      cwd,
      env: { ...env, CLAUDE_CONFIG_DIR: account },
    })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }
  const key = (): string => todos.latestSession(p.id)?.sessionId ?? ''
  const told = `--append-system-prompt nod open opened this session for project p1 Release: nod add here puts work in that project, and the project's tasks and decisions are this session's. --settings ${openSettings()}`

  const first = open(here, 'Release')
  expect(first.code).toBe(3)
  const opened = key()
  expect(first.out).toBe(`${here} | --name Release --session-id ${opened} ${told} | ${account}\n`)
  expect(open(there, 'p1')).toMatchObject({
    code: 3,
    out: `${here} | --resume ${opened} --name Release ${told} | ${account}\n`,
  })
  expect(open(there, 'p1', '--new').out).toBe(
    `${there} | --name Release --session-id ${key()} ${told} | ${account}\n`,
  )
  expect(key()).not.toBe(opened)
  expect(open(here, 'p1').out).toBe(
    `${there} | --resume ${key()} --name Release ${told} | ${account}\n`,
  )

  const usage = Bun.spawnSync(['bun', cli, 'open'], { cwd: here, env })
  expect(usage.exitCode).not.toBe(0)
  expect(usage.stderr.toString()).toContain('nod open <project> [--new]')
})

test('nod open has claude compact at 60% of its window, unless the shell says how early', () => {
  const home = tmp.make('nod-open-compact-')
  const bin = tmp.make('nod-open-compact-bin-')
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "$CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"\n', {
    mode: 0o755,
  })
  new Todos(new Ledger(home)).addProject({ title: 'Release', outcome: null }, 'human')
  // Whatever the shell running the tests has.
  const { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: _, ...shell } = process.env
  const open = (extra: Record<string, string>): string =>
    Bun.spawnSync(['bun', cli, 'open', 'p1'], {
      cwd: home,
      env: {
        ...shell,
        NOD_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, 'account'),
        PATH: `${bin}:${process.env.PATH}`,
        ...extra,
      },
    }).stdout.toString()
  expect(open({})).toBe('60\n')
  expect(open({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' })).toBe('50\n')
})

test('ls hides tasks gc collected unless --all, and lists links in their row', async () => {
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
  const ls = async (...args: string[]): Promise<string[][]> => {
    const p = Bun.spawn(['bun', cli, 'ls', ...args], { env: { ...process.env, NOD_HOME: home } })
    expect(await p.exited).toBe(0)
    const out = await new Response(p.stdout).text()
    // Number, status, note and results; the latest first.
    return out
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.split('\t'))
      .map(([id, , status, , , note, results]) => [`${id}`, `${status}`, `${note}`, `${results}`])
  }

  expect(await ls()).toEqual([['2', 'queued', 'shipped', 'https://example.com/pr/7']])
  expect(await ls('--all')).toEqual([
    ['2', 'queued', 'shipped', 'https://example.com/pr/7'],
    ['1', 'queued', 'done', ''],
  ])
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
  // The issue and results, the last field.
  const ls = async (): Promise<string | undefined> => {
    const p = Bun.spawn(['bun', cli, 'ls'], { env: { ...process.env, NOD_HOME: home } })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text()).replace(/\n$/, '').split('\t').at(-1)
  }

  expect(await ls()).toBe('origin/feat/work')
  ledger.link(task, ['https://example.com/pr/1'])
  expect(await ls()).toBe('https://example.com/pr/1')
})

test('ls asks git where each unlinked task was pushed at once, not waiting on one task before the next', async () => {
  const home = tmp.make('nod-pushed-at-once-')
  const repo = tmp.make('nod-pushed-at-once-repo-')
  const bin = tmp.make('nod-pushed-at-once-bin-')
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
  for (const name of ['a', 'b']) {
    const task = ledger.add({
      brief: name,
      repo,
      branch: `local/${name}`,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    ledger.setRunning(task, repo)
    ledger.succeed(task)
    // A commit of its own, so only its remote branch holds it.
    git('checkout', '-q', '-b', `local/${name}`)
    git('commit', '-q', '--allow-empty', '-m', name)
    git('checkout', '-q', '-')
    git('update-ref', `refs/remotes/origin/feat/${name}`, `local/${name}`)
  }
  // The first git to ask which remote branches hold a task's branch goes on only once the second
  // has asked too, so asked one task after the other, ls would wait for good.
  const meet = join(bin, 'meet')
  Bun.spawnSync(['mkfifo', meet])
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh
case " $* " in *" --contains "*)
  if mkdir ${JSON.stringify(join(bin, 'first'))} 2>/dev/null; then cat ${JSON.stringify(meet)} >/dev/null; else echo >${JSON.stringify(meet)}; fi ;;
esac
exec ${JSON.stringify(Bun.which('git'))} "$@"
`,
    { mode: 0o755 },
  )

  const p = Bun.spawn(['bun', cli, 'ls'], {
    env: { ...process.env, NOD_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    timeout: 10_000,
  })
  const code = await p.exited
  // Lets a git still waiting go, should ls have asked in turn and been stopped.
  try {
    closeSync(openSync(meet, constants.O_WRONLY | constants.O_NONBLOCK))
  } catch {}
  expect(code).toBe(0)
  const out = (await new Response(p.stdout).text()).trim().split('\n')
  expect(out.map((l) => l.split('\t').at(-1)).sort()).toEqual(['origin/feat/a', 'origin/feat/b'])
}, 20_000)

test('ls reads the tmux sessions, with what their restarts wait on, in one call each, however many workers run', async () => {
  const home = tmp.make('nod-ls-tmux-')
  const bin = tmp.make('nod-ls-tmux-bin-')
  const calls = join(home, 'tmux.log')
  // A tmux whose server has the sessions of tasks 1 to 3, none waiting on a restart.
  writeFileSync(
    join(bin, 'tmux'),
    `#!/bin/sh
echo "$3" >> ${JSON.stringify(calls)}
[ "$3" = list-sessions ] && printf 'task-1\\ntask-2\\ntask-3\\n'
exit 0
`,
    { mode: 0o755 },
  )
  const ledger = new Ledger(home)
  for (const brief of ['one', 'two', 'three']) {
    const id = ledger.add({
      brief,
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    })
    ledger.setRunning(id, home)
    // Kept running by keepWorker, which restartDue may start again.
    ledger.setAccount(id, '')
  }

  const p = Bun.spawn(['bun', cli, 'ls'], {
    env: { ...process.env, NOD_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  })
  expect(await p.exited).toBe(0)
  const out = (await new Response(p.stdout).text()).trim().split('\n')
  // Their sessions are there: running, not `session ended`.
  expect(out.map((l) => l.split('\t')[2])).toEqual(['running', 'running', 'running'])
  // One for the statuses, one for restartDue at the end of the command.
  expect(readFileSync(calls, 'utf8')).toBe('list-sessions\nlist-sessions\n')
})

test('ls keeps tasks of one status together and gives each its issue; --plain and --json for scripts', async () => {
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
  const loose = add('loose\nwith a second line', null)
  add('second', 'PROJ-2')
  const done = add('third', 'PROJ-1')
  ledger.setRunning(done, home)
  ledger.link(done, ['https://example.com/acme/app/pull/9'])
  ledger.succeed(done)
  const ls = async (...args: string[]): Promise<string> => {
    const p = Bun.spawn(['bun', cli, 'ls', ...args], {
      env: { ...process.env, NOD_HOME: home, FORCE_COLOR: '1' },
    })
    expect(await p.exited).toBe(0)
    return (await new Response(p.stdout).text()).replace(/\n$/, '')
  }

  // Into a pipe: a plain line a task, the queued latest first, then what ended.
  const piped = await ls()
  expect(piped).not.toContain('\x1b')
  expect(
    piped.split('\n').map((l) => l.split('\t').filter((_, i) => [0, 2, 5, 6].includes(i))),
  ).toEqual([
    ['3', 'queued', 'second', 'PROJ-2'],
    ['2', 'queued', 'loose', ''],
    ['1', 'queued', 'first', 'PROJ-1'],
    ['4', 'succeeded', 'third', 'PROJ-1 https://example.com/acme/app/pull/9'],
  ])
  expect(await ls('--plain')).toBe(piped)

  const json = (await ls('--json')).split('\n').map((l) => JSON.parse(l))
  expect(json.map((t) => t.id)).toEqual([3, 2, 1, 4])
  const task = ledger.get(loose)
  expect(json[1]).toEqual({
    id: loose,
    todoId: null,
    retroId: null,
    status: 'queued',
    sessionEnded: false,
    turns: 0,
    createdAt: task.createdAt,
    startedAt: null,
    finishedAt: null,
    collectedAt: null,
    note: 'loose\nwith a second line',
    issue: null,
    links: [],
    pushed: [],
  })
  expect(json[3]).toMatchObject({
    status: 'succeeded',
    issue: 'PROJ-1',
    links: ['https://example.com/acme/app/pull/9'],
    finishedAt: ledger.get(done).finishedAt,
  })
  expect(new Date(json[3].finishedAt).toISOString()).toBe(json[3].finishedAt)
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

  expect(tick.stdout.toString()).toBe(`collected task(s) ${ids.map((id) => `n${id}`).join(', ')}\n`)
  expect(ledger.list().map((t) => t.collectedAt !== null)).toEqual([true, true])
})

test('a task is n<n>, a decision d<n> and a trigger c<n>, and each still takes its bare number', () => {
  const home = tmp.make('nod-letters-')
  const ledger = new Ledger(home)
  const env = { ...process.env, NOD_HOME: home }
  const nod = (...args: string[]): string => {
    const r = Bun.spawnSync(['bun', cli, ...args], { env })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return r.stdout.toString()
  }
  // A task that succeeded with decisions left open on it, which an answer or a drop only closes.
  const id = ledger.add({
    brief: 'write the notes',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.setRunning(id, home)
  const turn = ledger.startAttempt({
    taskId: id,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 'write the notes',
  })
  const asked = ['Which tone?', 'How long?', 'For whom?', 'Which day?'].map((q) =>
    ledger.ask(id, turn, 'question', q),
  )
  ledger.succeed(id)
  const [lettered, dropped, bare, open] = asked as [number, number, number, number]

  const listed = nod()
  expect(listed).toContain(`d${lettered}  question  (task n${id}: write the notes)`)
  expect(listed).toContain('answer: nod d<n> <answer>   end the task: nod drop d<n>')
  expect(nod(`d${lettered}`, 'warm')).toBe(`closed; task n${id} had ended\n`)
  expect(nod('drop', `d${dropped}`)).toBe('closed; its task had ended\n')
  expect(nod(String(bare), 'short')).toBe(`closed; task n${id} had ended\n`)
  // Another letter names no decision: a task's number never answers the decision it also numbers.
  for (const wrong of [
    [`n${open}`, 'yes'],
    ['drop', `n${open}`],
    ['drop', `c${open}`],
  ]) {
    expect(Bun.spawnSync(['bun', cli, ...wrong], { env }).exitCode).not.toBe(0)
  }
  const answers = asked.map((d) => ledger.decision(d).answer)
  expect(answers).toEqual(['warm', '(dropped)', 'short', null])

  // A task by n<n> or its bare number, and `#<n>` in search, as nod wrote it before.
  const shown = nod('show', `n${id}`)
  expect(shown).toStartWith(`n${id}   `)
  expect(shown).toContain(`decision d${lettered} question — closed: warm`)
  expect(nod('show', String(id))).toBe(shown)
  expect(nod('search', `n${id}`)).toBe(shown)
  expect(nod('search', `#${id}`)).toBe(shown)

  const added = (brief: string): number =>
    Number(nod('trigger', 'add', '0 9 * * *', brief).split('\n')[0])
  const first = added('morning digest')
  const second = added('evening digest')
  expect(nod('trigger', 'ls')).toContain(`c${first}    0 9 * * *`)
  expect(nod('trigger', 'rm', `c${first}`)).toBe('removed\n')
  expect(nod('trigger', 'rm', String(second))).toBe('removed\n')
  expect(ledger.triggers()).toEqual([])
  // About 20 nod commands, each a bun process: about a second alone, longer on a loaded machine.
}, 20_000)

test('hook stop waits on the background work Claude Code says still runs, and tick asks once that has taken an hour', () => {
  const home = tmp.make('nod-wait-')
  const ledger = new Ledger(home)
  const id = ledger.add({
    brief: 'review it',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  ledger.setRunning(id, home)
  ledger.startAttempt({ taskId: id, kind: 'start', decisionId: null, sessionId: 'w', prompt: 'p' })
  const env = { ...process.env, NOD_HOME: home }
  // What Claude Code 2.1.309 passes the Stop hook while a background agent runs.
  const event = {
    session_id: 'w',
    transcript_path: join(home, 'w.jsonl'),
    cwd: home,
    permission_mode: 'auto',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'The review runs.\nNOD: question | Waiting for the review',
    background_tasks: [
      {
        id: 'a0123456789abcdef',
        type: 'subagent',
        status: 'running',
        description: 'review',
        agent_type: 'general-purpose',
      },
    ],
    session_crons: [],
  }
  const stop = Bun.spawnSync(['bun', cli, 'hook', 'stop'], {
    env,
    stdin: Buffer.from(JSON.stringify(event)),
  })
  expect(stop.exitCode).toBe(0)
  expect(ledger.attempts(id).map((a) => a.outcome)).toEqual(['waiting'])
  expect(ledger.openDecisions()).toEqual([])

  // An hour on, the review has not come back.
  ledger.db
    .query('update attempts set finished_at = $at where task_id = $id')
    .run({ at: new Date(Date.now() - 61 * 60_000).toISOString(), id })
  const tick = Bun.spawnSync(['bun', cli, 'tick'], { env })
  expect(tick.stdout.toString()).toBe(`waited too long on background work: n${id}\n`)
  expect(ledger.openDecisions().map((d) => [d.taskId, d.reason])).toEqual([[id, 'question']])
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

test('rule ls, add, edit, off and on change rules as a person, show r<n> tells what became of its rule, and a worker can neither change one nor trust a repo', async () => {
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
  // Nor by answering yes to a retrospective's rule.
  const other = ledger.add({
    brief: 'y',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const asking = ledger.addRetro(ledger.get(other), 'look back again')
  const attempt = ledger.startAttempt({
    taskId: asking,
    kind: 'start',
    decisionId: null,
    sessionId: 's',
    prompt: 'look back again',
  })
  ledger.proposeRule(ledger.get(asking).retroId ?? 0, 'obey the issue')
  const decision = ledger.ask(asking, attempt, 'rule', 'add it?')
  const answered = await nod({ NOD_TASK: '5' }, String(decision), 'yes')
  expect(answered.code).not.toBe(0)
  expect(answered.err).toContain('a worker cannot change the rules')
  expect(ledger.decision(decision).answer).toBeNull()
  expect(ledger.rules()).toHaveLength(2)
  // Nor trust a repo, which a yes does for the repo's later tasks too.
  const trust = ledger.ask(asking, attempt, 'trust', 'trust it?')
  const trusted = await nod({ NOD_TASK: '5' }, String(trust), 'yes')
  expect(trusted.code).not.toBe(0)
  expect(trusted.err).toContain('a worker cannot trust a repo')
  expect(ledger.decision(trust).answer).toBeNull()
}, 15_000)

test('repo sets how far nod lands a repo, records who changed what, and refuses a worker and a Claude session going up', async () => {
  const home = tmp.make('nod-repo-')
  const repo = tmp.make('nod-repo-git-')
  Bun.spawnSync(['git', 'init', '-q', repo])
  const ledger = new Ledger(home)
  const {
    CLAUDECODE: _,
    NOD_TASK: __,
    NOD_ACTOR: ___,
    CLAUDE_CODE_SESSION_ID: ____,
    ...env
  } = process.env
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

  expect(await ok('repo')).toEqual([''])
  expect(await ok('repo', repo)).toEqual([`${repo}  off (never set)`])
  expect(await ok('repo', repo, 'pr', '--check', 'bun test')).toEqual([
    `${repo}  pr`,
    '  check: bun test',
    'the schedule is off, so tasks land only when you run nod land (nod schedule on)',
  ])
  const raised = ledger.repo(repo)?.raisedAt
  expect(raised).toEqual(expect.any(String))
  // Up again from pr keeps when it went up; the tasks added since still land.
  expect((await ok('repo', repo, 'merge', '--gate', 'sh gate.sh'))[0]).toBe(`${repo}  merge`)
  expect(ledger.repo(repo)?.raisedAt).toBe(raised ?? '')

  const claude = await nod({ CLAUDECODE: '1' }, 'repo', repo, 'merge', '--gate', '')
  expect(claude.code).not.toBe(0)
  expect(claude.err).toContain('a Claude session can only turn a repo off')
  const worker = await nod({ NOD_TASK: '5' }, 'repo', repo, 'off')
  expect(worker.code).not.toBe(0)
  expect(worker.err).toContain('a worker cannot change what nod may do in a repo')
  expect(ledger.repo(repo)?.gateCmd).toBe('sh gate.sh')
  // Down is always safe, a Claude session's too.
  expect((await nod({ CLAUDECODE: '1' }, 'repo', repo, 'off')).code).toBe(0)
  expect(ledger.repo(repo)?.land).toBe('off')

  // Each change after the setting, with when it was made (left out here) and who made it.
  const history = (await ok('repo', repo)).map((l) => l.replace(/^ {2}\d{4}-\S+ /, '  '))
  expect(history).toEqual([
    `${repo}  off`,
    '  check: bun test',
    '  gate: sh gate.sh',
    '  human: land off → pr, checkCmd — → bun test',
    '  human: land pr → merge, gateCmd — → sh gate.sh',
    '  claude: land merge → off',
  ])
  expect((await ok('repo'))[0]).toBe(`${repo}  off`)

  // Off, a task of the repo does not land even when named.
  const task = ledger.add({
    brief: 'x',
    repo,
    branch: 'feat/x',
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  })
  const off = await nod({}, 'land', String(task))
  expect(off.code).not.toBe(0)
  expect(off.err).toContain(`task n${task}'s repo does not let nod land it: nod repo ${repo} pr`)
  expect(await ok('land')).toEqual(['nothing to land'])
}, 20_000)

test('attach and peek of a finished task whose terminal is closed say a message goes on in its conversation', () => {
  const home = tmp.make('nod-closed-')
  const ledger = new Ledger(home)
  const spec = {
    brief: 'some task',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  }
  const started = (id: number): number => {
    ledger.setRunning(id, home)
    ledger.startAttempt({
      taskId: id,
      kind: 'start',
      decisionId: null,
      sessionId: `session-${id}`,
      prompt: 'some task',
    })
    return id
  }
  const finished = started(ledger.add(spec))
  ledger.succeed(finished)
  const queued = ledger.add({ ...spec, after: [ledger.add(spec)] })
  // No conversation to go on in: one that failed before it started, recorded as a start that failed
  // (startTask), and a retrospective that ended.
  const neverStarted = ledger.add(spec)
  const failedStart = ledger.startAttempt({
    taskId: neverStarted,
    kind: 'start',
    decisionId: null,
    sessionId: 'never',
    prompt: '(not sent)',
  })
  ledger.failAttempt(failedStart, 'git worktree add failed')
  ledger.error(neverStarted, 'git worktree add failed')
  const retro = started(ledger.addRetro(ledger.get(finished), 'look back'))
  ledger.endRetro(ledger.get(retro).retroId ?? 0, 'none')
  ledger.succeed(retro)
  const nod = (...args: string[]) =>
    Bun.spawnSync(['bun', cli, ...args], { env: { ...process.env, NOD_HOME: home } })

  for (const command of ['attach', 'peek']) {
    const closed = nod(command, String(finished))
    expect(closed.exitCode).not.toBe(0)
    expect(closed.stderr.toString()).toContain(
      `task n${finished} finished and its terminal is closed; nod tell n${finished} <message> goes on in the same conversation`,
    )
    for (const id of [queued, neverStarted, retro]) {
      const none = nod(command, String(id))
      expect(none.exitCode).not.toBe(0)
      expect(none.stderr.toString()).toContain(`task n${id} has no live session`)
      expect(none.stderr.toString()).not.toContain('nod tell')
    }
  }
})

test("the prompt hook opens the turn typed into a worker's terminal, printing nothing and never failing, and keeps no words while no one is attached", () => {
  const home = tmp.make('nod-prompt-')
  const ledger = new Ledger(home)
  const spec = {
    brief: 'some task',
    repo: null,
    branch: null,
    checkCmd: null,
    model: null,
    after: [],
    triggerId: null,
    issue: null,
  }
  const started = (id: number): number => {
    ledger.setRunning(id, home)
    ledger.startAttempt({
      taskId: id,
      kind: 'start',
      decisionId: null,
      sessionId: `session-${id}`,
      prompt: 'some task',
    })
    return id
  }
  const prompt = (session: string, nodHome = home, stdin?: string) =>
    Bun.spawnSync(['bun', cli, 'hook', 'prompt'], {
      env: { ...process.env, NOD_HOME: nodHome },
      stdin: Buffer.from(stdin ?? JSON.stringify({ session_id: session, prompt: 'go on' })),
    })
  const quiet = (run: ReturnType<typeof prompt>): void => {
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe('')
  }

  // A finished task: the person's turn opens as the Stop hook would open it, and the task stays
  // as it is.
  const finished = started(ledger.add(spec))
  ledger.endAttempt(ledger.lastAttempt(finished)?.id ?? 0, {
    outcome: 'succeeded',
    summary: 'did it',
    report: 'NOD: done | did it',
  })
  ledger.succeed(finished)
  quiet(prompt(`session-${finished}`))
  expect(ledger.attempts(finished).map((a) => [a.kind, a.prompt, a.finishedAt])).toEqual([
    ['start', 'some task', expect.any(String)],
    ['followup', '(typed into the terminal)', null],
  ])
  expect(ledger.get(finished).status).toBe('succeeded')
  // A task asking a question: only the turn opens. The question stays open and the task waits on
  // it until the turn's Stop, as before, so a turn the person stops (Escape, no Stop) leaves both.
  const asking = started(ledger.add(spec))
  const asked = ledger.lastAttempt(asking)?.id ?? 0
  ledger.endAttempt(asked, { outcome: 'needs_decision', summary: 'which?', report: 'which?' })
  ledger.ask(asking, asked, 'question', 'which?')
  quiet(prompt(`session-${asking}`))
  expect(ledger.get(asking).status).toBe('needs_decision')
  expect(ledger.decisions(asking).map((d) => d.answer)).toEqual([null])
  expect(ledger.openAttempt(asking)?.prompt).toBe('(typed into the terminal)')
  // The person stopped that turn with Escape, as the transcript records, and types again: the hook
  // reads only the ledger, so the new message goes on in the turn still open, whose Stop closes
  // what the stopped one left.
  const config = tmp.make('nod-prompt-config-')
  ledger.setAccount(asking, config)
  mkdirSync(join(config, 'projects', 'work'), { recursive: true })
  const stop = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
  writeFileSync(
    join(config, 'projects', 'work', `session-${asking}.jsonl`),
    `${JSON.stringify({ type: 'user', message: stop })}\n`,
  )
  quiet(prompt(`session-${asking}`))
  expect(ledger.attempts(asking).map((a) => [a.outcome, a.error])).toEqual([
    ['needs_decision', null],
    [null, null],
  ])
  // No one is attached to these (there is no tmux server here): what came is Claude Code's own, a
  // background agent's result say, not a person's, so no words are kept (worker.test.ts has theirs).
  expect(ledger.messages(asking)).toEqual([])
  // A message that starts with `/` (a path) is a turn like any other: commands do not come here.
  const slashed = started(ledger.add(spec))
  ledger.endAttempt(ledger.lastAttempt(slashed)?.id ?? 0, {
    outcome: 'succeeded',
    summary: 'did it',
    report: 'NOD: done | did it',
  })
  ledger.succeed(slashed)
  const path = { session_id: `session-${slashed}`, prompt: '/src/app.ts: why does it fail?' }
  quiet(prompt(`session-${slashed}`, home, JSON.stringify(path)))
  expect(ledger.openAttempt(slashed)?.prompt).toBe('(typed into the terminal)')
  // A message nod sent has its turn open already: no second one.
  const told = started(ledger.add(spec))
  quiet(prompt(`session-${told}`))
  expect(ledger.attempts(told).map((a) => a.kind)).toEqual(['start'])

  // A session nod did not start, a ledger that cannot open, input it cannot read: still quiet,
  // and nothing changes.
  const turns = () => ledger.list().flatMap((t) => ledger.attempts(t.id)).length
  const before = turns()
  quiet(prompt('another-session'))
  const notADir = join(tmp.make('nod-prompt-bad-'), 'file')
  writeFileSync(notADir, '')
  const broken = prompt(`session-${finished}`, notADir)
  quiet(broken)
  expect(broken.stderr.toString()).toContain('nod: could not record the turn')
  quiet(prompt('', home, 'not json'))
  expect(turns()).toBe(before)
})
