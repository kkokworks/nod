#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { collect, type GcPick } from './gc'
import { type Attempt, type Decision, Ledger, nodHome, type Task, type Trigger } from './ledger'
import { Terminals } from './tmux'
import { addTrigger, nextRun, syncSchedule, tick } from './triggers'
import {
  answer,
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
  nod                              open decisions
  nod <decision> <answer...>       answer a decision; the worker gets it in its own session
  nod drop <decision>              end the task instead of answering
  nod add <brief> [--repo <path>] [--check <command>] [--model <model>] [--after <task,...>]
          [--issue <key>]
                                   start a worker on the task now, or once the tasks it comes
                                   after have succeeded; in the same repo it starts from the
                                   earlier task's branch. --issue names the issue it works on,
                                   so ls, decisions and notify events show it
  nod tell <task> <message...>     send a follow-up into the task's session
  nod resume <task>                reopen a task whose session ended, from its transcript
  nod attach <task>                open the worker's terminal (tmux)
  nod peek <task>                  print what the worker's terminal shows right now
  nod watch                        print decisions as they open, until no worker is running
  nod ls                           tasks; those with an issue are listed under it
  nod show <task>                  history, then the worker's last full report
  nod stats
  nod gc [<task...> | --older-than <days>]
                                   close sessions and delete workspaces, worktrees and session
                                   folders of the named finished tasks, or of tasks finished that
                                   long ago (default 7); ledger rows and branches stay
  nod trigger add <cron> <brief...> [--source <command>] [--repo <path>] [--check <command>]
                  [--model <model>]
                                   add a task on a schedule (5-field cron, local time); with
                                   --source, one task per line the command prints that it has
                                   not printed before (text after a tab; before it, the key,
                                   which is also the task's issue)
  nod trigger ls | rm <trigger>
  nod tick                         run the triggers that are due; the OS scheduler calls this
                                   every minute while any trigger exists
  nod hook stop|notification       called by Claude Code hooks in worker sessions

When <home>/notify exists, nod runs it with a JSON event on stdin whenever a decision opens, a
task succeeds or fails to start, or a trigger fails. <home> is $NOD_HOME, or ~/.nod.`

const [command, ...rest] = Bun.argv.slice(2)
const home = nodHome()
const ledger = new Ledger(home)
const terminals = Terminals.of(home)
// Also covers a decision that opens just as the last worker stops.
const WATCH_GRACE_SECS = 5

switch (command) {
  case undefined:
    printDecisions(ledger.openDecisions())
    break
  case 'add':
    await add(rest)
    break
  case 'tell':
    tell(ledger, home, Number(rest[0]), words(rest.slice(1)))
    console.log('sent')
    break
  case 'resume':
    resume(ledger, home, Number(rest[0]))
    console.log('reopened')
    break
  case 'attach':
    attach(Number(rest[0]))
    break
  case 'peek':
    peek(Number(rest[0]))
    break
  case 'watch':
    await watch()
    break
  case 'ls':
    printTasks(ledger.list())
    break
  case 'show':
    show(Number(rest[0]))
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
  case 'tick': {
    const added = await tick(ledger, home, new Date())
    console.log(added.length > 0 ? `added task(s) ${added.join(', ')}` : 'nothing due')
    break
  }
  case 'hook':
    await hook(rest[0])
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
      check: { type: 'string' },
      model: { type: 'string' },
      after: { type: 'string' },
      issue: { type: 'string' },
    },
    allowPositionals: true,
  })
  const brief = words(positionals)
  const after = (values.after ?? '').split(',').filter(Boolean).map(Number)
  if (!after.every(Number.isInteger)) throw new Error(`--after takes task numbers: ${values.after}`)
  const id = ledger.add({
    brief,
    repo: repoPath(values.repo),
    checkCmd: values.check ?? null,
    model: values.model ?? null,
    after,
    triggerId: null,
    issue: values.issue ?? null,
  })
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
        check: { type: 'string' },
        model: { type: 'string' },
      },
      allowPositionals: true,
    })
    const [cron, ...brief] = positionals
    if (cron === undefined) throw new Error(USAGE)
    const { id, seen } = await addTrigger(ledger, home, {
      cron,
      brief: words(brief),
      repo: repoPath(values.repo),
      checkCmd: values.check ?? null,
      model: values.model ?? null,
      source: values.source ?? null,
    })
    await syncSchedule(ledger, home)
    console.log(id)
    if (values.source) console.log(`the source lists ${seen} item(s) now; only new ones add tasks`)
    printTrigger(ledger.trigger(id))
  } else if (sub === 'ls') {
    for (const t of ledger.triggers()) printTrigger(t)
  } else if (sub === 'rm') {
    ledger.removeTrigger(Number(args[0]))
    await syncSchedule(ledger, home)
    console.log('removed')
  } else {
    throw new Error(USAGE)
  }
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
async function watch(): Promise<void> {
  const seen = new Set(ledger.openDecisions().map((d) => d.id))
  let idleSecs = 0
  while (idleSecs < WATCH_GRACE_SECS) {
    await Bun.sleep(1000)
    for (const d of ledger.openDecisions()) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      printDecision(d)
    }
    idleSecs = ledger.stats().tasks.running > 0 ? 0 : idleSecs + 1
  }
}

async function gc(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { 'older-than': { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length > 0 && values['older-than'] !== undefined) {
    throw new Error('name tasks or give --older-than, not both')
  }
  const report = await collect(ledger, home, gcPick(positionals, values['older-than'] ?? '7'))
  console.log(`removed ${report.removed.length} task(s): ${report.removed.join(', ') || '-'}`)
  for (const s of report.skipped) console.log(`skipped #${s.id}: ${s.reason}`)
}

function gcPick(tasks: string[], olderThan: string): GcPick {
  if (tasks.length > 0) return { ids: tasks.map((t) => ledger.get(Number(t)).id) }
  const days = Number(olderThan)
  if (!(days >= 0)) throw new Error(`--older-than must be a number of days: ${olderThan}`)
  return { before: new Date(Date.now() - days * 86_400_000) }
}

function show(id: number): void {
  const task = ledger.get(id)
  printTask(task)
  if (task.issue !== null) console.log(`  issue: ${task.issue}`)
  console.log(`  brief: ${task.brief}`)
  if (task.repo) console.log(`  repo: ${task.repo} (branch nod/${task.id})`)
  if (task.workspace) console.log(`  workspace: ${task.workspace}`)
  if (task.checkCmd) console.log(`  check: ${task.checkCmd}`)
  if (task.triggerId !== null) console.log(`  added by trigger #${task.triggerId}`)
  if (task.retroOf !== null) console.log(`  retrospective of #${task.retroOf}`)
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

function printDecision(d: Decision): void {
  const task = ledger.get(d.taskId)
  const issue = task.issue === null ? '' : ` ${task.issue}`
  console.log(`#${d.id}  ${d.reason}  (task #${task.id}${issue}: ${oneLine(task.brief, 60)})`)
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
  const attempts = ledger.attempts(t.id)
  const last = attempts.at(-1)
  const waiting = t.status === 'queued' ? ledger.after(t.id) : []
  const waitsFor =
    waiting.length > 0 ? `waits for ${waiting.map((a) => `#${a.id}`).join(', ')}: ${t.brief}` : null
  const note = t.error ?? waitsFor ?? last?.summary ?? t.brief
  // A running task without a session was cut off (exit, restart); `nod resume` reopens it.
  const status =
    t.status === 'running' && !terminals.alive(sessionName(t.id)) ? 'session ended' : t.status
  console.log(
    `${prefix}#${String(t.id).padEnd(4)} ${status.padEnd(14)} ${String(attempts.length).padStart(2)} turns  ${oneLine(note, 80)}`,
  )
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

function oneLine(s: string, max: number): string {
  return s.replaceAll('\n', ' ').slice(0, max)
}

function indent(s: string, n = 2): string {
  return s
    .split('\n')
    .map((line) => ' '.repeat(n) + line)
    .join('\n')
}
