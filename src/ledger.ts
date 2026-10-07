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
export type AttemptKind = 'start' | 'retry' | 'answer' | 'resume' | 'followup'
export type DecisionReason =
  | 'question'
  | 'failed'
  | 'check_failed'
  | 'permission'
  | 'trust'
  | 'rule'

export type Task = {
  id: number
  brief: string
  repo: string | null
  checkCmd: string | null
  model: string | null
  triggerId: number | null
  // Set on a retrospective: the task whose trouble it looks back on.
  retroOf: number | null
  workspace: string | null
  status: TaskStatus
  error: string | null
  createdAt: string
  finishedAt: string | null
}

// Adds tasks on a schedule. With a source command, each line it prints that the trigger has not
// seen before becomes a task.
export type Trigger = {
  id: number
  cron: string
  brief: string
  repo: string | null
  checkCmd: string | null
  model: string | null
  source: string | null
  lastRunAt: string | null
  lastError: string | null
  createdAt: string
}

export type Attempt = {
  id: number
  taskId: number
  kind: AttemptKind
  decisionId: number | null
  sessionId: string
  prompt: string
  outcome: Outcome | 'error' | null
  summary: string | null
  report: string | null
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
  // v3: tasks that wait for others, and the model, since a waiting task starts long after `nod add`.
  `
  create table task_deps (
    task_id integer not null references tasks(id),
    after_id integer not null references tasks(id),
    primary key (task_id, after_id)
  );
  alter table tasks add column model text;
  `,
  // v4: triggers, the source items each has seen, and which trigger added a task.
  `
  create table triggers (
    id integer primary key,
    cron text not null,
    brief text not null,
    repo text,
    check_cmd text,
    model text,
    source text,
    last_run_at text,
    last_error text,
    created_at text not null,
    removed_at text
  );
  create table trigger_items (
    trigger_id integer not null references triggers(id),
    key text not null,
    task_id integer references tasks(id),
    seen_at text not null,
    primary key (trigger_id, key)
  );
  alter table tasks add column trigger_id integer references triggers(id);
  `,
  // v5: retrospectives, which are tasks that look back on another task.
  'alter table tasks add column retro_of integer references tasks(id);',
  // v6: the worker's whole last message, since the report line alone drops the answer people read.
  'alter table attempts add column report text;',
]

const TASK = `id, brief, repo, check_cmd as checkCmd, model, trigger_id as triggerId,
  retro_of as retroOf, workspace, status, error, created_at as createdAt, finished_at as finishedAt`
const TRIGGER = `id, cron, brief, repo, check_cmd as checkCmd, model, source,
  last_run_at as lastRunAt, last_error as lastError, created_at as createdAt`
const ATTEMPT = `id, task_id as taskId, kind, decision_id as decisionId, session_id as sessionId,
  prompt, outcome, summary, report, check_result as checkResult, check_output as checkOutput,
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

  // `after`: tasks that must succeed before this one starts. In one repo they must form a chain,
  // because a task's worktree starts from the branch of the task it comes after.
  add(t: {
    brief: string
    repo: string | null
    checkCmd: string | null
    model: string | null
    after: number[]
    triggerId: number | null
  }): number {
    return this.db.transaction(() => {
      const after = t.after.map((id) => this.get(id))
      const sameRepo = after.filter((a) => t.repo !== null && a.repo === t.repo)
      if (sameRepo.length > 1) {
        const ids = sameRepo.map((a) => `#${a.id}`).join(', ')
        throw new Error(
          `${ids} all work in ${t.repo}; a task can come after only one task in its repo, so chain them`,
        )
      }
      const id = this.insert(
        `insert into tasks (brief, repo, check_cmd, model, trigger_id, created_at)
         values ($brief, $repo, $checkCmd, $model, $triggerId, $at)`,
        {
          brief: t.brief,
          repo: t.repo,
          checkCmd: t.checkCmd,
          model: t.model,
          triggerId: t.triggerId,
          at: now(),
        },
      )
      for (const a of after) {
        this.db
          .query('insert into task_deps (task_id, after_id) values ($id, $after)')
          .run({ id, after: a.id })
      }
      return id
    })()
  }

  // The tasks this one comes after.
  after(id: number): Task[] {
    return this.db
      .query<Task, { id: number }>(
        `select ${TASK} from tasks where id in (select after_id from task_deps where task_id = $id)
         order by id`,
      )
      .all({ id })
  }

  // Marks running the waiting tasks whose earlier tasks have all succeeded, and returns them. One
  // statement, so two workers finishing at once cannot both start the same task.
  claimReady(): number[] {
    return this.db
      .query<{ id: number }, []>(
        `update tasks set status = 'running'
         where status = 'queued'
           and exists (select 1 from task_deps d where d.task_id = tasks.id)
           and not exists (
             select 1 from task_deps d join tasks a on a.id = d.after_id
             where d.task_id = tasks.id and a.status != 'succeeded'
           )
         returning id`,
      )
      .all()
      .map((r) => r.id)
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

  // ── triggers ──

  // `seen`: keys the source lists already, which never become tasks.
  addTrigger(t: {
    cron: string
    brief: string
    repo: string | null
    checkCmd: string | null
    model: string | null
    source: string | null
    seen: string[]
  }): number {
    return this.db.transaction(() => {
      const id = this.insert(
        `insert into triggers (cron, brief, repo, check_cmd, model, source, created_at)
         values ($cron, $brief, $repo, $checkCmd, $model, $source, $at)`,
        {
          cron: t.cron,
          brief: t.brief,
          repo: t.repo,
          checkCmd: t.checkCmd,
          model: t.model,
          source: t.source,
          at: now(),
        },
      )
      for (const key of t.seen) {
        this.db
          .query(
            `insert or ignore into trigger_items (trigger_id, key, seen_at)
             values ($id, $key, $at)`,
          )
          .run({ id, key, at: now() })
      }
      return id
    })()
  }

  triggers(): Trigger[] {
    return this.db
      .query<Trigger, []>(`select ${TRIGGER} from triggers where removed_at is null order by id`)
      .all()
  }

  trigger(id: number): Trigger {
    const t = this.db
      .query<Trigger, { id: number }>(`select ${TRIGGER} from triggers where id = $id`)
      .get({ id })
    if (!t) throw new Error(`trigger ${id} not found`)
    return t
  }

  removeTrigger(id: number): void {
    const removed = this.db
      .query<{ id: number }, { id: number; at: string }>(
        'update triggers set removed_at = $at where id = $id and removed_at is null returning id',
      )
      .get({ id, at: now() })
    if (!removed) throw new Error(`trigger ${id} not found`)
  }

  // Records a run at `at` unless another tick has recorded one since `last`, so a run happens once
  // even if two ticks overlap. Returns whether this caller got the run.
  claimRun(id: number, last: string | null, at: string): boolean {
    const row = this.db
      .query<{ id: number }, { id: number; last: string | null; at: string }>(
        `update triggers set last_run_at = $at
         where id = $id and last_run_at is $last returning id`,
      )
      .get({ id, last, at })
    return row !== null
  }

  recordRunError(id: number, error: string | null): void {
    this.db.query('update triggers set last_error = $error where id = $id').run({ id, error })
  }

  // Adds a task for a source item the trigger has not seen, in one transaction with marking it
  // seen. Returns null for an item seen before.
  addItemTask(trigger: Trigger, key: string, brief: string): number | null {
    return this.db.transaction(() => {
      const fresh = this.db
        .query<{ key: string }, { id: number; key: string; at: string }>(
          `insert or ignore into trigger_items (trigger_id, key, seen_at) values ($id, $key, $at)
           returning key`,
        )
        .get({ id: trigger.id, key, at: now() })
      if (!fresh) return null
      const taskId = this.add({
        brief,
        repo: trigger.repo,
        checkCmd: trigger.checkCmd,
        model: trigger.model,
        after: [],
        triggerId: trigger.id,
      })
      this.db
        .query('update trigger_items set task_id = $taskId where trigger_id = $id and key = $key')
        .run({ taskId, id: trigger.id, key })
      return taskId
    })()
  }

  // A task that looks back on `of`, in an empty folder with the same model.
  addRetro(of: Task, brief: string): number {
    return this.db.transaction(() => {
      const id = this.add({
        brief,
        repo: null,
        checkCmd: null,
        model: of.model,
        after: [],
        triggerId: null,
      })
      this.db.query('update tasks set retro_of = $of where id = $id').run({ of: of.id, id })
      return id
    })()
  }

  // The retrospective of a task, if one was started.
  retroFor(taskId: number): number | null {
    const row = this.db
      .query<{ id: number }, { taskId: number }>(
        'select id from tasks where retro_of = $taskId order by id limit 1',
      )
      .get({ taskId })
    return row === null ? null : row.id
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

  // Interactive sessions do not report cost, so cost_usd stays empty for these attempts.
  endAttempt(id: number, r: { outcome: Outcome; summary: string; report: string | null }): void {
    this.db
      .query(
        `update attempts set outcome = $outcome, summary = $summary, report = $report,
         finished_at = $at where id = $id`,
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

  attempt(id: number): Attempt {
    const a = this.db
      .query<Attempt, { id: number }>(`select ${ATTEMPT} from attempts where id = $id`)
      .get({ id })
    if (!a) throw new Error(`attempt ${id} not found`)
    return a
  }

  openAttempt(taskId: number): Attempt | null {
    return this.attempts(taskId).find((a) => a.finishedAt === null) ?? null
  }

  lastAttempt(taskId: number): Attempt | null {
    return this.attempts(taskId).at(-1) ?? null
  }

  // The task a worker session belongs to; null for a session nod did not start.
  taskOfSession(sessionId: string): number | null {
    const row = this.db
      .query<{ taskId: number }, { sessionId: string }>(
        `select task_id as taskId from attempts where session_id = $sessionId
         order by id desc limit 1`,
      )
      .get({ sessionId })
    return row === null ? null : row.taskId
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
    this.close(decisionId, answer, 'running')
  }

  // The human ends the task instead of answering, so nothing counts it a success.
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
    // A task that waits for a cancelled one can never start. An error is left alone: the task can
    // still be resumed and succeed.
    if (status !== 'cancelled') return
    const waiting = this.db
      .query<{ id: number }, { id: number }>(
        `select t.id from task_deps d join tasks t on t.id = d.task_id
         where d.after_id = $id and t.status = 'queued'`,
      )
      .all({ id })
    for (const w of waiting) {
      this.setStatus(w.id, 'cancelled', `task #${id} it waits for was cancelled`)
    }
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
