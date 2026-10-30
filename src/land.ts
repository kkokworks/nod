import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { conflictBrief, createdFrom, NOD_GIT, ownStart, rebasing } from './branch'
import { askToLand } from './decisions'
import { hasRef, landed } from './gc'
import type { Landing, Ledger, Repo, Task } from './ledger'
import { notify, taskRef } from './notify'
import { sessionName } from './place'
import { message, OUTPUT_LIMIT, spawn } from './proc'
import { type GitService, type OwnPr, serviceOf } from './prs'
import { PR_TEXT, TEXT_ONLY } from './report'
import { running, type Terminals } from './tmux'
import { baseOf, handOff, restore, type Send } from './worker'

// Lands what the person lets nod land (`nod repo`): a repo task that succeeded goes onto the repo's
// default branch. nod does the fixed steps outside the worker's sandbox, which has no network and
// may not write some files a rebase touches: fetch, rebase onto the default branch, the check,
// the person's gate, push, the pull request, and at `merge` its squash merge. The worker, in its
// own conversation, does what needs judgment: a conflict, a check that fails after the rebase, the
// pull request's text (handOff in worker.ts, a `land` turn). What only the person can clear is a
// decision (askToLand). The tick runs it every fifth minute, and `nod land` now.

// The tick lands last but for its sweep, and the scheduler starts no tick while one runs, so a long
// check holds back the sweep and the next ticks' triggers and watches.
// ponytail: one cap per step; land in a process of its own if checks run longer than ticks may wait.
const CHECK_TIMEOUT_MS = 30 * 60_000
const GATE_TIMEOUT_MS = 5 * 60_000
// fetch and push reach the remote: a network that hangs, or a login that would ask for a password
// no one is there to type, must not hold the tick. They run in a process group of their own, so the
// timeout also ends the remote helper or ssh git starts, which would hold the output open.
const GIT_TIMEOUT_MS = 2 * 60_000
const GIT = NOD_GIT

// What a pass did with a task, or what it waits on, for `nod land` to print.
export type Moved = { id: number; did: string }

// `only`: these tasks, whenever they were added (nod land <task>); every task due otherwise.
// `send`: how a landing turn reaches the worker, `deliver` but in tests.
export async function land(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  opts: { only?: number[]; send?: Send } = {},
): Promise<Moved[]> {
  const moved: Moved[] = []
  const { only } = opts
  const paths = only === undefined ? null : new Set(only.map((id) => ledger.get(id).repo))
  for (const repo of ledger.repos()) {
    if (repo.land === 'off' || (paths !== null && !paths.has(repo.path))) continue
    // Two passes at once would rebase and push the same branches; the other one lands these.
    if (!ledger.claimRepo(repo.path, process.pid, running)) continue
    try {
      await landRepo({ ledger, home, terminals, repo, send: opts.send, moved }, only)
    } finally {
      ledger.releaseRepo(repo.path, process.pid)
    }
  }
  return moved
}

type Pass = {
  ledger: Ledger
  home: string
  terminals: Terminals
  repo: Repo
  send?: Send
  moved: Moved[]
}
type Tip = { branch: string; commit: string }

// The repo's tasks due to land, in the order they were added, so one that comes after another
// (`--after`, on its branch) is looked at once that one has had its turn.
function due(ledger: Ledger, terminals: Terminals, repo: Repo, only: number[] | undefined): Task[] {
  return ledger.list().filter((t) => {
    if (t.repo !== repo.path || t.status !== 'succeeded' || t.workspace === null) return false
    const l = ledger.landing(t.id)
    if (l !== null && (l.stopped !== null || l.mergedAt !== null)) return false
    const named = only === undefined ? l !== null : only.includes(t.id)
    const since = repo.raisedAt !== null && t.createdAt >= repo.raisedAt
    if (!named && !(only === undefined && since)) return false
    // A link someone else made: its result went out another way.
    if (ledger.links(t.id).some((url) => url !== l?.pr)) return false
    // A turn the person types in keeps the status succeeded until it ends.
    return !terminals.attached(sessionName(t.id))
  })
}

async function landRepo(pass: Pass, only: number[] | undefined): Promise<void> {
  const { ledger, terminals, repo } = pass
  const tasks = due(ledger, terminals, repo, only)
  if (tasks.length === 0) return
  let tip: Tip
  try {
    tip = await fetchTip(repo.path)
  } catch (error) {
    // Most often the network, on a laptop: the next pass fetches again.
    for (const t of tasks) await noteFor(pass, t, `could not fetch: ${message(error)}`)
    return
  }
  let service: GitService | null = null
  const serviceNow = (): GitService => {
    service ??= serviceOf(repo.path)
    // Missing, it would fail at every pass; the person installs it or lands by hand.
    // The PATH as it is now: Bun.which alone reads the one this process started with.
    if (Bun.which(service.name, { PATH: process.env.PATH ?? '' }) === null) {
      throw new MissingCli(service.name)
    }
    return service
  }
  for (const t of tasks) {
    try {
      const did = await landTask(pass, ledger.get(t.id), tip, serviceNow)
      pass.moved.push({ id: t.id, did })
      // A merge moved the default branch, which the next task lands on.
      if (did.startsWith('merged')) tip = await fetchTip(repo.path)
    } catch (error) {
      ledger.setLanding(t.id, { busy: null })
      const did =
        error instanceof MissingCli
          ? await askFor(pass, t, `${error.message}, which is not on PATH where nod lands.`)
          : await noteFor(pass, t, message(error))
      pass.moved.push({ id: t.id, did })
    }
  }
}

async function landTask(
  pass: Pass,
  task: Task,
  tip: Tip,
  service: () => GitService,
): Promise<string> {
  const { ledger, home, repo } = pass
  const branch = task.branch
  if (branch === null || task.repo === null) throw new Error(`task n${task.id} has no branch`)
  const ask = (question: string): Promise<string> => askFor(pass, task, question)
  // On the branch of the task it comes after, it holds that task's commits: those land first.
  const before = baseOf(ledger, task)
  if (before !== null && !hasLanded(ledger, before)) {
    return noteFor(pass, task, `lands after n${before.id}`)
  }
  if (branch === tip.branch) {
    return ask(`Its branch ${branch} is the default branch, which nod never pushes to.`)
  }
  if (task.collectedAt !== null) await restore(ledger, home, task.id)
  const ws = task.workspace
  if (ws === null) throw new Error(`task n${task.id} has no workspace`)
  let l = ledger.landing(task.id) ?? ledger.setLanding(task.id, {})
  // Before its start is read from HEAD: mid-rebase, HEAD is not where the branch is.
  if (rebasing(ws)) return noteFor(pass, task, 'a rebase is in progress in its worktree')
  let head = await git(ws, 'rev-parse', 'HEAD')
  // As its review reads it, so what the worker brought in of the default branch is not moved again,
  // in a landing turn too.
  // ponytail: a branch gc deleted and resume made again starts at its last head, so its commits
  // read as none of its own; landings record the start before gc can get to them.
  const base = await ownStart(ws, branch, head, tip.commit, l.base)
  if (base === null) {
    return ask(
      `Where its own commits start is unknown: its branch's reflog is gone. Rebase ${branch} onto origin/${tip.branch} by hand and answer yes, or answer no to land it yourself.`,
    )
  }
  if (l.base !== base) l = ledger.setLanding(task.id, { base })
  if (l.pr === null && (await git(ws, 'rev-list', '--count', `${base}..${head}`)) === '0') {
    ledger.setLanding(task.id, { stopped: 'nothing to land: its branch has no commits of its own' })
    return 'nothing to land'
  }
  if ((await git(ws, 'status', '--porcelain')) !== '') {
    return noteFor(pass, task, 'its worktree has uncommitted changes')
  }

  // What became of its pull request, before anything moves it.
  let pr: OwnPr | null = l.pr === null ? null : await service().view(l.pr)
  if (pr?.state === 'merged') return merged(pass, task, l)
  if (pr?.state === 'closed') {
    return ask(
      `Its pull request was closed without being merged: ${l.pr}. Answer yes to land it again (reopen it first), or no to leave it.`,
    )
  }

  // Onto the default branch: before the pull request opens; at `merge`, before each merge, so what
  // is merged was checked as it lands; at `pr`, only once the service says it no longer merges, so
  // a pull request under review is not rewritten each time the default branch moves.
  const stale =
    pr === null || repo.land === 'merge' || pr.merge === 'conflict' || pr.merge === 'behind'
  let conflict: string | null = null
  if (base !== tip.commit && stale) {
    if (!claim(ledger, task.id)) return noteFor(pass, task, 'its worker is busy')
    const r = await spawn(
      [...GIT, 'rebase', '--merge', '--no-update-refs', '--onto', tip.commit, base],
      ws,
    )
    if (r.code === 0) {
      l = ledger.setLanding(task.id, { base: tip.commit, ready: null, busy: null })
      head = await git(ws, 'rev-parse', 'HEAD')
    } else if (rebasing(ws)) {
      conflict = await conflictBrief(ws)
    } else {
      ledger.setLanding(task.id, { busy: null })
      return ask(
        `nod could not rebase ${branch} onto origin/${tip.branch}:\n${r.output.trim().slice(-OUTPUT_LIMIT)}`,
      )
    }
  }

  // The check, on the head as it now lands; once per head.
  let failed: string | null = null
  const check = repo.checkCmd ?? task.checkCmd
  if (conflict === null && l.ready !== head) {
    if (check !== null) {
      if (!claim(ledger, task.id)) return noteFor(pass, task, 'its worker is busy')
      // In a group of its own, as the remote's git calls, so the timeout ends what it started.
      const run = await spawn(['sh', '-c', check], ws, { timeoutMs: CHECK_TIMEOUT_MS })
      ledger.setLanding(task.id, { busy: null })
      if (run.code !== 0) failed = run.output.slice(-OUTPUT_LIMIT)
    }
    if (failed === null) l = ledger.setLanding(task.id, { ready: head })
  }

  // What needs the worker goes to it in one turn, but the pull request's text in a turn of its own:
  // written under a conflict's or a fix's report, that report's first line became its title. Once
  // that work is done, its Stop asks for the text (verifyLanding).
  const text = conflict === null && failed === null && l.pr === null && l.title === null
  if (conflict !== null || failed !== null || text) {
    const said = landingMessage({ tip, base: l.base ?? base, conflict, failed, check, text })
    try {
      await handOff(ledger, home, pass.terminals, task.id, said, pass.send)
    } catch (error) {
      // No worker is on the conflict, so the branch goes back as it was: yes starts over.
      if (conflict !== null) await spawn([...GIT, 'rebase', '--abort'], ws)
      return ask(`nod could not hand its worker the landing: ${message(error)}`)
    }
    const did =
      conflict !== null
        ? 'its worker resolves a conflict'
        : failed !== null
          ? 'its worker fixes the check'
          : 'its worker writes the pull request'
    ledger.setLanding(task.id, { note: did })
    return did
  }
  const title = l.title ?? ''
  const body = l.body ?? ''

  // Out: what nod checks itself and the person's gate, then the push, before anyone else sees it.
  const remote = await maybe(
    git(task.repo, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`),
  )
  if (remote !== head) {
    const merges = await git(ws, 'rev-list', '--merges', `${l.base ?? base}..${head}`)
    if (merges !== '') {
      return ask(`Its branch has merge commits, which nod does not land:\n${merges}`)
    }
    if (repo.gateCmd !== null) {
      const gate = await runGate(home, task, repo.gateCmd, l.base ?? base, head, title, body)
      if (gate !== null) return gateFailed(pass, task, repo.gateCmd, gate)
    }
    // Over what nod pushed last; the first time, over nothing, or over the task's own commits
    // someone pushed before (the way results went out before nod landed them).
    const expected =
      l.pushed ?? (remote === null ? '' : (await ownPush(ws, branch, remote)) ? remote : null)
    if (expected === null) {
      return ask(
        `origin/${branch} has commits nod did not push. Fold them in or remove them, then answer yes; answer no to stop landing it.`,
      )
    }
    // Its CLI before anything goes out: missing, it would stop the landing once pushed.
    service()
    const push = await onRemote(ws, [
      'push',
      '--porcelain',
      `--force-with-lease=refs/heads/${branch}:${expected}`,
      'origin',
      `${head}:refs/heads/${branch}`,
    ])
    if (push.code !== 0) {
      return ask(`The push of ${branch} was refused:\n${push.output.trim().slice(-OUTPUT_LIMIT)}`)
    }
    l = ledger.setLanding(task.id, { pushed: head })
  }

  if (l.pr === null) {
    let url: string
    try {
      url =
        (await service().find(branch)) ??
        (await service().open({ base: tip.branch, head: branch, title, body }))
    } catch (error) {
      return ask(`nod could not open its pull request: ${message(error)}`)
    }
    l = ledger.setLanding(task.id, { pr: url })
    ledger.link(task.id, [url])
    await notify(home, { event: 'pr_opened', task: taskRef(task), url })
    pr = null
  }
  const url = l.pr ?? ''
  if (repo.land !== 'merge')
    return noteFor(pass, task, `pull request open, waiting for its merge: ${url}`)

  pr = await service().view(url)
  if (pr.state === 'merged') return merged(pass, task, l)
  if (pr.head !== head) return noteFor(pass, task, `waits for ${url} to show ${head.slice(0, 12)}`)
  if (pr.merge !== 'clean') return noteFor(pass, task, `waits for ${url}: ${pr.why}`)
  try {
    await service().merge(url, { head, title, body })
  } catch (error) {
    return ask(`The merge of ${url} was refused: ${message(error)}`)
  }
  // tea may exit 0 on a refusal; the pull request says what happened.
  if ((await service().view(url)).state !== 'merged') {
    return ask(`nod asked to merge ${url}, but it is not merged.`)
  }
  return merged(pass, task, l)
}

async function merged(pass: Pass, task: Task, l: Landing): Promise<string> {
  pass.ledger.setLanding(task.id, { mergedAt: new Date().toISOString(), note: null })
  await notify(pass.home, { event: 'merged', task: taskRef(task), url: l.pr ?? '' })
  return `merged: ${l.pr}`
}

// What the person hears once each time it changes: a landing waiting on the same thing at every
// pass says so once.
async function noteFor(pass: Pass, task: Task, note: string): Promise<string> {
  const before = pass.ledger.landing(task.id)
  pass.ledger.setLanding(task.id, { note })
  if (before?.note !== note)
    await notify(pass.home, { event: 'landing', task: taskRef(task), note })
  return note
}

async function askFor(pass: Pass, task: Task, question: string): Promise<string> {
  pass.ledger.setLanding(task.id, { note: question.split('\n')[0] ?? question, busy: null })
  await askToLand(pass.ledger, pass.home, task.id, 'land', question)
  return `asked: ${question.split('\n')[0]}`
}

// A gate failure is about what must not go out, so the person sees it, and the answer goes to the
// worker as landing work.
async function gateFailed(pass: Pass, task: Task, gate: string, output: string): Promise<string> {
  // The text goes back to the worker with the rest: it writes it again (verifyLanding).
  pass.ledger.setLanding(task.id, {
    note: `the gate failed: ${gate}`,
    handedAt: new Date().toISOString(),
    title: null,
    body: null,
  })
  await askToLand(
    pass.ledger,
    pass.home,
    task.id,
    'check_failed',
    `Before pushing, the repo's gate \`${gate}\` failed:\n${output}\nAnswer with how its worker should fix it (it goes to the worker's conversation, as the pull request's text, commit messages and the diff are its work, and it writes the pull request's text again); nod drop stops landing it.`,
  )
  return 'asked: the gate failed'
}

// Whether the task it comes after landed: nod merged it, or its changes are in the default branch
// (merged some other way). Its branch, or the head gc recorded once it deleted the branch.
function hasLanded(ledger: Ledger, task: Task): boolean {
  if (ledger.landing(task.id)?.mergedAt) return true
  if (task.repo === null) return true
  const ref =
    task.branch !== null && hasRef(task.repo, `refs/heads/${task.branch}`)
      ? `refs/heads/${task.branch}`
      : task.head
  return ref !== null && landed(task.repo, ref)
}

// Takes the task's worktree for this pass, while its worker is between turns: a message from now on
// waits (deliver refuses it).
function claim(ledger: Ledger, taskId: number): boolean {
  return ledger.db
    .transaction(() => {
      const busy = ledger.landing(taskId)?.busy ?? null
      if (ledger.get(taskId).status !== 'succeeded' || ledger.openAttempt(taskId) !== null)
        return false
      if (busy !== null && busy !== process.pid && running(busy)) return false
      ledger.setLanding(taskId, { busy: process.pid })
      return true
    })
    .immediate()
}

async function fetchTip(repo: string): Promise<Tip> {
  const reach = async (args: string[]): Promise<string> => {
    const r = await onRemote(repo, args)
    if (r.code !== 0)
      throw new Error(`git ${args[0]} failed: ${r.output.trim().slice(-OUTPUT_LIMIT)}`)
    return r.output
  }
  await reach(['fetch', '-q', 'origin'])
  const head = await reach(['ls-remote', '--symref', 'origin', 'HEAD'])
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1]
  if (branch === undefined) throw new Error('origin names no default branch')
  return {
    branch,
    commit: await git(repo, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`),
  }
}

function landingMessage(m: {
  tip: Tip
  base: string
  conflict: string | null
  failed: string | null
  check: string | null
  text: boolean
}): string {
  const on = `origin/${m.tip.branch} (${m.tip.commit.slice(0, 12)})`
  const parts = [`nod is landing this task's branch on ${on}.`]
  if (m.conflict !== null) {
    parts.push(`It rebased your commits onto it. ${m.conflict}`)
    parts.push(`Once the rebase is done, your branch starts at commit ${m.tip.commit}.`)
  } else if (m.failed !== null) {
    parts.push(
      `Your branch now starts at commit ${m.base}, and the check \`${m.check}\` fails there:\n${m.failed}\nFix it and commit on this branch.`,
    )
  } else {
    parts.push(`Your branch now starts at commit ${m.base}.`)
  }
  if (m.text) parts.push(PR_TEXT)
  if (m.conflict === null && m.failed === null) parts.push(TEXT_ONLY)
  return parts.join('\n\n')
}

// The person's gate, on the commits and the pull request's text as they would go out. Null when it
// passes, else what it printed.
async function runGate(
  home: string,
  task: Task,
  gate: string,
  base: string,
  head: string,
  title: string,
  body: string,
): Promise<string | null> {
  const ws = task.workspace ?? ''
  const file = join(home, 'work', `.pr-${task.id}`)
  mkdirSync(join(home, 'work'), { recursive: true })
  writeFileSync(file, `${title}\n\n${body}\n`)
  const { code, output } = await spawn(['sh', '-c', gate], ws, {
    env: {
      NOD_BASE: base,
      NOD_HEAD: head,
      NOD_PR: file,
      NOD_TASK: String(task.id),
    },
    timeoutMs: GATE_TIMEOUT_MS,
  })
  rmSync(file, { force: true })
  return code === 0 ? null : output.trim().slice(-OUTPUT_LIMIT) || `exited ${code}`
}

// Whether `remote`, the branch as origin has it, holds only the task's own commits: past where the
// branch was created, and in the branch as it was at some point (its reflog), so a push from before
// its worker rebased it counts too. The start itself, or what it was made from, is someone else's.
async function ownPush(ws: string, branch: string, remote: string): Promise<boolean> {
  const start = await createdFrom(ws, branch)
  if (start === null || remote === start) return false
  const past = await spawn(['git', 'merge-base', '--is-ancestor', start, remote], ws)
  if (past.code !== 0) return false
  const tips = (await maybe(git(ws, 'reflog', 'show', '--format=%H', `refs/heads/${branch}`))) ?? ''
  for (const tip of tips.split('\n').filter(Boolean)) {
    const r = await spawn(['git', 'merge-base', '--is-ancestor', remote, tip], ws)
    if (r.code === 0) return true
  }
  return false
}

// git on the remote, which may never answer and must not ask (GIT_TIMEOUT_MS).
function onRemote(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  return spawn([...GIT, ...args], cwd, {
    env: { GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: GIT_TIMEOUT_MS,
  })
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { code, stdout, output } = await spawn([...GIT, ...args], cwd)
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${output.trim().slice(-OUTPUT_LIMIT)}`)
  return stdout.trim()
}

const maybe = (p: Promise<string>): Promise<string | null> => p.catch(() => null)

class MissingCli extends Error {
  constructor(name: string) {
    super(`landing this repo needs ${name}`)
  }
}
