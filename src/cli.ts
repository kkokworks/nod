#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { collect } from './gc'
import { type Attempt, type Decision, Ledger, nodHome, type Task } from './ledger'
import { runPool } from './pool'
import { DEFAULT_SETTINGS, runTask } from './runner'

const USAGE = `usage:
  nod                              open decisions
  nod <decision> <answer...>       answer a decision; the task resumes on the next run
  nod drop <decision>              end the task instead of answering
  nod add <brief> [--repo <path>] [--check <command>]
  nod run [--max <n>] [--model <model>] [--permission-mode <mode>] [--settings <file|json>]
  nod ls
  nod show <task>
  nod stats
  nod gc [--older-than <days>]     delete workspaces, worktrees and session folders of tasks
                                   finished that long ago (default 7); ledger rows and branches stay`

const [command, ...rest] = Bun.argv.slice(2)
const home = nodHome()
const ledger = new Ledger(home)

switch (command) {
  case undefined:
    printDecisions(ledger.openDecisions())
    break
  case 'add':
    add(rest)
    break
  case 'run':
    await run(rest)
    break
  case 'ls':
    for (const t of ledger.list()) printTask(t)
    break
  case 'show':
    show(Number(rest[0]))
    break
  case 'drop':
    ledger.drop(Number(rest[0]))
    console.log('dropped')
    break
  case 'gc':
    await gc(rest)
    break
  case 'stats':
    console.log(JSON.stringify(ledger.stats(), null, 2))
    break
  default: {
    const id = Number(command)
    const answer = rest.join(' ').trim()
    if (!Number.isInteger(id) || !answer) {
      console.error(USAGE)
      process.exit(1)
    }
    ledger.answer(id, answer)
    console.log(`answered; task #${ledger.decision(id).taskId} resumes on the next \`nod run\``)
  }
}

async function gc(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { 'older-than': { type: 'string', default: '7' } },
  })
  const days = Number(values['older-than'])
  if (!(days >= 0))
    throw new Error(`--older-than must be a number of days: ${values['older-than']}`)
  const report = await collect(ledger, home, new Date(Date.now() - days * 86_400_000))
  console.log(`removed ${report.removed.length} task(s): ${report.removed.join(', ') || '-'}`)
  for (const s of report.skipped) console.log(`skipped #${s.id}: ${s.reason}`)
}

function add(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { repo: { type: 'string' }, check: { type: 'string' } },
    allowPositionals: true,
  })
  const brief = positionals.join(' ').trim()
  if (!brief) throw new Error(USAGE)
  const repo = values.repo === undefined ? null : resolve(values.repo)
  if (repo !== null && !existsSync(join(repo, '.git'))) throw new Error(`not a git repo: ${repo}`)
  console.log(ledger.add(brief, repo, values.check ?? null))
}

async function run(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      max: { type: 'string' },
      model: { type: 'string' },
      'permission-mode': { type: 'string', default: 'acceptEdits' },
      settings: { type: 'string', default: DEFAULT_SETTINGS },
    },
  })
  const max = values.max === undefined ? Number.POSITIVE_INFINITY : Number(values.max)
  if (!(max >= 1)) throw new Error(`--max must be a positive number: ${values.max}`)

  const release = acquireRunLock()
  try {
    const requeued = ledger.requeueRunning()
    if (requeued > 0) console.error(`picking up ${requeued} task(s) left by an earlier run`)
    const opts = {
      home,
      permissionMode: values['permission-mode'],
      settings: values.settings,
      model: values.model,
    }
    await runPool(
      () => ledger.ready(),
      async (task) => {
        await runTask(ledger, task, opts)
        printTask(ledger.get(task.id))
      },
      max,
    )
    const open = ledger.openDecisions().length
    if (open > 0) console.log(`${open} decision(s) waiting — run \`nod\``)
  } finally {
    release()
  }
}

// One runner at a time: a second one would treat the first one's tasks as interrupted.
function acquireRunLock(): () => void {
  const path = join(home, 'run.pid')
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'))
    if (isAlive(pid)) throw new Error(`nod run is already running (pid ${pid})`)
  }
  writeFileSync(path, String(process.pid))
  return () => rmSync(path, { force: true })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function show(id: number): void {
  const task = ledger.get(id)
  printTask(task)
  console.log(`  brief: ${task.brief}`)
  if (task.repo) console.log(`  repo: ${task.repo} (branch nod/${task.id})`)
  if (task.workspace) console.log(`  workspace: ${task.workspace}`)
  if (task.checkCmd) console.log(`  check: ${task.checkCmd}`)
  for (const a of ledger.attempts(id)) printAttempt(a)
  for (const d of ledger.decisions(id)) {
    const answered = d.answeredAt
      ? `answered after ${secsBetween(d.createdAt, d.answeredAt)}s: ${d.answer}`
      : 'open'
    console.log(`  decision #${d.id} ${d.reason} — ${answered}`)
  }
}

function printDecisions(decisions: Decision[]): void {
  if (decisions.length === 0) {
    console.log('nothing to decide')
    return
  }
  for (const d of decisions) {
    const task = ledger.get(d.taskId)
    console.log(`#${d.id}  ${d.reason}  (task #${task.id}: ${oneLine(task.brief, 60)})`)
    console.log(`${indent(d.question)}\n`)
  }
  console.log('answer: nod <decision> <answer>   end the task: nod drop <decision>')
}

function printTask(t: Task): void {
  const attempts = ledger.attempts(t.id)
  const cost = attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
  const last = attempts.at(-1)
  const note = t.error ?? last?.summary ?? t.brief
  console.log(
    `#${String(t.id).padEnd(4)} ${t.status.padEnd(14)} ${String(attempts.length).padStart(2)} tries ${`$${cost.toFixed(3)}`.padStart(7)}  ${oneLine(note, 70)}`,
  )
}

function printAttempt(a: Attempt): void {
  const secs = a.finishedAt ? `${secsBetween(a.startedAt, a.finishedAt)}s` : 'running'
  const check = a.checkResult ? ` check ${a.checkResult}` : ''
  const cost = a.costUsd === null ? '' : ` $${a.costUsd.toFixed(3)}`
  console.log(
    `  ${a.kind.padEnd(6)} ${(a.outcome ?? '-').padEnd(14)} ${secs}${cost}${check}  session ${a.sessionId}`,
  )
  const note = a.error ?? a.summary
  if (note) console.log(indent(oneLine(note, 200), 4))
}

// Function declarations, not consts: the top-level switch above runs before consts initialise.
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
