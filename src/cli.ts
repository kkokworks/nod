#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { sweep } from './done'
import { collect, type GcPick, type GcReport, remotesHolding } from './gc'
import { type Attempt, type Decision, Ledger, nodHome, type Task, type Trigger } from './ledger'
import { pullRequests } from './prs'
import { Terminals } from './tmux'
import {
  actorFromEnv,
  capture,
  projectCommand,
  TODO_USAGE,
  todayCommand,
  todoCommand,
} from './todo-cli'
import { parseRef, Todos } from './todos'
import {
  addTrigger,
  nextRun,
  SCHEDULE_OFF,
  scheduleEnv,
  scheduleOff,
  scheduleOn,
  tick,
} from './triggers'
import { indent, oneLine, taskNote, taskStatus } from './view'
import {
  answer,
  branchOf,
  drop,
  NotificationEvent,
  onNotification,
  onStop,
  resume,
  StopEvent,
  sessionName,
  startReady,
  startTask,
  tell,
} from './worker'

const USAGE = `usage:
  nod [--issue <key,...>]          open decisions (--issue: only those of tasks on these issues)
  nod <decision> <answer...>       answer a decision; the worker gets it in its own session
  nod drop <decision>              end the task instead of answering
  nod add <brief> [--repo <path> --branch <name>] [--check <command>] [--model <model>]
          [--after <task,...>] [--issue <key>] [--todo <todo> | --project <project>]
                                   start a worker on the task now, or once the tasks it comes
                                   after have succeeded. In a repo it works on a new branch
                                   <name> in the worktree <home>/work/<repo folder>/<name>,
                                   started from the earlier task's branch in the same repo.
                                   --issue names the issue it works on, so ls, decisions and
                                   notify events show it. --todo delegates that todo to the
                                   task: it waits on the task, is done once it succeeds, and is
                                   a next action again if it is dropped; the brief may then be
                                   left out for the todo's title and notes. Without --todo the
                                   task gets a todo of its own, titled by the brief's first line,
                                   in --project when given
  nod tell <task> <message...>     send a follow-up into the task's session
  nod resume <task>                reopen a task whose session ended, from its transcript
  nod attach <task>                open the worker's terminal (tmux)
  nod peek <task>                  print what the worker's terminal shows right now
  nod watch [--issue <key,...>]    print decisions as they open, until no worker is running;
                                   --issue: only decisions and workers of tasks on these issues,
                                   so several root sessions can each watch their own issues
  nod link <task> <url...>         record where the task's result went (a pull request, a posted
                                   review), so ls and show list it next to the task. Until then
                                   they list the remote branches that hold the task's branch
  nod ls [--all]                   tasks not yet collected by gc (--all: every task); those with an
                                   issue are listed under it
  nod show <task>                  history, links, then the worker's last full report
  nod stats
  nod gc [<task...> | --older-than <days>]
                                   close sessions and delete workspaces and worktrees of the named
                                   finished tasks, or of tasks finished that long ago, or, with
                                   neither, of the finished tasks a signal says are done with:
                                   dropped, taken over by a newer task on the same todo, merged
                                   into the default branch, a linked pull request merged, closed or
                                   approved by you, or finished 7+ days ago (never one with commits
                                   no remote has). Branches go once a remote branch holds the
                                   commits or the remote's default branch has the changes; ledger
                                   rows and session transcripts stay, ls stops listing the tasks,
                                   and resume or tell brings one back. The schedule runs the
                                   signal check every 5 minutes
  nod trigger add <cron> <brief...> [--source <command>] [--repo <path> --branch <prefix>]
                  [--check <command>] [--model <model>]
                                   add a task on a schedule (5-field cron, local time); with
                                   --source, one task per line the command prints that it has
                                   not printed before (text after a tab; before it, the key,
                                   which is also the task's issue). In a repo each task works on
                                   the branch <prefix>/<task>
  nod trigger ls | rm <trigger>
  nod schedule [on | off]          whether the OS scheduler runs the tick every minute; on, it
                                   runs with this shell's PATH and Claude config dir, which the
                                   triggers' workers and the watches use. It stays on until off
  nod tick                         run the triggers that are due and the watches; the scheduled
                                   tick runs the watches every fifth minute
  nod hook stop|notification       called by Claude Code hooks in worker sessions

A <task> is a task's number, t<n> for the latest task doing todo t<n>, or r<n> for the task
retrospective r<n> runs in.
${TODO_USAGE}

When <home>/notify exists, nod runs it with a JSON event on stdin whenever a decision opens, a
task succeeds or fails to start, a trigger fails, or a watch passes or can no longer run. <home>
is $NOD_HOME, or ~/.nod.`

const [command, ...rest] = Bun.argv.slice(2)
const home = nodHome()
const ledger = new Ledger(home)
const terminals = Terminals.of(home)
const taskRef = (ref: string | undefined): number => new Todos(ledger).taskRef(ref ?? '')
// Also covers a decision that opens just as the last worker stops.
const WATCH_GRACE_SECS = 5

switch (command) {
  case undefined:
  case '--issue': {
    const keys = issueKeys(Bun.argv.slice(2))
    printDecisions(ledger.openDecisions().filter((d) => onIssues(keys, ledger.get(d.taskId))))
    break
  }
  case 'add':
    await add(rest)
    break
  case 'tell':
    await tell(ledger, home, taskRef(rest[0]), words(rest.slice(1)))
    console.log('sent')
    break
  case 'resume':
    await resume(ledger, home, taskRef(rest[0]))
    console.log('reopened')
    break
  case 'attach':
    attach(taskRef(rest[0]))
    break
  case 'peek':
    peek(taskRef(rest[0]))
    break
  case 'watch':
    await watch(issueKeys(rest))
    break
  case 'link': {
    const id = taskRef(rest[0])
    const urls = rest.slice(1)
    if (!Number.isInteger(id) || urls.length === 0) throw new Error(USAGE)
    ledger.link(id, urls)
    console.log(`linked #${id}: ${ledger.links(id).join(' ')}`)
    break
  }
  case 'ls': {
    const { values } = parseArgs({ args: rest, options: { all: { type: 'boolean' } } })
    printTasks(ledger.list().filter((t) => values.all || t.collectedAt === null))
    break
  }
  case 'show':
    show(taskRef(rest[0]))
    break
  case 'drop':
    await drop(ledger, home, Number(rest[0]))
    console.log('dropped')
    break
  case 'gc':
    await gc(rest)
    break
  case 'stats':
    console.log(JSON.stringify(ledger.stats(), null, 2))
    break
  case 'trigger':
    await trigger(rest)
    break
  case 'schedule':
    await schedule(rest)
    break
  case 'tick': {
    // Run by hand, it checks the watches now too, not only on their every fifth minute.
    const { added, passed } = await tick(ledger, home, new Date(), true)
    if (added.length > 0) console.log(`added task(s) ${added.join(', ')}`)
    if (passed.length > 0) console.log(`watch passed: ${passed.map((id) => `t${id}`).join(', ')}`)
    if (added.length === 0 && passed.length === 0) console.log('nothing due')
    break
  }
  case 'hook':
    await hook(rest[0])
    break
  case 'in':
    capture(new Todos(ledger), rest)
    break
  case 'todo':
    await todoCommand(new Todos(ledger), home, rest)
    break
  case 'project':
    projectCommand(new Todos(ledger), rest)
    break
  case 'today':
    await todayCommand(new Todos(ledger), home, rest)
    break
  default: {
    const id = Number(command)
    if (!Number.isInteger(id)) {
      console.error(USAGE)
      process.exit(1)
    }
    await answer(ledger, home, id, words(rest))
    console.log(`answered; sent to task #${ledger.decision(id).taskId}`)
  }
}

async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      branch: { type: 'string' },
      check: { type: 'string' },
      model: { type: 'string' },
      after: { type: 'string' },
      issue: { type: 'string' },
      todo: { type: 'string' },
      project: { type: 'string' },
    },
    allowPositionals: true,
  })
  if (values.todo !== undefined && values.project !== undefined) {
    throw new Error('--project places a new todo; the one given with --todo keeps its own')
  }
  const todos = new Todos(ledger)
  const projectId = values.project === undefined ? null : todos.findProject(values.project).id
  const todo = values.todo === undefined ? null : todos.get(parseRef(values.todo, 't'))
  // A clarified todo already says what to do.
  const brief =
    todo !== null && positionals.length === 0
      ? [todo.title, todo.notes].filter((x) => x !== null).join('\n\n')
      : words(positionals)
  const after = (values.after ?? '').split(',').filter(Boolean).map(taskRef)
  if (!after.every(Number.isInteger)) throw new Error(`--after takes task numbers: ${values.after}`)
  const repo = repoPath(values.repo)
  const task = {
    brief,
    repo,
    branch: branchName(repo, values.branch),
    checkCmd: values.check ?? null,
    model: values.model ?? null,
    after,
    triggerId: null,
    issue: values.issue ?? null,
  }
  const actor = actorFromEnv()
  const id =
    todo === null ? todos.delegateNew(task, projectId, actor) : todos.delegate(todo.id, task, actor)
  // A task that comes after others starts here only if they have all succeeded already.
  if (after.length === 0) await startTask(ledger, home, id)
  else await startReady(ledger, home)
  console.log(id)
}

async function trigger([sub, ...args]: string[]): Promise<void> {
  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args,
      options: {
        source: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        check: { type: 'string' },
        model: { type: 'string' },
      },
      allowPositionals: true,
    })
    const [cron, ...brief] = positionals
    if (cron === undefined) throw new Error(USAGE)
    const repo = repoPath(values.repo)
    const { id, seen } = await addTrigger(ledger, home, {
      cron,
      brief: words(brief),
      repo,
      branch: branchName(repo, values.branch),
      checkCmd: values.check ?? null,
      model: values.model ?? null,
      source: values.source ?? null,
    })
    console.log(id)
    if (values.source) console.log(`the source lists ${seen} item(s) now; only new ones add tasks`)
    printTrigger(ledger.trigger(id))
    if (scheduleEnv(home) === null) console.log(SCHEDULE_OFF)
  } else if (sub === 'ls') {
    for (const t of ledger.triggers()) printTrigger(t)
  } else if (sub === 'rm') {
    ledger.removeTrigger(Number(args[0]))
    console.log('removed')
  } else {
    throw new Error(USAGE)
  }
}

async function schedule([sub, ...extra]: string[]): Promise<void> {
  if (extra.length > 0) throw new Error(USAGE)
  if (sub === 'on') await scheduleOn(home)
  else if (sub === 'off') await scheduleOff(home)
  else if (sub !== undefined) throw new Error(USAGE)
  const env = scheduleEnv(home)
  if (env === null) {
    console.log('off')
    return
  }
  console.log('on, every minute')
  console.log(`  PATH ${env.PATH}`)
  console.log(`  CLAUDE_CONFIG_DIR ${env.CLAUDE_CONFIG_DIR ?? '(not set)'}`)
}

function printTrigger(t: Trigger): void {
  const next = nextRun(t.cron, new Date(t.lastRunAt ?? t.createdAt))
  const when = next === null ? 'never' : next.toLocaleString('sv-SE')
  console.log(
    `#${String(t.id).padEnd(4)} ${t.cron.padEnd(16)} next ${when}  ${oneLine(t.brief, 60)}`,
  )
  if (t.source) console.log(`  source: ${t.source}`)
  if (t.lastError) console.log(`  last run failed: ${oneLine(t.lastError, 200)}`)
}

function repoPath(path: string | undefined): string | null {
  if (path === undefined) return null
  const repo = resolve(path)
  if (!existsSync(join(repo, '.git'))) throw new Error(`not a git repo: ${repo}`)
  return repo
}

// Work in a repo goes on a branch the human names, so the branch and its worktree folder say what
// the work is. A valid name has no `..`, which also keeps the worktree inside nod's work folder.
function branchName(repo: string | null, name: string | undefined): string | null {
  if (repo === null) {
    if (name !== undefined) throw new Error('--branch needs --repo')
    return null
  }
  if (name === undefined) throw new Error('--repo needs --branch <name>, such as feat/login-form')
  if (Bun.spawnSync(['git', 'check-ref-format', '--branch', name]).exitCode !== 0) {
    throw new Error(`not a valid branch name: ${name}`)
  }
  return name
}

async function hook(event: string | undefined): Promise<void> {
  const input: unknown = JSON.parse(await Bun.stdin.text())
  if (event === 'stop') {
    const out = await onStop(ledger, home, StopEvent.parse(input))
    if (out !== null) console.log(out)
  } else if (event === 'notification') {
    await onNotification(ledger, home, NotificationEvent.parse(input))
  } else {
    throw new Error(USAGE)
  }
}

function attach(taskId: number): void {
  // Unset TMUX so this also works from inside another tmux session.
  const { TMUX: _outer, ...env } = process.env
  const result = Bun.spawnSync(terminals.attachCommand(sessionName(taskId)), {
    stdio: ['inherit', 'inherit', 'inherit'],
    env,
  })
  process.exit(result.exitCode)
}

// What the worker shows right now, for a Claude session that cannot attach a terminal.
function peek(taskId: number): void {
  ledger.get(taskId)
  const name = sessionName(taskId)
  if (!terminals.alive(name)) {
    throw new Error(`task #${taskId} has no live session; nod show ${taskId} has its history`)
  }
  console.log(
    terminals
      .screen(name)
      .replace(/\n\s*\n/g, '\n')
      .trimEnd(),
  )
}

// Lets a Claude session relay each decision as soon as it opens.
// null means every issue, and tasks without one.
function issueKeys(args: string[]): Set<string> | null {
  const { values } = parseArgs({ args, options: { issue: { type: 'string' } } })
  if (values.issue === undefined) return null
  const keys = values.issue
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
  if (keys.length === 0) throw new Error('--issue needs at least one key')
  return new Set(keys)
}

function onIssues(keys: Set<string> | null, task: Task): boolean {
  return keys === null || (task.issue !== null && keys.has(task.issue))
}

async function watch(keys: Set<string> | null): Promise<void> {
  const seen = new Set(ledger.openDecisions().map((d) => d.id))
  let idleSecs = 0
  while (idleSecs < WATCH_GRACE_SECS) {
    await Bun.sleep(1000)
    for (const d of ledger.openDecisions()) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      if (onIssues(keys, ledger.get(d.taskId))) printDecision(d)
    }
    const running = ledger.list().some((t) => t.status === 'running' && onIssues(keys, t))
    idleSecs = running ? 0 : idleSecs + 1
  }
}

async function gc(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { 'older-than': { type: 'string' } },
    allowPositionals: true,
  })
  const olderThan = values['older-than']
  if (positionals.length > 0 && olderThan !== undefined) {
    throw new Error('name tasks or give --older-than, not both')
  }
  if (positionals.length === 0 && olderThan === undefined) {
    const { report, done, unchecked } = await sweep(ledger, home, pullRequests(home), new Date())
    printGc(report)
    for (const d of done) if (report.removed.includes(d.id)) console.log(`  #${d.id}: ${d.reason}`)
    for (const u of unchecked) console.log(`unchecked #${u.id}: ${u.error}`)
    return
  }
  printGc(await collect(ledger, home, gcPick(positionals, olderThan)))
}

function printGc(report: GcReport): void {
  console.log(`removed ${report.removed.length} task(s): ${report.removed.join(', ') || '-'}`)
  if (report.clean.length > 0) console.log(`already clean: ${report.clean.join(', ')}`)
  for (const s of report.skipped) console.log(`skipped #${s.id}: ${s.reason}`)
}

function gcPick(tasks: string[], olderThan: string | undefined): GcPick {
  if (tasks.length > 0) return { ids: tasks.map((t) => ledger.get(taskRef(t)).id) }
  const days = Number(olderThan)
  if (!(days >= 0)) throw new Error(`--older-than must be a number of days: ${olderThan}`)
  return { before: new Date(Date.now() - days * 86_400_000) }
}

function show(id: number): void {
  const task = ledger.get(id)
  printTask(task)
  if (task.issue !== null) console.log(`  issue: ${task.issue}`)
  console.log(`  brief: ${task.brief}`)
  if (task.repo) console.log(`  repo: ${task.repo} (branch ${branchOf(task)})`)
  if (task.workspace) console.log(`  workspace: ${task.workspace}`)
  if (task.checkCmd) console.log(`  check: ${task.checkCmd}`)
  if (task.triggerId !== null) console.log(`  added by trigger #${task.triggerId}`)
  if (task.retroId !== null) {
    const r = ledger.retro(task.retroId)
    console.log(`  retrospective: r${r.id} of #${r.ofTaskId}${r.outcome ? `, ${r.outcome}` : ''}`)
  }
  if (task.todoId !== null) console.log(`  todo: t${task.todoId}`)
  for (const url of ledger.links(id)) console.log(`  link: ${url}`)
  for (const ref of unlinkedPushes(task)) console.log(`  pushed: ${ref}`)
  if (task.collectedAt !== null) console.log(`  collected: ${task.collectedAt}`)
  const after = ledger.after(id)
  if (after.length > 0) {
    console.log(`  after: ${after.map((a) => `#${a.id} (${a.status})`).join(', ')}`)
  }
  if (terminals.alive(sessionName(id))) console.log(`  terminal: nod attach ${id}`)
  for (const a of ledger.attempts(id)) printAttempt(a)
  for (const d of ledger.decisions(id)) {
    const answered = d.answeredAt
      ? `answered after ${secsBetween(d.createdAt, d.answeredAt)}s: ${d.answer}`
      : 'open'
    console.log(`  decision #${d.id} ${d.reason} — ${answered}`)
  }
  const report = ledger
    .attempts(id)
    .filter((a) => a.report)
    .at(-1)?.report
  if (report) console.log(`\n${report}`)
}

function printDecisions(decisions: Decision[]): void {
  if (decisions.length === 0) {
    console.log('nothing to decide')
    return
  }
  for (const d of decisions) printDecision(d)
  console.log('answer: nod <decision> <answer>   end the task: nod drop <decision>')
}

// What a task works for: the person's todo (t<n>) or nod's retrospective (r<n>).
function owner(t: Task): string {
  if (t.retroId !== null) return `r${t.retroId}`
  return t.todoId === null ? '' : `t${t.todoId}`
}

function printDecision(d: Decision): void {
  const task = ledger.get(d.taskId)
  const of = [owner(task), task.issue ?? ''].map((x) => (x === '' ? '' : ` ${x}`)).join('')
  console.log(`#${d.id}  ${d.reason}  (task #${task.id}${of}: ${oneLine(task.brief, 60)})`)
  console.log(`${indent(d.question)}\n`)
}

// Tasks without an issue first, as they always were; then each issue, in the order it first
// appeared, with its tasks indented under it.
function printTasks(tasks: Task[]): void {
  const byIssue = Map.groupBy(tasks, (t) => t.issue)
  for (const t of byIssue.get(null) ?? []) printTask(t)
  for (const [issue, group] of byIssue) {
    if (issue === null) continue
    console.log(issue)
    for (const t of group) printTask(t, '  ')
  }
}

function printTask(t: Task, prefix = ''): void {
  const turns = ledger.attempts(t.id).length
  const status = taskStatus(t, terminals)
  console.log(
    `${prefix}#${String(t.id).padEnd(4)} ${owner(t).padEnd(5)} ${status.padEnd(14)} ${String(turns).padStart(2)} turns  ${oneLine(taskNote(ledger, t), 80)}`,
  )
  for (const url of ledger.links(t.id)) console.log(`${prefix}      link ${url}`)
  for (const ref of unlinkedPushes(t)) console.log(`${prefix}      pushed ${ref}`)
}

// The remote branches holding a succeeded task's branch, while it has no link: its result was
// pushed, maybe under another name, and is waiting to be linked. Only as fresh as the repo's last
// fetch; nod does not fetch.
function unlinkedPushes(t: Task): string[] {
  const { repo } = t
  if (repo === null || t.status !== 'succeeded' || ledger.links(t.id).length > 0) return []
  const branch = `refs/heads/${branchOf(t)}`
  // The repo or the branch is gone: nothing left to look in.
  if (Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '-q', branch]).exitCode !== 0) {
    return []
  }
  return remotesHolding(repo, branch)
}

function printAttempt(a: Attempt): void {
  const secs = a.finishedAt ? `${secsBetween(a.startedAt, a.finishedAt)}s` : 'running'
  const check = a.checkResult ? ` check ${a.checkResult}` : ''
  console.log(
    `  ${a.kind.padEnd(8)} ${(a.outcome ?? '-').padEnd(14)} ${secs}${check}  session ${a.sessionId}`,
  )
  const note = a.error ?? a.summary
  if (note) console.log(indent(oneLine(note, 200), 4))
}

// Function declarations, not consts: the top-level switch above runs before consts initialise.
function words(args: string[]): string {
  const text = args.join(' ').trim()
  if (!text) throw new Error(USAGE)
  return text
}

function secsBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000)
}
