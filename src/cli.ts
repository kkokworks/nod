#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { accountRule, configDir, describeRule, setAccountRule } from './account'
import { sweep } from './done'
import { collect, type GcPick, type GcReport, remotesHolding } from './gc'
import { land } from './land'
import {
  type Attempt,
  type Decision,
  LAND_LEVELS,
  type LandLevel,
  Ledger,
  nodHome,
  type Repo,
  type RepoEdit,
  type Rule,
  type Task,
  type Trigger,
} from './ledger'
import { pullRequests } from './prs'
import { Terminals } from './tmux'
import {
  actorFromEnv,
  capture,
  projectCommand,
  sessionFromEnv,
  TODO_USAGE,
  todayCommand,
  todoCommand,
} from './todo-cli'
import { type Found, parseRef, Todos } from './todos'
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
  keepWorker,
  message,
  NotificationEvent,
  onNotification,
  onStop,
  onStopFailure,
  type Restart,
  restart,
  restartDue,
  resume,
  StopEvent,
  StopFailureEvent,
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
                                   in --project when given. Run in a Claude session, the task
                                   records that session as its root, for --mine
  nod tell <task> <message...>     send a follow-up into the task's session
  nod resume <task>                reopen a task whose session ended, from its transcript
  nod attach <task>                open the worker's terminal (tmux)
  nod peek <task>                  print what the worker's terminal shows right now
  nod watch [--issue <key,...>] [--mine]
                                   print decisions as they open, until no worker is running;
                                   --issue: only decisions and workers of tasks on these issues;
                                   --mine: only those of tasks this Claude session added, so
                                   several root sessions can each watch their own
  nod link <task> <url...>         record where the task's result went (a pull request, a posted
                                   review), so ls and show list it next to the task. Until then
                                   they list the remote branches that hold the task's branch
  nod ls [--all] [--mine]          tasks not yet collected by gc (--all: every task; --mine: only
                                   those this Claude session added); those with an issue are
                                   listed under it
  nod show <task>                  history, links, then the worker's last full report. root: is
                                   the Claude session that added it (claude --resume <session>)
  nod search <ref>                 what t<n>, #<n>, r<n> or p<n> names, or <n>: all of those and
                                   decision <n>. One match shows as its own command shows it
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
  nod rule ls                      the rules every worker gets after the built-in ones: each one's
                                   number, on or off, the retrospective r<n> it came from, and
                                   the rule. Answering yes to a rule decision adds one
  nod rule add <rule...>           add a rule of your own
  nod rule edit <rule> <rule...>   reword a rule
  nod rule off|on <rule>           stop or start giving a rule to workers. Nothing deletes a rule,
                                   so where one came from stays known. Each change records who
                                   made it, as a todo's do; a worker cannot make one
  nod repo [<path> [off | pr | merge] [--check <command>] [--gate <command>]]
                                   how far nod takes a repo's tasks once they succeed: off (the
                                   default: the person pushes), pr (rebase onto the default
                                   branch, check, push and open a pull request) or merge (and
                                   squash merge it). Only tasks added after it goes up from off
                                   land on their own; nod land names older ones. --check: the full
                                   check after each rebase (else the task's own); --gate: a command
                                   run before each push, with NOD_BASE..NOD_HEAD the commits and
                                   NOD_PR a file with the pull request's title and body, that must
                                   exit 0. With a path only, the setting and who changed it when;
                                   with none, every repo set. A worker cannot change it, and a
                                   Claude session can only turn a repo off
  nod land [<task...>]             land now what the repos let nod land (the schedule does it every
                                   fifth minute), or only these tasks, ones added before their repo
                                   went up and ones whose landing stopped too. What needs judgment
                                   (a conflict, a check that fails once rebased, the pull request's
                                   text) goes to the task's worker, and what only you can clear
                                   becomes a decision
  nod schedule [on | off]          whether the OS scheduler runs the tick every minute; on, it
                                   runs with this shell's PATH and Claude config dir, which the
                                   triggers' workers and the watches use. It stays on until off
  nod tick                         run the triggers that are due and the watches, land what the
                                   repos let nod land, and gc the finished tasks a signal says
                                   are done with (as nod gc does); the scheduled tick does the
                                   watches, landing and gc every fifth minute.
                                   It also asks about turns whose terminal is gone (a restart of
                                   the machine or tmux) and about tasks that have waited an hour
                                   on background work, and restarts the workers due a restart
  nod restart [<task...>]          start the Claude Code of these workers, or of every worker,
                                   again in the same terminal and conversation: at once between
                                   turns, after its turn otherwise, and only once nobody is
                                   attached. For a tool that switches accounts to run after a switch
  nod account [env | file <path> | command <command>]
                                   which Claude account (config dir) workers run as: the
                                   CLAUDE_CONFIG_DIR of the shell that starts one (env, the
                                   default), the path a file holds, or what a command prints
                                   (one quoted argument, run with sh -c);
                                   empty means Claude Code's default. With a file or a command,
                                   every nod command and tick restarts the workers that run as
                                   another account than the current one, as nod restart does
  nod hook stop|notification       called by Claude Code hooks in worker sessions
  nod run <task> <claude...>       what runs in a worker's terminal: keeps its Claude Code running

A <task> is a task's number, t<n> for the latest task doing todo t<n>, or r<n> for the task
retrospective r<n> runs in.
${TODO_USAGE}

When <home>/notify exists, nod runs it with a JSON event on stdin whenever a decision opens, a
task succeeds or fails to start, a trigger fails, a watch passes or can no longer run, or a
restart waits for a person attached to the worker. <home> is $NOD_HOME, or ~/.nod.`

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
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { issue: { type: 'string' } },
    })
    const keys = issueKeys(values.issue)
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
  case 'watch': {
    const { values } = parseArgs({
      args: rest,
      options: { issue: { type: 'string' }, mine: { type: 'boolean' } },
    })
    const keys = issueKeys(values.issue)
    const session = mySession(values.mine)
    await watch((t) => onIssues(keys, t) && isMine(session, t))
    break
  }
  case 'link': {
    const id = taskRef(rest[0])
    const urls = rest.slice(1)
    if (!Number.isInteger(id) || urls.length === 0) throw new Error(USAGE)
    ledger.link(id, urls)
    console.log(`linked #${id}: ${ledger.links(id).join(' ')}`)
    break
  }
  case 'ls': {
    const { values } = parseArgs({
      args: rest,
      options: { all: { type: 'boolean' }, mine: { type: 'boolean' } },
    })
    const session = mySession(values.mine)
    printTasks(
      ledger.list().filter((t) => (values.all || t.collectedAt === null) && isMine(session, t)),
    )
    break
  }
  case 'show':
    show(taskRef(rest[0]))
    break
  case 'search':
    await search(rest)
    break
  case 'drop': {
    const said = {
      dropped: 'dropped',
      closed: 'closed; its task had ended',
      'landing stopped': 'stopped landing it; the task stays succeeded',
    }
    console.log(said[await drop(ledger, home, Number(rest[0]))])
    break
  }
  case 'gc':
    await gc(rest)
    break
  case 'stats':
    console.log(JSON.stringify(ledger.stats(), null, 2))
    break
  case 'trigger':
    await trigger(rest)
    break
  case 'rule':
    rule(rest)
    break
  case 'repo':
    repoCommand(rest)
    break
  case 'land':
    await landCommand(rest.map(taskRef))
    break
  case 'schedule':
    await schedule(rest)
    break
  case 'tick': {
    // Run by hand, it checks the watches now too, not only on their every fifth minute.
    const { added, passed, collected, lost, waited, restarted, landed } = await tick(
      ledger,
      home,
      new Date(),
      true,
    )
    if (added.length > 0) console.log(`added task(s) ${added.join(', ')}`)
    if (passed.length > 0) console.log(`watch passed: ${passed.map((id) => `t${id}`).join(', ')}`)
    if (collected.length > 0) console.log(`collected task(s) ${collected.join(', ')}`)
    if (lost.length > 0) console.log(`turn(s) lost with their terminal: ${lost.join(', ')}`)
    if (waited.length > 0) console.log(`waited too long on background work: ${waited.join(', ')}`)
    if (restarted.length > 0) console.log(`restarted task(s) ${restarted.join(', ')}`)
    for (const m of landed) console.log(`landing #${m.id}: ${m.did}`)
    if ([added, passed, collected, lost, waited, restarted, landed].every((x) => x.length === 0))
      console.log('nothing due')
    break
  }
  case 'restart':
    await restartCommand(rest)
    break
  case 'account':
    accountCommand(rest)
    break
  case 'hook':
    await hook(rest[0])
    break
  case 'run':
    await keepWorker(ledger, home, taskRef(rest[0]), rest.slice(1))
    process.exit(0)
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
    // Yes to a rule decision adds a rule, which `nod rule` refuses a worker.
    if (process.env.NOD_TASK !== undefined && ledger.decision(id).reason === 'rule') {
      throw new Error('a worker cannot change the rules')
    }
    const { taskId, reason } = ledger.decision(id)
    const said = words(rest)
    const took = await answer(ledger, home, id, said, actorFromEnv())
    if (reason === 'land') {
      console.log(/^y(es)?$/i.test(said) ? 'landing it again' : 'stopped landing it')
      // Yes tries again now, not at the next fifth minute.
      if (/^y(es)?$/i.test(said)) await landCommand([taskId])
    } else {
      console.log(took ? `answered; sent to task #${taskId}` : `closed; task #${taskId} had ended`)
    }
  }
}

// Every nod command checks the workers' account; after the command, so a message it sends goes
// first (deliver starts that worker again with it). The hooks check their own worker.
if (command !== 'hook' && command !== 'restart') {
  await restartDue(ledger, home).catch((error) =>
    console.error(`nod: could not restart workers: ${message(error)}`),
  )
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
    rootSession: sessionFromEnv(),
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

function rule([sub, ...args]: string[]): void {
  if (sub === 'ls' && args.length === 0) {
    for (const r of ledger.rules()) printRule(r)
    return
  }
  // A rule reaches every later worker. The sandbox already keeps a worker out of the ledger; this
  // refuses plainly should a write path ever open.
  if (process.env.NOD_TASK !== undefined) throw new Error('a worker cannot change the rules')
  const actor = actorFromEnv()
  if (sub === 'add') {
    printRule(ledger.addRule(words(args), null, actor))
  } else if (sub === 'edit') {
    printRule(ledger.setRule(ruleId(args[0]), { text: words(args.slice(1)) }, actor))
  } else if ((sub === 'on' || sub === 'off') && args.length === 1) {
    printRule(ledger.setRule(ruleId(args[0]), { state: sub }, actor))
  } else {
    throw new Error(USAGE)
  }
}

function ruleId(ref: string | undefined): number {
  const id = Number(ref)
  if (!Number.isInteger(id)) throw new Error(`not a rule number: ${ref}`)
  return id
}

function printRule(r: Rule): void {
  const from = r.retroId === null ? '' : `r${r.retroId}`
  console.log(`${String(r.id).padEnd(4)} ${r.state.padEnd(3)} ${from.padEnd(5)} ${r.text}`)
}

// What nod may do in a repo reaches outside this machine, so a worker cannot change it, and a Claude
// session, which could otherwise grant itself a merge, can only turn it off. The person runs it in
// a shell of their own.
// ponytail: both are told apart by their environment, which keeps out mistakes rather than an
// agent set on it; the sandbox is what keeps a worker off the ledger.
function repoCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { check: { type: 'string' }, gate: { type: 'string' } },
    allowPositionals: true,
  })
  const [path, level, ...extra] = positionals
  if (path === undefined) {
    if (level !== undefined || values.check !== undefined || values.gate !== undefined) {
      throw new Error(USAGE)
    }
    for (const r of ledger.repos()) printRepo(r)
    return
  }
  if (extra.length > 0) throw new Error(USAGE)
  const repo = repoPath(path) ?? path
  const edit: RepoEdit = {}
  if (level !== undefined) {
    if (!LAND_LEVELS.includes(level as LandLevel)) throw new Error(`not off, pr or merge: ${level}`)
    edit.land = level as LandLevel
  }
  // An empty command clears it.
  if (values.check !== undefined) edit.checkCmd = values.check.trim() || null
  if (values.gate !== undefined) edit.gateCmd = values.gate.trim() || null
  if (Object.keys(edit).length === 0) {
    const r = ledger.repo(repo)
    if (r === null) console.log(`${repo}  off (never set)`)
    else printRepo(r)
    for (const c of ledger.repoChanges(repo)) {
      const what = Object.entries(c.change)
        .map(([k, [from, to]]) => `${k} ${String(from ?? '—')} → ${String(to ?? '—')}`)
        .join(', ')
      console.log(`  ${c.at} ${c.actor}: ${what}`)
    }
    return
  }
  if (process.env.NOD_TASK !== undefined) {
    throw new Error('a worker cannot change what nod may do in a repo')
  }
  if (process.env.CLAUDECODE && !(edit.land === 'off' && Object.keys(edit).length === 1)) {
    throw new Error('a Claude session can only turn a repo off; change it from a shell of your own')
  }
  const r = ledger.setRepo(repo, edit, actorFromEnv())
  printRepo(r)
  if (r.land !== 'off' && scheduleEnv(home) === null) {
    console.log('the schedule is off, so tasks land only when you run nod land (nod schedule on)')
  }
}

// Lands now what the schedule would on its next fifth minute, or the tasks named, ones added
// before their repo went up from off too, and one whose landing stopped again.
async function landCommand(ids: number[]): Promise<void> {
  for (const id of ids) {
    const { repo } = ledger.get(id)
    if (repo === null || (ledger.repo(repo)?.land ?? 'off') === 'off') {
      throw new Error(
        `task #${id}'s repo does not let nod land it: nod repo ${repo ?? '<path>'} pr`,
      )
    }
    if (ledger.landing(id)?.stopped) ledger.setLanding(id, { stopped: null, note: null })
  }
  const moved = await land(ledger, home, ids.length > 0 ? { only: ids } : {})
  for (const m of moved) console.log(`#${m.id} ${m.did}`)
  if (moved.length === 0) console.log('nothing to land')
}

function printRepo(r: Repo): void {
  console.log(`${r.path}  ${r.land}`)
  if (r.checkCmd !== null) console.log(`  check: ${r.checkCmd}`)
  if (r.gateCmd !== null) console.log(`  gate: ${r.gateCmd}`)
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

async function restartCommand(refs: string[]): Promise<void> {
  const said: Record<Restart, string> = {
    restarted: 'restarted',
    'after its turn': 'restarts once its turn ends',
    attached: 'has a person attached; it restarts once they detach',
    'no terminal':
      'has no terminal that keeps its Claude Code running; once its terminal is gone, nod tell opens one that does',
  }
  const live = terminals.sessions()
  const ids =
    refs.length > 0
      ? refs.map(taskRef)
      : ledger
          .list()
          .filter((t) => t.account !== null && live.has(sessionName(t.id)))
          .map((t) => t.id)
  if (ids.length === 0) console.log('no worker to restart')
  for (const id of ids) {
    console.log(`#${id} ${said[await restart(ledger, home, id, 'nod restart')]}`)
  }
}

function accountCommand([how, ...args]: string[]): void {
  const [path] = args
  if (how === 'env' && args.length === 0) setAccountRule(home, null)
  else if (how === 'file' && path !== undefined && args.length === 1) {
    setAccountRule(home, { file: resolve(path) })
  } else if (how === 'command' && args.length === 1) {
    // One shell command, as a source or a watch is: words joined back would lose their quotes.
    setAccountRule(home, { command: words(args) })
  } else if (how !== undefined) throw new Error(USAGE)
  console.log(describeRule(accountRule(home)))
  console.log(`  now ${configDir(home) ?? "(none: Claude Code's default)"}`)
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
  } else if (event === 'stop-failure') {
    await onStopFailure(ledger, home, StopFailureEvent.parse(input))
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
function issueKeys(issue: string | undefined): Set<string> | null {
  if (issue === undefined) return null
  const keys = issue
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
  if (keys.length === 0) throw new Error('--issue needs at least one key')
  return new Set(keys)
}

function onIssues(keys: Set<string> | null, task: Task): boolean {
  return keys === null || (task.issue !== null && keys.has(task.issue))
}

// `--mine`: the session whose tasks count. Outside a Claude session there is none, and it stops
// there rather than show every task as if they were this session's. null without --mine.
function mySession(mine: boolean | undefined): string | null {
  if (!mine) return null
  const session = sessionFromEnv()
  if (session === null) {
    throw new Error('--mine picks the tasks a Claude session added; run it in that session')
  }
  return session
}

function isMine(session: string | null, task: Task): boolean {
  return session === null || task.rootSession === session
}

// `counts`: the tasks whose decisions it prints and whose workers keep it going.
async function watch(counts: (t: Task) => boolean): Promise<void> {
  const seen = new Set(ledger.openDecisions().map((d) => d.id))
  let idleSecs = 0
  while (idleSecs < WATCH_GRACE_SECS) {
    await Bun.sleep(1000)
    for (const d of ledger.openDecisions()) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      if (counts(ledger.get(d.taskId))) printDecision(d)
    }
    const running = ledger.list().some((t) => t.status === 'running' && counts(t))
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
  if (task.rootSession !== null) console.log(`  root: ${task.rootSession}`)
  console.log(`  brief: ${task.brief}`)
  if (task.repo) console.log(`  repo: ${task.repo} (branch ${branchOf(task)})`)
  if (task.workspace) console.log(`  workspace: ${task.workspace}`)
  if (task.account !== null) console.log(`  account: ${task.account || "Claude Code's default"}`)
  if (task.checkCmd) console.log(`  check: ${task.checkCmd}`)
  if (task.triggerId !== null) console.log(`  added by trigger #${task.triggerId}`)
  if (task.retroId !== null) {
    const r = ledger.retro(task.retroId)
    console.log(`  retrospective: r${r.id} of #${r.ofTaskId}${r.outcome ? `, ${r.outcome}` : ''}`)
    // The rule it added, as it stands now.
    for (const added of ledger.rulesNow().filter((x) => x.retroId === r.id)) {
      const edited = added.edited ? ', edited' : ''
      console.log(`  rule ${added.id} ${added.state}${edited}: ${added.text}`)
    }
  }
  if (task.todoId !== null) console.log(`  todo: t${task.todoId}`)
  for (const url of ledger.links(id)) console.log(`  link: ${url}`)
  for (const ref of unlinkedPushes(task)) console.log(`  pushed: ${ref}`)
  const landing = ledger.landing(id)
  if (landing !== null) {
    const short = (sha: string | null): string => sha?.slice(0, 12) ?? '—'
    const at = landing.mergedAt
      ? `merged ${landing.mergedAt}`
      : landing.stopped
        ? `stopped: ${landing.stopped}`
        : (landing.note ?? 'going on')
    console.log(`  landing: ${at} (on ${short(landing.base)}, pushed ${short(landing.pushed)})`)
  }
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
      : d.answer === null
        ? 'open'
        : `closed: ${d.answer}`
    console.log(`  decision #${d.id} ${d.reason} — ${answered}`)
  }
  const report = ledger.attempts(id).findLast((a) => a.report)?.report
  if (report) console.log(`\n${report}`)
}

// One match prints as the command that shows it does; several, a line each with that command.
async function search(args: string[]): Promise<void> {
  const [ref, ...extra] = args
  if (ref === undefined || extra.length > 0) throw new Error(USAGE)
  const todos = new Todos(ledger)
  const found = todos.find(ref)
  const [one, ...more] = found
  if (one === undefined) {
    console.error(`no match for ${ref}`)
    process.exit(1)
  }
  if (more.length > 0) {
    for (const f of found) {
      console.log(
        `${f.ref.padEnd(5)} ${f.kind.padEnd(8)} ${f.status.padEnd(14)} ${oneLine(f.title, 60)}  · ${opens(f)}`,
      )
    }
  } else if (one.kind === 'todo') {
    await todoCommand(todos, home, [one.ref])
  } else if (one.kind === 'project') {
    projectCommand(todos, [one.ref])
  } else if (one.kind === 'decision') {
    const d = ledger.decision(one.id)
    if (d.answer === null) printDecisions([d])
    else {
      printDecision(d)
      console.log(`${one.status}: ${d.answer}`)
    }
  } else {
    show(one.taskId)
  }
}

// A decision has no view of its own; its task's shows it.
function opens(f: Found): string {
  if (f.kind === 'todo') return `nod todo ${f.ref}`
  if (f.kind === 'project') return `nod project ${f.ref}`
  return `nod show ${f.kind === 'retro' ? f.ref : f.taskId}`
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
// fetch; nod fetches only as it lands a repo's tasks (land.ts).
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
  const from = a.fromTask === null ? '' : ` from #${a.fromTask}`
  console.log(
    `  ${a.kind.padEnd(8)} ${(a.outcome ?? '-').padEnd(14)} ${secs}${check}${from}  session ${a.sessionId}`,
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
