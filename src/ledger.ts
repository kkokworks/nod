import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'needs_decision'
  | 'cancelled'
  | 'error'
export type Outcome = 'succeeded' | 'failed' | 'needs_decision'
export type AttemptKind = 'start' | 'retry' | 'answer' | 'resume'
export type DecisionReason = 'question' | 'failed' | 'check_failed'

export type Task = {
  id: number
  brief: string
  repo: string | null
  checkCmd: string | null
  workspace: string | null
  status: TaskStatus
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export type Attempt = {
  id: number
  taskId: number
  kind: AttemptKind
  decisionId: number | null
  sessionId: string
  pid: number | null
  prompt: string
  outcome: Outcome | 'error' | null
  summary: string | null
  checkResult: 'passed' | 'failed' | null
  checkOutput: string | null
  costUsd: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export type Decision = {
  id: number
  taskId: number
  attemptId: number
  reason: DecisionReason
  question: string
  answer: string | null
  createdAt: string
  answeredAt: string | null
}

export type Stats = {
  tasks: Record<TaskStatus, number>
  succeededWithoutDecision: number
  attempts: number
  retries: number
  decisions: { total: number; open: number; medianWaitSecs: number | null }
  costUsd: number
}

// Append-only: never edit a shipped migration, add a new one.
const MIGRATIONS = [
  `
  create table tasks (
    id integer primary key,
    brief text not null,
    repo text,
    check_cmd text,
    workspace text,
    status text not null default 'queued',
    error text,
    created_at text not null,
    finished_at text
  );
  create table attempts (
    id integer primary key,
    task_id integer not null references tasks(id),
    kind text not null,
    decision_id integer references decisions(id),
    session_id text not null,
    prompt text not null,
    outcome text,
    summary text,
    check_result text,
    check_output text,
    cost_usd real,
    error text,
    started_at text not null,
    finished_at text
  );
  create table decisions (
    id integer primary key,
    task_id integer not null references tasks(id),
    attempt_id integer not null references attempts(id),
    reason text not null,
    question text not null,
    answer text,
    created_at text not null,
    answered_at text
  );
  create index attempts_task on attempts(task_id);
  create index decisions_task on decisions(task_id);
  `,
  // v2: the worker process, so a new runner can wait for a worker its dead predecessor started.
  'alter table attempts add column pid integer;',
]

const TASK = `id, brief, repo, check_cmd as checkCmd, workspace, status, error,
  created_at as createdAt, finished_at as finishedAt`
const ATTEMPT = `id, task_id as taskId, kind, decision_id as decisionId, session_id as sessionId,
  pid, prompt, outcome, summary, check_result as checkResult, check_output as checkOutput,
  cost_usd as costUsd, error, started_at as startedAt, finished_at as finishedAt`
const DECISION = `id, task_id as taskId, attempt_id as attemptId, reason, question, answer,
  created_at as createdAt, answered_at as answeredAt`

export const nodHome = (): string => process.env.NOD_HOME ?? join(homedir(), '.nod')

const now = (): string => new Date().toISOString()

export class Ledger {
  readonly db: Database

  constructor(home: string = nodHome()) {
    mkdirSync(home, { recursive: true })
    this.db = new Database(join(home, 'nod.db'), { create: true, strict: true })
    this.db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;')
    const version = this.db.query<{ user_version: number }, []>('pragma user_version').get()
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (i < (version?.user_version ?? 0)) continue
      this.db.transaction(() => {
        this.db.exec(sql)
        this.db.exec(`pragma user_version = ${i + 1}`)
      })()
    }
  }

  // ── tasks ──

  add(brief: string, repo: string | null, checkCmd: string | null): number {
    return this.insert(
      'insert into tasks (brief, repo, check_cmd, created_at) values ($brief, $repo, $checkCmd, $at)',
      { brief, repo, checkCmd, at: now() },
    )
  }

  get(id: number): Task {
    const task = this.db
      .query<Task, { id: number }>(`select ${TASK} from tasks where id = $id`)
      .get({ id })
    if (!task) throw new Error(`task ${id} not found`)
    return task
  }

  list(): Task[] {
    return this.db.query<Task, []>(`select ${TASK} from tasks order by id`).all()
  }

  ready(): Task[] {
    return this.db
      .query<Task, []>(`select ${TASK} from tasks where status = 'queued' order by id`)
      .all()
  }

  setRunning(id: number, workspace: string): void {
    this.db
      .query(`update tasks set status = 'running', workspace = $workspace where id = $id`)
      .run({ id, workspace })
  }

  succeed(id: number): void {
    this.setStatus(id, 'succeeded', null)
  }

  error(id: number, message: string): void {
    this.setStatus(id, 'error', message)
  }

  // A previous `nod run` died mid-task. Its open attempts stay open: the next runner adopts
  // them (see runner.recover), so a worker that finished or is still running is not repeated.
  requeueRunning(): number {
    return this.db.query(`update tasks set status = 'queued' where status = 'running'`).run()
      .changes
  }

  // ── attempts ──

  startAttempt(a: {
    taskId: number
    kind: AttemptKind
    decisionId: number | null
    sessionId: string
    prompt: string
  }): number {
    return this.insert(
      `insert into attempts (task_id, kind, decision_id, session_id, prompt, started_at)
       values ($taskId, $kind, $decisionId, $sessionId, $prompt, $at)`,
      { ...a, at: now() },
    )
  }

  endAttempt(
    id: number,
    r: { sessionId: string; outcome: Outcome; summary: string; costUsd: number },
  ): void {
    this.db
      .query(
        `update attempts set session_id = $sessionId, outcome = $outcome, summary = $summary,
           cost_usd = $costUsd, finished_at = $at where id = $id`,
      )
      .run({ id, ...r, at: now() })
  }

  failAttempt(id: number, error: string): void {
    this.db
      .query(
        `update attempts set outcome = 'error', error = $error, finished_at = $at where id = $id`,
      )
      .run({ id, error, at: now() })
  }

  recordCheck(id: number, passed: boolean, output: string): void {
    this.db
      .query('update attempts set check_result = $result, check_output = $output where id = $id')
      .run({ id, result: passed ? 'passed' : 'failed', output })
  }

  attempts(taskId: number): Attempt[] {
    return this.db
      .query<Attempt, { taskId: number }>(
        `select ${ATTEMPT} from attempts where task_id = $taskId order by id`,
      )
      .all({ taskId })
  }

  setPid(id: number, pid: number): void {
    this.db.query('update attempts set pid = $pid where id = $id').run({ id, pid })
  }

  openAttempt(taskId: number): Attempt | null {
    return this.attempts(taskId).find((a) => a.finishedAt === null) ?? null
  }

  lastAttempt(taskId: number): Attempt | null {
    return this.attempts(taskId).at(-1) ?? null
  }

  // ── decisions ──

  ask(taskId: number, attemptId: number, reason: DecisionReason, question: string): number {
    return this.db.transaction(() => {
      this.setStatus(taskId, 'needs_decision', null)
      return this.insert(
        `insert into decisions (task_id, attempt_id, reason, question, created_at)
         values ($taskId, $attemptId, $reason, $question, $at)`,
        { taskId, attemptId, reason, question, at: now() },
      )
    })()
  }

  answer(decisionId: number, answer: string): void {
    this.close(decisionId, answer, 'queued')
  }

  // The human ends the task instead of answering, so no worker runs (and nothing counts it a success).
  drop(decisionId: number): void {
    this.close(decisionId, '(dropped)', 'cancelled')
  }

  private close(decisionId: number, answer: string, next: TaskStatus): void {
    this.db.transaction(() => {
      const decision = this.decision(decisionId)
      if (decision.answer !== null) throw new Error(`decision ${decisionId} is already answered`)
      this.db
        .query('update decisions set answer = $answer, answered_at = $at where id = $id')
        .run({ id: decisionId, answer, at: now() })
      this.setStatus(decision.taskId, next, null)
    })()
  }

  decision(id: number): Decision {
    const d = this.db
      .query<Decision, { id: number }>(`select ${DECISION} from decisions where id = $id`)
      .get({ id })
    if (!d) throw new Error(`decision ${id} not found`)
    return d
  }

  decisions(taskId: number): Decision[] {
    return this.db
      .query<Decision, { taskId: number }>(
        `select ${DECISION} from decisions where task_id = $taskId order by id`,
      )
      .all({ taskId })
  }

  openDecisions(): Decision[] {
    return this.db
      .query<Decision, []>(`select ${DECISION} from decisions where answer is null order by id`)
      .all()
  }

  // An answer no attempt has acted on yet.
  pendingAnswer(taskId: number): Decision | null {
    return (
      this.db
        .query<Decision, { taskId: number }>(
          `select ${DECISION} from decisions d where task_id = $taskId and answer is not null
           and not exists (select 1 from attempts a where a.decision_id = d.id)
           order by id limit 1`,
        )
        .get({ taskId }) ?? null
    )
  }

  // ── reporting ──

  stats(): Stats {
    const tasks: Record<TaskStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      needs_decision: 0,
      cancelled: 0,
      error: 0,
    }
    for (const row of this.db
      .query<{ status: TaskStatus; n: number }, []>(
        'select status, count(*) as n from tasks group by status',
      )
      .all()) {
      tasks[row.status] = row.n
    }
    const one = (sql: string): number => this.db.query<{ n: number | null }, []>(sql).get()?.n ?? 0
    const waits = this.db
      .query<{ secs: number }, []>(
        `select (julianday(answered_at) - julianday(created_at)) * 86400 as secs
         from decisions where answered_at is not null order by secs`,
      )
      .all()
      .map((r) => r.secs)
    return {
      tasks,
      succeededWithoutDecision: one(
        `select count(*) as n from tasks t where status = 'succeeded'
         and not exists (select 1 from decisions d where d.task_id = t.id)`,
      ),
      attempts: one('select count(*) as n from attempts'),
      retries: one(`select count(*) as n from attempts where kind = 'retry'`),
      decisions: {
        total: one('select count(*) as n from decisions'),
        open: one('select count(*) as n from decisions where answer is null'),
        medianWaitSecs: median(waits),
      },
      // Rounded to 1/100 cent so float sums compare exactly.
      costUsd: Math.round(one('select sum(cost_usd) as n from attempts') * 1e4) / 1e4,
    }
  }

  private setStatus(id: number, status: TaskStatus, error: string | null): void {
    const finishedAt = ['succeeded', 'cancelled', 'error'].includes(status) ? now() : null
    this.db
      .query(
        'update tasks set status = $status, error = $error, finished_at = $finishedAt where id = $id',
      )
      .run({ id, status, error, finishedAt })
  }

  private insert(sql: string, params: Record<string, string | number | null>): number {
    const row = this.db
      .query<{ id: number }, Record<string, string | number | null>>(`${sql} returning id`)
      .get(params)
    if (!row) throw new Error('insert returned no id')
    return row.id
  }
}

function median(sorted: number[]): number | null {
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid]
  if (hi === undefined) return null
  const lo = sorted.length % 2 === 0 ? sorted[mid - 1] : hi
  return Math.round(((lo ?? hi) + hi) / 2)
}
