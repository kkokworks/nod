import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CamelCasePlugin,
  type Compilable,
  DummyDriver,
  type Generated,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely'

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
  // The issue the task works on, such as `PROJ-12`, so tasks and their decisions can be seen by
  // issue. From `--issue`, or the key of the source item that added it.
  issue: string | null
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
  // v7: the issue a task works on.
  'alter table tasks add column issue text;',
]

// The tables as the migrations leave them, in camelCase; CamelCasePlugin maps names to snake_case.
type Tables = {
  tasks: Omit<Task, 'id' | 'status'> & { id: Generated<number>; status: Generated<TaskStatus> }
  taskDeps: { taskId: number; afterId: number }
  triggers: Omit<Trigger, 'id'> & { id: Generated<number>; removedAt: string | null }
  triggerItems: { triggerId: number; key: string; taskId: number | null; seenAt: string }
  attempts: Omit<Attempt, 'id'> & { id: Generated<number>; pid: number | null }
  decisions: Omit<Decision, 'id'> & { id: Generated<number> }
}

// Kysely only builds and type-checks the queries; bun:sqlite runs them, so the ledger stays
// synchronous and its transactions stay bun:sqlite ones.
const q = new Kysely<Tables>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
  plugins: [new CamelCasePlugin()],
})

// Trigger and Attempt leave out a column their table has.
const TRIGGER = [
  'id',
  'cron',
  'brief',
  'repo',
  'checkCmd',
  'model',
  'source',
  'lastRunAt',
  'lastError',
  'createdAt',
] as const
const ATTEMPT = [
  'id',
  'taskId',
  'kind',
  'decisionId',
  'sessionId',
  'prompt',
  'outcome',
  'summary',
  'report',
  'checkResult',
  'checkOutput',
  'costUsd',
  'error',
  'startedAt',
  'finishedAt',
] as const
const count = q.fn.countAll<number>().as('n')

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
    issue: string | null
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
        q
          .insertInto('tasks')
          .values({
            brief: t.brief,
            repo: t.repo,
            checkCmd: t.checkCmd,
            model: t.model,
            triggerId: t.triggerId,
            issue: t.issue,
            createdAt: now(),
          })
          .returning('id'),
      )
      for (const a of after) {
        this.run(q.insertInto('taskDeps').values({ taskId: id, afterId: a.id }))
      }
      return id
    })()
  }

  // The tasks this one comes after.
  after(id: number): Task[] {
    return this.run(
      q
        .selectFrom('tasks')
        .selectAll()
        .where('id', 'in', q.selectFrom('taskDeps').select('afterId').where('taskId', '=', id))
        .orderBy('id'),
    )
  }

  // Marks running the waiting tasks whose earlier tasks have all succeeded, and returns them. One
  // statement, so two workers finishing at once cannot both start the same task.
  claimReady(): number[] {
    return this.run(
      q
        .updateTable('tasks')
        .set({ status: 'running' })
        .where('status', '=', 'queued')
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom('taskDeps as d').select('d.taskId').whereRef('d.taskId', '=', 'tasks.id'),
          ),
        )
        .where(({ exists, not, selectFrom }) =>
          not(
            exists(
              selectFrom('taskDeps as d')
                .innerJoin('tasks as a', 'a.id', 'd.afterId')
                .select('a.id')
                .whereRef('d.taskId', '=', 'tasks.id')
                .where('a.status', '!=', 'succeeded'),
            ),
          ),
        )
        .returning('id'),
    ).map((r) => r.id)
  }

  get(id: number): Task {
    const task = this.first(q.selectFrom('tasks').selectAll().where('id', '=', id))
    if (!task) throw new Error(`task ${id} not found`)
    return task
  }

  list(): Task[] {
    return this.run(q.selectFrom('tasks').selectAll().orderBy('id'))
  }

  setRunning(id: number, workspace: string): void {
    this.run(q.updateTable('tasks').set({ status: 'running', workspace }).where('id', '=', id))
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
        q
          .insertInto('triggers')
          .values({
            cron: t.cron,
            brief: t.brief,
            repo: t.repo,
            checkCmd: t.checkCmd,
            model: t.model,
            source: t.source,
            createdAt: now(),
          })
          .returning('id'),
      )
      for (const key of t.seen) {
        this.run(
          q.insertInto('triggerItems').orIgnore().values({ triggerId: id, key, seenAt: now() }),
        )
      }
      return id
    })()
  }

  triggers(): Trigger[] {
    return this.run(
      q.selectFrom('triggers').select(TRIGGER).where('removedAt', 'is', null).orderBy('id'),
    )
  }

  trigger(id: number): Trigger {
    const t = this.first(q.selectFrom('triggers').select(TRIGGER).where('id', '=', id))
    if (!t) throw new Error(`trigger ${id} not found`)
    return t
  }

  removeTrigger(id: number): void {
    const removed = this.first(
      q
        .updateTable('triggers')
        .set({ removedAt: now() })
        .where('id', '=', id)
        .where('removedAt', 'is', null)
        .returning('id'),
    )
    if (!removed) throw new Error(`trigger ${id} not found`)
  }

  // Records a run at `at` unless another tick has recorded one since `last`, so a run happens once
  // even if two ticks overlap. Returns whether this caller got the run.
  claimRun(id: number, last: string | null, at: string): boolean {
    const row = this.first(
      q
        .updateTable('triggers')
        .set({ lastRunAt: at })
        .where('id', '=', id)
        .where('lastRunAt', 'is', last)
        .returning('id'),
    )
    return row !== null
  }

  recordRunError(id: number, error: string | null): void {
    this.run(q.updateTable('triggers').set({ lastError: error }).where('id', '=', id))
  }

  // Adds a task for a source item the trigger has not seen, in one transaction with marking it
  // seen. Returns null for an item seen before.
  addItemTask(trigger: Trigger, key: string, issue: string | null, brief: string): number | null {
    return this.db.transaction(() => {
      const fresh = this.first(
        q
          .insertInto('triggerItems')
          .orIgnore()
          .values({ triggerId: trigger.id, key, seenAt: now() })
          .returning('key'),
      )
      if (!fresh) return null
      const taskId = this.add({
        brief,
        repo: trigger.repo,
        checkCmd: trigger.checkCmd,
        model: trigger.model,
        after: [],
        triggerId: trigger.id,
        issue,
      })
      this.run(
        q
          .updateTable('triggerItems')
          .set({ taskId })
          .where('triggerId', '=', trigger.id)
          .where('key', '=', key),
      )
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
        issue: of.issue,
      })
      this.run(q.updateTable('tasks').set({ retroOf: of.id }).where('id', '=', id))
      return id
    })()
  }

  // The retrospective of a task, if one was started.
  retroFor(taskId: number): number | null {
    const row = this.first(
      q.selectFrom('tasks').select('id').where('retroOf', '=', taskId).orderBy('id').limit(1),
    )
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
      q
        .insertInto('attempts')
        .values({ ...a, startedAt: now() })
        .returning('id'),
    )
  }

  // Interactive sessions do not report cost, so cost_usd stays empty for these attempts.
  endAttempt(id: number, r: { outcome: Outcome; summary: string; report: string | null }): void {
    this.run(
      q
        .updateTable('attempts')
        .set({ ...r, finishedAt: now() })
        .where('id', '=', id),
    )
  }

  failAttempt(id: number, error: string): void {
    this.run(
      q
        .updateTable('attempts')
        .set({ outcome: 'error', error, finishedAt: now() })
        .where('id', '=', id),
    )
  }

  recordCheck(id: number, passed: boolean, output: string): void {
    this.run(
      q
        .updateTable('attempts')
        .set({ checkResult: passed ? 'passed' : 'failed', checkOutput: output })
        .where('id', '=', id),
    )
  }

  attempts(taskId: number): Attempt[] {
    return this.run(
      q.selectFrom('attempts').select(ATTEMPT).where('taskId', '=', taskId).orderBy('id'),
    )
  }

  attempt(id: number): Attempt {
    const a = this.first(q.selectFrom('attempts').select(ATTEMPT).where('id', '=', id))
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
    const row = this.first(
      q
        .selectFrom('attempts')
        .select('taskId')
        .where('sessionId', '=', sessionId)
        .orderBy('id', 'desc')
        .limit(1),
    )
    return row === null ? null : row.taskId
  }

  // ── decisions ──

  ask(taskId: number, attemptId: number, reason: DecisionReason, question: string): number {
    return this.db.transaction(() => {
      this.setStatus(taskId, 'needs_decision', null)
      return this.insert(
        q
          .insertInto('decisions')
          .values({ taskId, attemptId, reason, question, createdAt: now() })
          .returning('id'),
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
      this.run(
        q.updateTable('decisions').set({ answer, answeredAt: now() }).where('id', '=', decisionId),
      )
      this.setStatus(decision.taskId, next, null)
    })()
  }

  decision(id: number): Decision {
    const d = this.first(q.selectFrom('decisions').selectAll().where('id', '=', id))
    if (!d) throw new Error(`decision ${id} not found`)
    return d
  }

  decisions(taskId: number): Decision[] {
    return this.run(
      q.selectFrom('decisions').selectAll().where('taskId', '=', taskId).orderBy('id'),
    )
  }

  openDecisions(): Decision[] {
    return this.run(q.selectFrom('decisions').selectAll().where('answer', 'is', null).orderBy('id'))
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
    for (const row of this.run(q.selectFrom('tasks').select(['status', count]).groupBy('status'))) {
      tasks[row.status] = row.n
    }
    const one = (query: Compilable<{ n: number | null }>): number => this.first(query)?.n ?? 0
    const waits = this.run(
      q
        .selectFrom('decisions')
        // Raw SQL is not renamed by CamelCasePlugin, so its columns are snake_case.
        .select(sql<number>`(julianday(answered_at) - julianday(created_at)) * 86400`.as('secs'))
        .where('answeredAt', 'is not', null)
        .orderBy('secs'),
    ).map((r) => r.secs)
    return {
      tasks,
      succeededWithoutDecision: one(
        q
          .selectFrom('tasks as t')
          .select(count)
          .where('status', '=', 'succeeded')
          .where(({ exists, not, selectFrom }) =>
            not(
              exists(selectFrom('decisions as d').select('d.id').whereRef('d.taskId', '=', 't.id')),
            ),
          ),
      ),
      attempts: one(q.selectFrom('attempts').select(count)),
      retries: one(q.selectFrom('attempts').select(count).where('kind', '=', 'retry')),
      decisions: {
        total: one(q.selectFrom('decisions').select(count)),
        open: one(q.selectFrom('decisions').select(count).where('answer', 'is', null)),
        medianWaitSecs: median(waits),
      },
      // Rounded to 1/100 cent so float sums compare exactly.
      costUsd:
        Math.round(
          one(q.selectFrom('attempts').select(q.fn.sum<number | null>('costUsd').as('n'))) * 1e4,
        ) / 1e4,
    }
  }

  private setStatus(id: number, status: TaskStatus, error: string | null): void {
    const finishedAt = ['succeeded', 'cancelled', 'error'].includes(status) ? now() : null
    this.run(q.updateTable('tasks').set({ status, error, finishedAt }).where('id', '=', id))
    // A task that waits for a cancelled one can never start. An error is left alone: the task can
    // still be resumed and succeed.
    if (status !== 'cancelled') return
    const waiting = this.run(
      q
        .selectFrom('taskDeps as d')
        .innerJoin('tasks as t', 't.id', 'd.taskId')
        .select('t.id')
        .where('d.afterId', '=', id)
        .where('t.status', '=', 'queued'),
    )
    for (const w of waiting) {
      this.setStatus(w.id, 'cancelled', `task #${id} it waits for was cancelled`)
    }
  }

  private insert(query: Compilable<{ id: number }>): number {
    const row = this.first(query)
    if (!row) throw new Error('insert returned no id')
    return row.id
  }

  // Runs a query and returns its rows, whether or not it reads any.
  private run<O>(query: Compilable<O>): O[] {
    const { sql, parameters } = query.compile()
    const rows = this.db
      .query<Record<string, unknown>, SQLQueryBindings[]>(sql)
      // Kysely compiles only the values the query was typed with: strings, numbers and nulls.
      .all(...(parameters as SQLQueryBindings[]))
    // CamelCasePlugin renames result columns only when Kysely runs the query, so do it here.
    return rows.map(camelKeys) as O[]
  }

  private first<O>(query: Compilable<O>): O | null {
    return this.run(query)[0] ?? null
  }
}

const camelKeys = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  )

function median(sorted: number[]): number | null {
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid]
  if (hi === undefined) return null
  const lo = sorted.length % 2 === 0 ? sorted[mid - 1] : hi
  return Math.round(((lo ?? hi) + hi) / 2)
}
