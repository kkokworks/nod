import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
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
// The statuses a task ends in, which stamp its finishedAt (setStatus).
export const FINISHED: ReadonlySet<TaskStatus> = new Set(['succeeded', 'cancelled', 'error'])
// `waiting`: the turn ended while background work the worker started still ran, which starts its
// next turn once done, so nobody is asked anything yet (settle in worker.ts).
export type Outcome = 'succeeded' | 'failed' | 'needs_decision' | 'waiting'
// `land`: a turn nod gave the worker as it lands the task (land.ts): a conflict, a failed check,
// the pull request's text.
export type AttemptKind = 'start' | 'retry' | 'answer' | 'resume' | 'followup' | 'land'
export type DecisionReason =
  | 'question'
  | 'failed'
  | 'check_failed'
  | 'permission'
  | 'trust'
  | 'rule'
  // The worker's Claude Code ended in the middle of a turn, or kept exiting as it started.
  | 'interrupted'
  // Landing the task stopped on something only the person can clear (a push or merge the git
  // service refused, say): yes tries again, anything else stops landing it.
  | 'land'

export type Task = {
  id: number
  brief: string
  repo: string | null
  // The branch a repo task works on, named at `nod add`; a trigger's task gets
  // `<trigger branch>/<task id>`. Null without a repo.
  branch: string | null
  checkCmd: string | null
  model: string | null
  triggerId: number | null
  // The issue the task works on, such as `PROJ-12`, so tasks and their decisions can be seen by
  // issue. From `--issue`, or the key of the source item that added it.
  issue: string | null
  // Set on the task a retrospective runs in: the retrospective (r<n>), which names the task whose
  // trouble it looks back on.
  retroId: number | null
  // The person's todo the task does, when it was delegated from one (todos.ts).
  todoId: number | null
  // The Claude session that ran `nod add`, its whole id so `claude --resume` can reopen it; a
  // retrospective takes its task's. Null for a task added outside a Claude session.
  rootSession: string | null
  workspace: string | null
  // Set by gc: the human has dealt with what the task produced, so ls stops listing it.
  collectedAt: string | null
  // Set by gc on a repo task: the commit its branch pointed at, to rebuild the worktree from.
  head: string | null
  // The CLAUDE_CONFIG_DIR its Claude Code last started with, '' for none. Set by the terminal that
  // keeps Claude Code running (keepWorker in worker.ts), so null means no such terminal started it.
  account: string | null
  status: TaskStatus
  error: string | null
  createdAt: string
  finishedAt: string | null
}

// A look back at a task that ran into trouble (startRetro in worker.ts). It is nod's own record, so
// it is kept apart from the person's todos: the rule it proposed, null until it reports one, and
// what became of it, null while it runs or after it errored. `declined` is a rule the person turned
// down; `dropped`, a retrospective ended before it proposed one; `todo`, one that put a fix for nod
// or the task's repo or check in the person's inbox instead of proposing a rule.
export type RetroOutcome = 'added' | 'declined' | 'none' | 'dropped' | 'todo'
export type Retro = {
  id: number
  ofTaskId: number
  rule: string | null
  outcome: RetroOutcome | null
  createdAt: string
  endedAt: string | null
}

// A rule every worker gets after the built-in ones, while it is on: one a retrospective proposed and
// the person approved, or one the person wrote (retroId null). Nothing deletes a rule; turned off,
// it stays tied to the retrospective it came from. Every change records who made it, as a todo's do.
export type RuleState = 'on' | 'off'
export type Rule = {
  id: number
  text: string
  retroId: number | null
  state: RuleState
  createdAt: string
  changedAt: string
}
export type RuleEdit = Partial<Pick<Rule, 'text' | 'state'>>
// A rule as it stands now, edited once its words differ from what its retrospective proposed. One
// the person wrote has no proposal, so it is never edited.
export type RuleNow = Rule & { edited: boolean }
// Each field a change set, as [before, after], the way todo_changes keeps it (todos.ts).
type Changed = Record<string, [unknown, unknown]>

// How far nod takes a repo task's work once it succeeds (land.ts): not at all, as before; up to a
// pull request on the default branch; or through its squash merge. Only the person sets it.
export type LandLevel = 'off' | 'pr' | 'merge'
export const LAND_LEVELS: readonly LandLevel[] = ['off', 'pr', 'merge']
// A repo as nod may land its tasks, keyed by the path tasks record (`tasks.repo`). `checkCmd`: the
// full check after each rebase, else the task's own; `gateCmd`: the person's check before each push.
// `raisedAt`: when `land` last went up from off; tasks added since land on their own.
export type Repo = {
  path: string
  land: LandLevel
  checkCmd: string | null
  gateCmd: string | null
  raisedAt: string | null
  changedAt: string
}
export type RepoEdit = Partial<Pick<Repo, 'land' | 'checkCmd' | 'gateCmd'>>
export type RepoChange = { actor: string; change: Changed; at: string }
// How far a task's landing has got (land.ts). `base`: the commit its own work sits on, moved by
// each rebase; `ready`: the head that passed the check on that base; `pushed`: what nod last
// pushed to its branch; `pr`: the pull request nod opened. `handedAt`: since when the worker has
// landing work (a conflict, a failed check, the pull request's text) it has not finished; `busy`:
// the process working in its worktree right now. `stopped`: why landing stopped, null while it goes
// on; `note`: what it waits for or last failed on, which the person hears once each time it changes.
export type Landing = {
  taskId: number
  base: string | null
  ready: string | null
  title: string | null
  body: string | null
  pushed: string | null
  pr: string | null
  handedAt: string | null
  busy: number | null
  stopped: string | null
  note: string | null
  mergedAt: string | null
  updatedAt: string
}
export type LandingEdit = Partial<Omit<Landing, 'taskId' | 'updatedAt'>>

// Adds tasks on a schedule. With a source command, each line it prints that the trigger has not
// seen before becomes a task.
// What `nod add` gives a new task.
export type NewTask = {
  brief: string
  repo: string | null
  branch: string | null
  checkCmd: string | null
  model: string | null
  after: number[]
  triggerId: number | null
  issue: string | null
  // Left out by the tasks nod adds on its own (triggers).
  rootSession?: string | null
}

export type Trigger = {
  id: number
  cron: string
  brief: string
  repo: string | null
  // With a repo: the prefix of its tasks' branches.
  branch: string | null
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
  // The task whose worker sent the message that started this turn (`NOD: tell`); null for the
  // person's, nod's, or one Claude Code went on to by itself.
  fromTask: number | null
}

// A message that went into the turn `attemptId` while it ran (deliver in worker.ts). `fromTask`:
// as on an attempt.
export type Message = {
  id: number
  taskId: number
  attemptId: number
  text: string
  createdAt: string
  fromTask: number | null
}

export type Decision = {
  id: number
  taskId: number
  attemptId: number
  reason: DecisionReason
  question: string
  answer: string | null
  createdAt: string
  // When a person's answer reached a turn waiting on it; null while open, and for one closed while
  // no turn waited on it (dismiss).
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

// Append-only: never edit a shipped migration, add a new one. Exported so a test can build a ledger
// as an older version left it.
export const MIGRATIONS = [
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
  // v8: where a task's result went (a pull request, a posted review), and when gc collected it.
  `
  create table links (
    task_id integer not null references tasks(id),
    url text not null,
    created_at text not null,
    primary key (task_id, url)
  );
  alter table tasks add column collected_at text;
  `,
  // v9: the branch a repo task works on, and a trigger's prefix for its tasks' branches. Repo
  // tasks before this worked on `nod/<id>`.
  `
  alter table tasks add column branch text;
  update tasks set branch = 'nod/' || id where repo is not null;
  alter table triggers add column branch text;
  `,
  // v10: the person's own todos and projects, kept GTD-style (todos.ts). A todo is not a task: it
  // is something to do, by the person or, once delegated, by a task. Statuses are checked in
  // todos.ts, as tasks' are in code: a CHECK constraint in SQLite changes only by rebuilding the
  // table, which the foreign keys pointing at it make hard inside a migration.
  `
  create table projects (
    id integer primary key,
    title text not null,
    outcome text,
    status text not null default 'active',
    created_at text not null,
    status_at text not null
  );
  create table todos (
    id integer primary key,
    title text not null,
    notes text,
    status text not null default 'inbox',
    project_id integer references projects(id),
    context text,
    waiting_on text,
    source text not null,
    source_key text,
    created_at text not null,
    status_at text not null
  );
  create unique index todos_source_key on todos(source, source_key) where source_key is not null;
  create index todos_status on todos(status);
  create table todo_links (
    todo_id integer not null references todos(id),
    url text not null,
    title text,
    created_at text not null,
    primary key (todo_id, url)
  );
  create table todo_changes (
    id integer primary key,
    todo_id integer not null references todos(id),
    actor text not null,
    change text not null,
    at text not null
  );
  create index todo_changes_todo on todo_changes(todo_id);
  create table project_changes (
    id integer primary key,
    project_id integer not null references projects(id),
    actor text not null,
    change text not null,
    at text not null
  );
  create index project_changes_project on project_changes(project_id);
  `,
  // v11: the todo a task was delegated from. On the task, since one todo may be delegated again or
  // to a chain of tasks.
  'alter table tasks add column todo_id integer references todos(id);',
  // v12: a todo's dates, kept as local days and times (days.ts), and how it repeats.
  `
  alter table todos add column due text;
  alter table todos add column scheduled text;
  alter table todos add column start text;
  alter table todos add column repeat text;
  alter table todos add column focus text;
  `,
  // v13: a waiting todo's watch, the command that tells when what it waits on has happened, and
  // what it said when last run. A check is not a change to the todo, so it is kept apart from the
  // todo and its history, one row per todo.
  `
  alter table todos add column watch text;
  create table watch_checks (
    todo_id integer primary key references todos(id),
    watch text not null,
    at text not null,
    code integer not null,
    output text not null
  );
  `,
  // v14: the commit a repo task's branch pointed at when gc removed its worktree, so resume can
  // rebuild the worktree after gc deleted the branch.
  'alter table tasks add column head text;',
  // v15: the task a watched todo goes back to once its watch passes, instead of to the person.
  'alter table todos add column back_to integer references tasks(id);',
  // v16: retrospectives in a table of their own, apart from the person's todos, with the rule each
  // proposed and what became of it; the task a retrospective runs in points at it, as a delegated
  // task points at its todo. The retrospectives so far move over, each with its latest rule
  // decision: answering one with anything but yes and then resuming the task makes another. Yes is
  // what answer() takes for it, as typed. tasks.retro_of stays, unused: SQLite cannot drop a column a
  // foreign key is on.
  `
  create table retros (
    id integer primary key,
    of_task_id integer not null unique references tasks(id),
    rule text,
    outcome text,
    created_at text not null,
    ended_at text
  );
  alter table tasks add column retro_id integer references retros(id);
  insert into retros (of_task_id, rule, outcome, created_at, ended_at)
  select t.retro_of, a.summary,
    case
      when lower(trim(d.answer)) in ('y', 'yes') then 'added'
      when d.answer is not null then 'declined'
      when t.status = 'cancelled' then 'dropped'
      when d.id is null and t.status = 'succeeded' then 'none'
    end,
    t.created_at,
    case when d.answer is not null then d.answered_at
      when t.status in ('succeeded', 'cancelled') then t.finished_at end
  from tasks t
  left join decisions d
    on d.id = (select max(id) from decisions where task_id = t.id and reason = 'rule')
  left join attempts a on a.id = d.attempt_id
  where t.id in (select min(id) from tasks where retro_of is not null group by retro_of)
  order by t.id;
  update tasks set retro_id = (select r.id from retros r where r.of_task_id = tasks.retro_of)
  where retro_of is not null;
  `,
  // v17: the rules every worker gets, which <home>/rules.md held until now, with the retrospective
  // each came from and who changed what, as todo_changes has it. The file's lines move over with
  // this migration (importRulesFile).
  `
  create table rules (
    id integer primary key,
    text text not null,
    retro_id integer references retros(id),
    state text not null default 'on',
    created_at text not null,
    changed_at text not null
  );
  create table rule_changes (
    id integer primary key,
    rule_id integer not null references rules(id),
    actor text not null,
    change text not null,
    at text not null
  );
  create index rule_changes_rule on rule_changes(rule_id);
  `,
  // v18: the Claude session that added a task. Tasks before this keep it empty: their history has
  // only the first 8 characters of the id (`claude:<session>`), too few to reopen the session.
  'alter table tasks add column root_session text;',
  // v19: the account (Claude config dir) a worker's Claude Code started with, so nod can tell when
  // the current account is another one.
  'alter table tasks add column account text;',
  // v20: what a person told a worker in the middle of a turn, which goes into that turn and so
  // starts no attempt of its own, kept for the reviewer with what they said in their own turns.
  `
  create table messages (
    id integer primary key,
    task_id integer not null references tasks(id),
    attempt_id integer not null references attempts(id),
    text text not null,
    created_at text not null
  );
  create index messages_task on messages(task_id);
  `,
  // v21: the task whose worker sent a turn's message or one that went into a turn (`NOD: tell`), so
  // a worker's message is told from the person's, and two tasks that keep telling each other stop.
  `
  alter table attempts add column from_task integer references tasks(id);
  alter table messages add column from_task integer references tasks(id);
  `,
  // v22: how far nod may take each repo's tasks once they succeed, who changed that and when, the
  // process landing a repo's tasks now (`lander`), and how far each task's landing has got.
  `
  create table repos (
    path text primary key,
    land text not null default 'off',
    check_cmd text,
    gate_cmd text,
    raised_at text,
    changed_at text not null,
    lander integer
  );
  create table repo_changes (
    id integer primary key,
    repo text not null references repos(path),
    actor text not null,
    change text not null,
    at text not null
  );
  create index repo_changes_repo on repo_changes(repo);
  create table landings (
    task_id integer primary key references tasks(id),
    base text,
    ready text,
    title text,
    body text,
    pushed text,
    pr text,
    handed_at text,
    busy integer,
    stopped text,
    note text,
    merged_at text,
    updated_at text not null
  );
  `,
  // v23: the Claude sessions `nod open` opened for a project, each with the folder it was opened
  // in, where Claude Code keeps its transcript. A project may have several; its latest is the
  // project's session (todos.ts). The projects table stays as it was.
  `
  create table project_sessions (
    id integer primary key,
    session_id text not null unique,
    project_id integer not null references projects(id),
    cwd text not null,
    created_at text not null
  );
  create index project_sessions_project on project_sessions(project_id);
  `,
]
// The migration that moves <home>/rules.md into the ledger, numbered as user_version counts.
const RULES_FILE_MIGRATION = 17

// The tables as the migrations leave them, in camelCase; CamelCasePlugin maps names to snake_case.
// The todo tables (v10) are typed in todos.ts.
type Tables = {
  tasks: Omit<Task, 'id' | 'status'> & { id: Generated<number>; status: Generated<TaskStatus> }
  taskDeps: { taskId: number; afterId: number }
  links: { taskId: number; url: string; createdAt: string }
  triggers: Omit<Trigger, 'id'> & { id: Generated<number>; removedAt: string | null }
  triggerItems: { triggerId: number; key: string; taskId: number | null; seenAt: string }
  attempts: Omit<Attempt, 'id'> & { id: Generated<number>; pid: number | null }
  decisions: Omit<Decision, 'id'> & { id: Generated<number> }
  messages: Omit<Message, 'id'> & { id: Generated<number> }
  retros: Omit<Retro, 'id'> & { id: Generated<number> }
  rules: Omit<Rule, 'id'> & { id: Generated<number> }
  ruleChanges: { id: Generated<number>; ruleId: number; actor: string; change: string; at: string }
  repos: Repo & { lander: number | null }
  repoChanges: { id: Generated<number>; repo: string; actor: string; change: string; at: string }
  landings: Landing
}

// Kysely only builds and type-checks the queries; bun:sqlite runs them (runQuery), so the ledger
// stays synchronous and its transactions stay bun:sqlite ones.
export const queryBuilder = <T>(): Kysely<T> =>
  new Kysely<T>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  })
const q = queryBuilder<Tables>()

// Task, Trigger and Attempt leave out a column their table has.
const TASK = [
  'id',
  'brief',
  'repo',
  'branch',
  'checkCmd',
  'model',
  'triggerId',
  'issue',
  'retroId',
  'todoId',
  'rootSession',
  'workspace',
  'collectedAt',
  'head',
  'account',
  'status',
  'error',
  'createdAt',
  'finishedAt',
] as const
const TRIGGER = [
  'id',
  'cron',
  'brief',
  'repo',
  'branch',
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
  'fromTask',
] as const
const REPO = ['path', 'land', 'checkCmd', 'gateCmd', 'raisedAt', 'changedAt'] as const
const EMPTY_LANDING: Omit<Landing, 'taskId' | 'updatedAt'> = {
  base: null,
  ready: null,
  title: null,
  body: null,
  pushed: null,
  pr: null,
  handedAt: null,
  busy: null,
  stopped: null,
  note: null,
  mergedAt: null,
}
const count = q.fn.countAll<number>().as('n')

export const nodHome = (): string => process.env.NOD_HOME ?? join(homedir(), '.nod')

const now = (): string => new Date().toISOString()

// Every ledger transaction writes, so each begins immediate and waits busy_timeout for the write
// lock. A deferred one that reads first fails at its first write, at once and without the wait,
// when another process holds the lock or committed since that read (WAL). Readers outside a
// transaction never wait on a writer, so only writers queue.
class LedgerDatabase extends Database {
  override transaction<A extends unknown[], T>(fn: (...args: A) => T) {
    const t = super.transaction(fn)
    // bun:sqlite gives each variant the others too, so `.immediate()` and the rest still work.
    return t.immediate as typeof t
  }
}

export class Ledger {
  readonly db: Database

  constructor(home: string = nodHome()) {
    mkdirSync(home, { recursive: true })
    this.db = new LedgerDatabase(join(home, 'nod.db'), { create: true, strict: true })
    // busy_timeout first: switching to WAL takes a lock, and without the timeout a ledger opened
    // by several processes at once fails with `database is locked` (1 in 30 measured).
    this.db.exec('pragma busy_timeout = 5000; pragma journal_mode = wal; pragma foreign_keys = on;')
    const version = (): number =>
      this.db.query<{ user_version: number }, []>('pragma user_version').get()?.user_version ?? 0
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (i < version()) continue
      // Immediate, and the version read again inside: another process opening the ledger may have
      // run this migration while this one waited for the lock.
      this.db
        .transaction(() => {
          if (i < version()) return
          // One statement at a time: exec of several goes on past one that fails, without throwing
          // (bun 1.3.14), which would leave a migration half run. ponytail: split on `;`, as no
          // statement here has one inside it.
          for (const statement of sql.split(';')) {
            if (statement.trim() !== '') this.db.run(statement)
          }
          if (i + 1 === RULES_FILE_MIGRATION) this.importRulesFile(home)
          this.db.exec(`pragma user_version = ${i + 1}`)
        })
        .immediate()
    }
  }

  // ── tasks ──

  // `after`: tasks that must succeed before this one starts. In one repo they must form a chain,
  // because a task's worktree starts from the branch of the task it comes after.
  add(t: NewTask): number {
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
            branch: t.branch,
            checkCmd: t.checkCmd,
            model: t.model,
            triggerId: t.triggerId,
            issue: t.issue,
            rootSession: t.rootSession ?? null,
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
        .select(TASK)
        .where('id', 'in', q.selectFrom('taskDeps').select('afterId').where('taskId', '=', id))
        .orderBy('id'),
    )
  }

  // The queued tasks that come after this one.
  waiting(id: number): number[] {
    return this.run(
      q
        .selectFrom('taskDeps as d')
        .innerJoin('tasks as t', 't.id', 'd.taskId')
        .select('t.id')
        .where('d.afterId', '=', id)
        .where('t.status', '=', 'queued'),
    ).map((t) => t.id)
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
    const task = this.first(q.selectFrom('tasks').select(TASK).where('id', '=', id))
    if (!task) throw new Error(`task ${id} not found`)
    return task
  }

  list(): Task[] {
    return this.run(q.selectFrom('tasks').select(TASK).orderBy('id'))
  }

  setRunning(id: number, workspace: string): void {
    this.run(q.updateTable('tasks').set({ status: 'running', workspace }).where('id', '=', id))
  }

  // Marks running again a task that errored before its worker started, with no workspace, so it
  // can start anew (resume in worker.ts); its failed start keeps the error. One statement, so of two
  // resumes at once only one starts it. Returns whether this one did.
  claimRestart(id: number): boolean {
    const claimed = this.first(
      q
        .updateTable('tasks')
        .set({ status: 'running', error: null, finishedAt: null, collectedAt: null })
        .where('id', '=', id)
        .where('status', '=', 'error')
        .where('workspace', 'is', null)
        .returning('id'),
    )
    return claimed !== null
  }

  succeed(id: number): void {
    this.setStatus(id, 'succeeded', null)
  }

  error(id: number, message: string): void {
    this.setStatus(id, 'error', message)
  }

  // A gc that finds the branch already gone has no head to record and keeps the one recorded.
  collected(id: number, head: string | null): void {
    const set = head === null ? { collectedAt: now() } : { collectedAt: now(), head }
    this.run(q.updateTable('tasks').set(set).where('id', '=', id))
  }

  // collected, but only while the task is as gc read it, in one statement: one told to go on since
  // is not hidden from ls. One collected before keeps when.
  collectedAsRead(task: Task, head: string | null): boolean {
    const at = task.collectedAt ?? now()
    const marked = this.run(
      q
        .updateTable('tasks')
        .set(head === null ? { collectedAt: at } : { collectedAt: at, head })
        .where('id', '=', task.id)
        .where('status', '=', task.status)
        .where('finishedAt', 'is', task.finishedAt)
        .where('collectedAt', 'is', task.collectedAt)
        .returning('id'),
    )
    return marked.length > 0
  }

  // resume brought the task back after gc, so ls lists it again.
  uncollected(id: number): void {
    this.run(q.updateTable('tasks').set({ collectedAt: null }).where('id', '=', id))
  }

  setAccount(id: number, account: string): void {
    this.run(q.updateTable('tasks').set({ account }).where('id', '=', id))
  }

  // Records where the task's result went. The same address twice is kept once.
  link(id: number, urls: string[]): void {
    this.db.transaction(() => {
      this.get(id)
      for (const url of urls) {
        this.run(q.insertInto('links').orIgnore().values({ taskId: id, url, createdAt: now() }))
      }
    })()
  }

  links(id: number): string[] {
    return this.run(
      q.selectFrom('links').select('url').where('taskId', '=', id).orderBy('createdAt'),
    ).map((r) => r.url)
  }

  // ── triggers ──

  // `seen`: keys the source lists already, which never become tasks.
  addTrigger(
    t: Omit<Trigger, 'id' | 'lastRunAt' | 'lastError' | 'createdAt'> & { seen: string[] },
  ): number {
    return this.db.transaction(() => {
      const id = this.insert(
        q
          .insertInto('triggers')
          .values({
            cron: t.cron,
            brief: t.brief,
            repo: t.repo,
            branch: t.branch,
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
      const taskId = this.addTriggerTask(trigger, issue, brief)
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

  // A trigger's task. No human names its branch, so it is the trigger's prefix and the task id.
  addTriggerTask(trigger: Trigger, issue: string | null, brief: string): number {
    return this.db.transaction(() => {
      const id = this.add({
        brief,
        repo: trigger.repo,
        branch: null,
        checkCmd: trigger.checkCmd,
        model: trigger.model,
        after: [],
        triggerId: trigger.id,
        issue,
      })
      if (trigger.branch !== null) {
        this.run(
          q
            .updateTable('tasks')
            .set({ branch: `${trigger.branch}/${id}` })
            .where('id', '=', id),
        )
      }
      return id
    })()
  }

  // A retrospective of `of`, and the task it runs in: an empty folder with the same model. Returns
  // the task. It keeps the issue and root session of `of`, so whoever watches that task's
  // decisions gets its rule decision too.
  addRetro(of: Task, brief: string): number {
    return this.db.transaction(() => {
      const retroId = this.insert(
        q.insertInto('retros').values({ ofTaskId: of.id, createdAt: now() }).returning('id'),
      )
      const id = this.add({
        brief,
        repo: null,
        branch: null,
        checkCmd: null,
        model: of.model,
        after: [],
        triggerId: null,
        issue: of.issue,
        rootSession: of.rootSession,
      })
      this.run(q.updateTable('tasks').set({ retroId }).where('id', '=', id))
      return id
    })()
  }

  retro(id: number): Retro {
    const retro = this.first(q.selectFrom('retros').selectAll().where('id', '=', id))
    if (!retro) throw new Error(`retrospective r${id} not found`)
    return retro
  }

  // The rule a retrospective reports, before the person decides on it.
  proposeRule(id: number, rule: string): void {
    this.run(q.updateTable('retros').set({ rule }).where('id', '=', id))
  }

  endRetro(id: number, outcome: RetroOutcome): void {
    this.run(q.updateTable('retros').set({ outcome, endedAt: now() }).where('id', '=', id))
  }

  // A task that does one of the person's todos (todos.ts delegate).
  addTodoTask(t: NewTask, todoId: number): number {
    return this.db.transaction(() => {
      const id = this.add(t)
      this.run(q.updateTable('tasks').set({ todoId }).where('id', '=', id))
      return id
    })()
  }

  // Records that an existing task does a todo, as `addTodoTask` does for a new one. For todos
  // brought from another system that had delegated them to nod.
  linkTodoTask(taskId: number, todoId: number): void {
    const linked = this.first(
      q
        .updateTable('tasks')
        .set({ todoId })
        .where('id', '=', taskId)
        .where('todoId', 'is', null)
        .returning('id'),
    )
    if (!linked) throw new Error(`task ${taskId} does not exist or already does a todo`)
  }

  // The tasks doing a todo, oldest first.
  tasksOf(todoId: number): Task[] {
    return this.run(q.selectFrom('tasks').select(TASK).where('todoId', '=', todoId).orderBy('id'))
  }

  // The task, the retrospective with the task it runs in, and the decision numbered n; null where
  // there is none (`nod search`).
  numbered(n: number): {
    task: Task | null
    retro: { retro: Retro; task: Task } | null
    decision: Decision | null
  } {
    const retro = this.first(q.selectFrom('retros').selectAll().where('id', '=', n))
    const retroTask = this.first(q.selectFrom('tasks').select(TASK).where('retroId', '=', n))
    return {
      task: this.first(q.selectFrom('tasks').select(TASK).where('id', '=', n)),
      retro: retro === null || retroTask === null ? null : { retro, task: retroTask },
      decision: this.first(q.selectFrom('decisions').selectAll().where('id', '=', n)),
    }
  }

  // The retrospective of a task, if one was started.
  retroFor(taskId: number): Retro | null {
    return this.first(q.selectFrom('retros').selectAll().where('ofTaskId', '=', taskId))
  }

  // ── rules ──

  // `retroId`: the retrospective that proposed it; null for one the person wrote.
  addRule(text: string, retroId: number | null, actor: string): Rule {
    ruleText(text)
    return this.db.transaction(() => {
      const at = now()
      const id = this.insert(
        q
          .insertInto('rules')
          .values({ text, retroId, state: 'on', createdAt: at, changedAt: at })
          .returning('id'),
      )
      const from: Changed = retroId === null ? {} : { retroId: [null, retroId] }
      this.recordRule(id, actor, { text: [null, text], ...from, state: [null, 'on'] }, at)
      return this.rule(id)
    })()
  }

  rule(id: number): Rule {
    const rule = this.first(q.selectFrom('rules').selectAll().where('id', '=', id))
    if (!rule) throw new Error(`rule ${id} not found`)
    return rule
  }

  rules(): Rule[] {
    return this.run(q.selectFrom('rules').selectAll().orderBy('id'))
  }

  rulesNow(): RuleNow[] {
    return this.rules().map((r) => ({
      ...r,
      edited: r.retroId !== null && r.text !== this.retro(r.retroId).rule,
    }))
  }

  // Changes what the edit names and records who changed what; a field set to the value it has is
  // not a change.
  setRule(id: number, edit: RuleEdit, actor: string): Rule {
    if (edit.text !== undefined) ruleText(edit.text)
    return this.db.transaction(() => {
      const before = this.rule(id)
      const change = Object.fromEntries(
        (['text', 'state'] as const)
          .filter((k) => edit[k] !== undefined && edit[k] !== before[k])
          .map((k): [string, Changed[string]] => [k, [before[k], edit[k]]]),
      )
      if (Object.keys(change).length === 0) return before
      const at = now()
      this.run(
        q
          .updateTable('rules')
          .set({ ...edit, changedAt: at })
          .where('id', '=', id),
      )
      this.recordRule(id, actor, change, at)
      return this.rule(id)
    })()
  }

  private recordRule(id: number, actor: string, change: Changed, at: string): void {
    const row = { ruleId: id, actor, change: JSON.stringify(change), at }
    this.run(q.insertInto('ruleChanges').values(row))
  }

  // ── repos ──

  // Null for a repo nobody set, which nod does not land.
  repo(path: string): Repo | null {
    return this.first(q.selectFrom('repos').select(REPO).where('path', '=', path))
  }

  repos(): Repo[] {
    return this.run(q.selectFrom('repos').select(REPO).orderBy('path'))
  }

  // Changes what the edit names and records who changed what, as setRule does. Going up from off
  // marks when, so only the tasks added from then on land without being named.
  setRepo(path: string, edit: RepoEdit, actor: string): Repo {
    return this.db.transaction(() => {
      const at = now()
      const before = this.repo(path)
      if (before === null) {
        this.run(q.insertInto('repos').values({ path, land: 'off', changedAt: at }))
      }
      const was: Repo = before ?? {
        path,
        land: 'off',
        checkCmd: null,
        gateCmd: null,
        raisedAt: null,
        changedAt: at,
      }
      const change = Object.fromEntries(
        (['land', 'checkCmd', 'gateCmd'] as const)
          .filter((k) => edit[k] !== undefined && edit[k] !== was[k])
          .map((k): [string, Changed[string]] => [k, [was[k], edit[k]]]),
      )
      if (Object.keys(change).length === 0) return was
      const raised = was.land === 'off' && edit.land !== undefined && edit.land !== 'off'
      this.run(
        q
          .updateTable('repos')
          .set({ ...edit, changedAt: at, ...(raised ? { raisedAt: at } : {}) })
          .where('path', '=', path),
      )
      const row = { repo: path, actor, change: JSON.stringify(change), at }
      this.run(q.insertInto('repoChanges').values(row))
      return this.repo(path) ?? was
    })()
  }

  repoChanges(path: string): RepoChange[] {
    return this.run(
      q
        .selectFrom('repoChanges')
        .select(['actor', 'change', 'at'])
        .where('repo', '=', path)
        .orderBy('id'),
    ).map((c) => ({ ...c, change: JSON.parse(c.change) as Changed }))
  }

  // Takes the repo for the process `pid` to land its tasks, unless a live one has it: two ticks at
  // once would rebase and push the same branches. One that died (a killed tick) leaves it to take.
  // ponytail: a pid the OS gave out again reads as alive until that process ends.
  claimRepo(path: string, pid: number, alive: (pid: number) => boolean): boolean {
    return this.db.transaction(() => {
      const row = this.first(q.selectFrom('repos').select('lander').where('path', '=', path))
      if (row === null) return false
      if (row.lander !== null && row.lander !== pid && alive(row.lander)) return false
      this.run(q.updateTable('repos').set({ lander: pid }).where('path', '=', path))
      return true
    })()
  }

  releaseRepo(path: string, pid: number): void {
    this.run(
      q
        .updateTable('repos')
        .set({ lander: null })
        .where('path', '=', path)
        .where('lander', '=', pid),
    )
  }

  // ── landings ──

  landing(taskId: number): Landing | null {
    return this.first(q.selectFrom('landings').selectAll().where('taskId', '=', taskId))
  }

  setLanding(taskId: number, edit: LandingEdit): Landing {
    const updatedAt = now()
    this.run(
      q
        .insertInto('landings')
        .values({ ...EMPTY_LANDING, ...edit, taskId, updatedAt })
        .onConflict((oc) => oc.column('taskId').doUpdateSet({ ...edit, updatedAt })),
    )
    const landing = this.landing(taskId)
    if (landing === null) throw new Error(`task ${taskId} has no landing`)
    return landing
  }

  // Moves each line of <home>/rules.md, where approved rules were kept before v17, into the rules
  // table without its leading `- `, tied to the added retrospective that proposed the same words.
  // The file is renamed, not deleted, so it plainly no longer counts. Run inside the migration's
  // transaction, so a failed rename leaves the ledger as it was.
  private importRulesFile(home: string): void {
    const path = join(home, 'rules.md')
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const text = line.replace(/^- /, '').trim()
      if (text === '') continue
      const retro = this.first(
        q
          .selectFrom('retros')
          .select('id')
          .where('outcome', '=', 'added')
          .where('rule', '=', text)
          .orderBy('id'),
      )
      // Recorded as nod's: who wrote the line the file does not say, and nod moved it.
      this.addRule(text, retro?.id ?? null, 'nod')
    }
    renameSync(path, `${path}.imported`)
  }

  // ── attempts ──

  startAttempt(a: {
    taskId: number
    kind: AttemptKind
    decisionId: number | null
    sessionId: string
    prompt: string
    fromTask?: number | null
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

  // Fails an attempt only while it is open, in one statement, so of two processes that find it open
  // at once one gets it. Returns whether this one did.
  failOpenAttempt(id: number, error: string): boolean {
    const failed = this.first(
      q
        .updateTable('attempts')
        .set({ outcome: 'error', error, finishedAt: now() })
        .where('id', '=', id)
        .where('finishedAt', 'is', null)
        .returning('id'),
    )
    return failed !== null
  }

  // Ends a turn that waited on background work as `outcome`, only while it still waits and no turn
  // has started since, in one statement: of two ticks at once one gets it, and a turn that came
  // (the work finished) keeps the task going. `past`: later attempts that count as no turn (a
  // person's that ended without a Stop, in worker.ts). Returns whether this one did.
  endWait(id: number, outcome: Outcome, past: number[] = []): boolean {
    const ended = this.first(
      q
        .updateTable('attempts')
        .set({ outcome })
        .where('id', '=', id)
        .where('outcome', '=', 'waiting')
        .where(({ exists, not, selectFrom }) =>
          not(
            exists(
              selectFrom('attempts as later')
                .select('later.id')
                .whereRef('later.taskId', '=', 'attempts.taskId')
                .whereRef('later.id', '>', 'attempts.id')
                .where('later.id', 'not in', [...past, -1]),
            ),
          ),
        )
        .returning('id'),
    )
    return ended !== null
  }

  addMessage(
    taskId: number,
    attemptId: number,
    text: string,
    fromTask: number | null = null,
  ): void {
    this.run(
      q.insertInto('messages').values({ taskId, attemptId, text, createdAt: now(), fromTask }),
    )
  }

  // How many messages the workers of tasks `a` and `b` sent each other (`NOD: tell`), both ways:
  // the turns they started and those that went into a turn.
  tellsBetween(a: number, b: number): number {
    const pair = [a, b]
    const turns = this.first(
      q
        .selectFrom('attempts')
        .select(count)
        .where('taskId', 'in', pair)
        .where('fromTask', 'in', pair)
        .whereRef('taskId', '!=', 'fromTask'),
    )
    const within = this.first(
      q
        .selectFrom('messages')
        .select(count)
        .where('taskId', 'in', pair)
        .where('fromTask', 'in', pair)
        .whereRef('taskId', '!=', 'fromTask'),
    )
    return (turns?.n ?? 0) + (within?.n ?? 0)
  }

  messages(taskId: number): Message[] {
    return this.run(q.selectFrom('messages').selectAll().where('taskId', '=', taskId).orderBy('id'))
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
    this.close(decisionId, answer, 'running', now())
  }

  // The human ends the task instead of answering, so nothing counts it a success.
  drop(decisionId: number): void {
    this.close(decisionId, '(dropped)', 'cancelled', now())
  }

  // The person answers or drops a decision on landing the task (land.ts), which leaves it `status`:
  // succeeded, since its work stands either way.
  closeAnswered(decisionId: number, answer: string, status: TaskStatus): void {
    this.close(decisionId, answer, status, now())
  }

  // Closes a decision no turn waits on: one nod closes as its worker goes on without it, or one a
  // person answers or drops on a task that ended. No answer reaches a turn, so it has no answeredAt
  // and the wait for answers (stats) leaves it out; the task stays as it is.
  dismiss(decisionId: number, answer: string): void {
    this.close(decisionId, answer, null, null)
  }

  private close(
    decisionId: number,
    answer: string,
    next: TaskStatus | null,
    answeredAt: string | null,
  ): void {
    this.db.transaction(() => {
      const decision = this.decision(decisionId)
      if (decision.answer !== null) throw new Error(`decision ${decisionId} is already answered`)
      this.run(q.updateTable('decisions').set({ answer, answeredAt }).where('id', '=', decisionId))
      if (next !== null) this.setStatus(decision.taskId, next, null)
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
    const finishedAt = FINISHED.has(status) ? now() : null
    this.run(q.updateTable('tasks').set({ status, error, finishedAt }).where('id', '=', id))
    // A task that waits for a cancelled one can never start. An error is left alone: the task can
    // still be resumed and succeed.
    if (status !== 'cancelled') return
    for (const w of this.waiting(id)) {
      this.setStatus(w, 'cancelled', `task #${id} it waits for was cancelled`)
    }
  }

  private insert(query: Compilable<{ id: number }>): number {
    const row = this.first(query)
    if (!row) throw new Error('insert returned no id')
    return row.id
  }

  private run<O>(query: Compilable<O>): O[] {
    return runQuery(this.db, query)
  }

  private first<O>(query: Compilable<O>): O | null {
    return this.run(query)[0] ?? null
  }
}

// Runs a query and returns its rows, whether or not it reads any. Shared with the todo tables
// (todos.ts), which keep their own query builder.
export function runQuery<O>(db: Database, query: Compilable<O>): O[] {
  const { sql, parameters } = query.compile()
  const rows = db
    .query<Record<string, unknown>, SQLQueryBindings[]>(sql)
    // Kysely compiles only the values the query was typed with: strings, numbers and nulls.
    .all(...(parameters as SQLQueryBindings[]))
  // CamelCasePlugin renames result columns only when Kysely runs the query, so do it here.
  return rows.map(camelKeys) as O[]
}

const camelKeys = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  )

// A rule goes into every worker's prompt as one line of a list.
function ruleText(text: string): void {
  if (text.trim() === '') throw new Error('empty rule')
  if (text.includes('\n')) throw new Error('a rule is one line')
}

function median(sorted: number[]): number | null {
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid]
  if (hi === undefined) return null
  const lo = sorted.length % 2 === 0 ? sorted[mid - 1] : hi
  return Math.round(((lo ?? hi) + hi) / 2)
}
