#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { accountRule, configDir, describeRule, openedIn, setAccountRule } from './account'
import { ALLOW, onPermissionRequest, PermissionEvent } from './allow'
import { createdFrom } from './branch'
import { finished, NO_PERSON } from './decisions'
import { followWork, sweep } from './done'
import { AUTOCOMPACT_PCT } from './env'
import { collect, type GcPick, type GcReport, remotesHolding } from './gc'
import {
  NotificationEvent,
  onCompact,
  onNotification,
  onPermissionAsk,
  onPrompt,
  onStop,
  onStopFailure,
  onToolRan,
  PromptEvent,
  SessionStartEvent,
  StopFailureEvent,
  ToolEvent,
} from './hooks'
import {
  InboxEvent,
  onCommand,
  onInbox,
  sendLine,
  sendNotices,
  tellProject,
  tellSessions,
  unheardWork,
} from './inbox'
import { dueTasks, land } from './land'
import {
  type Attempt,
  type Decision,
  FINISHED,
  LAND_LEVELS,
  type LandLevel,
  Ledger,
  nodHome,
  type Repo,
  type RepoEdit,
  type Rule,
  type Task,
} from './ledger'
import { branchOf, sessionName } from './place'
import { message, readAtOnce, spawn } from './proc'
import { pullRequests } from './prs'
import { heldUp } from './sending'
import { type Terminals, Tmux } from './tmux'
import {
  actorFromEnv,
  capture,
  checkTell,
  openSession,
  placeWork,
  projectCommand,
  roleLine,
  sessionFromEnv,
  TODO_USAGE,
  todayCommand,
  todoCommand,
} from './todo-cli'
import { type Found, OPEN_ROLES, oneOf, parseRef, Todos } from './todos'
import { scheduleEnv, scheduleOff, scheduleOn, tick } from './triggers'
import {
  indent,
  type LsTask,
  lsGroups,
  lsLine,
  lsMode,
  lsTable,
  oneLine,
  owner,
  reopenCommand,
  taskLabel,
  taskNote,
  taskStatus,
} from './view'
import {
  answer,
  cancel,
  drop,
  keepWorker,
  type Restart,
  reportLostTells,
  restart,
  restartDue,
  resume,
  SELF,
  StopEvent,
  startReady,
  startTask,
  tell,
} from './worker'

// How long the permission hook gives each send of what it allowed (permissionHook); a local socket
// takes far less.
const ALLOWED_SEND_MS = 1000

const USAGE = `usage:
  nod [--issue <key,...>] [--mine] open decisions (--issue: only those of tasks on these issues;
                                   --mine: only those of this Claude session's tasks)
  nod <decision> <answer...>       answer a decision; the worker gets it in its own session
  nod drop <decision>              end the task instead of answering
  nod cancel <task> [--reason <text>]
                                   end a task that has not ended (queued, running, or waiting on
                                   a decision) as drop does: its turn and any check or review of
                                   one stop with its session, its decisions close, the tasks
                                   after it are cancelled with it, its todo is a next action
                                   again, and the session that hears of it is told cancelled.
                                   Who cancelled it (this session, a worker or human) and the
                                   reason stay as its error. Its folder, branch and transcript
                                   stay for gc. A task that ended is refused, one that succeeded
                                   and waits on its pull request too, and one that is landing
                                   (its worker has its landing work, or a land decision is open):
                                   nod drop on its decision stops that, and nod land goes on with
                                   it. A worker cancels only the tasks of its
                                   own work (its project, or the session that added it)
  nod add <brief> [--repo <path> --branch <name>] [--check <command>] [--model <model>]
          [--after <task,...>] [--issue <key>] [--todo <todo> | --project <project>]
                                   start a worker on the task now, or once the tasks it comes
                                   after have succeeded. A brief of one line naming a file is
                                   that file's text; an empty one is refused. In a repo it works
                                   on a new branch <name> in the worktree
                                   <home>/work/<repo folder>/<name>, started from the earlier
                                   task's branch in the same repo.
                                   --issue names the issue it works on, so ls, decisions and
                                   notify events show it. --todo delegates that todo to the
                                   task: it waits on the task, is a next action again if it is
                                   dropped, and once it succeeds is done if its branch has no
                                   commits the default branch lacks, else waits on the branch's
                                   open pull request (linked to the todo) or nod's landing, and
                                   is a next action without either; gc and the tick close it
                                   once the commits are in the default branch; the brief may then be
                                   left out for the todo's title and notes. Without --todo the
                                   task gets a todo of its own, titled by the brief's first line,
                                   in --project when given. Run in a Claude session, the task
                                   records that session as its root. In a session nod open
                                   opened, the work goes in its project, a todo with none
                                   included, and work of another project is refused. In an
                                   orchestrator or relay session, work of any project is refused,
                                   with where it goes instead. Work in no project goes in from an
                                   orchestrator; from a relay or any other Claude session it is
                                   refused, as no session would hear of it; from a shell it goes
                                   in, and nod says so on stderr
  nod open <project> [--new]       Claude Code in this terminal, in the project's session, named
                                   after it each time it opens (a /rename lasts until then):
                                   the latest one nod open opened for it, resumed in the folder
                                   it was opened in (started again under its ID while this
                                   account keeps no transcript of it); or, with --new, none yet,
                                   or a transcript with nothing said in it, a new one here. Ends
                                   as Claude Code does. Each session of a project has all its
                                   tasks as its own (--mine), whichever session added them, and
                                   nod add there keeps to the project. nod tells it each of
                                   them that ends and each decision that opens (see below)
  nod open <name> --role orchestrator|relay [--new]
                                   a session of that role and no project: the first of that
                                   name, or the same as nod open <name>. A name another role has,
                                   or that names a project, is refused
  nod open <name> [--new]          the latest session of that name, as a project's is opened, when
                                   no project goes by it; a session of another name runs beside
                                   it. Its tasks are those it added. nod add there takes no
                                   project's work: a project's goes to its session with nod tell
                                   p<n>, or in as a todo with nod in --project. An orchestrator
                                   hands over work in no project and hears of it (see below); a
                                   relay passes what comes from outside to the project session it
                                   is for, hands over no task, and nod tells it of no task
  nod session claim <name> --role orchestrator|relay
                                   give the Claude session this runs in that role and name, its
                                   conversation going on: nod records it if it did not know it,
                                   with the folder its transcript says it was opened in, a project
                                   session leaves its project, and it says where it takes messages
  nod tell <task> <message...>     send a follow-up into the task's session
  nod tell p<project> <message...> send a message into the project's session, as nod tells it of
                                   its tasks; kept until that session takes messages. From an
                                   orchestrator session it is refused when another orchestrator
                                   is in charge of the project (nod project set --orchestrator)
  nod resume <task>                reopen a task whose session ended, from its transcript; one that
                                   failed before its worker started starts again under the same
                                   number and branch, once you fixed what stopped it
  nod check <task> [<command>]     the task's acceptance check and who changed it when; with a
                                   command (one quoted argument, run with sh -c), its check from
                                   then on: the worker's next stop runs it (as the task lands, the
                                   repo's check runs instead when it has one), a check running now
                                   goes on, and an ended task takes it for nod resume. '' takes
                                   the check away. A worker cannot change one
  nod attach <task>                open the worker's terminal (tmux)
  nod peek <task>                  print what the worker's terminal shows right now
  nod link <task> <url...>         record where the task's result went (a pull request, a posted
                                   review), so ls and show list it next to the task. Until then
                                   they list the remote branches that hold the task's own
                                   commits, none for a task that made none
  nod ls [--all] [--mine] [--plain | --json]
                                   tasks not yet collected by gc (--all: every task; --mine: only
                                   this Claude session's: those it added, or, in a session nod
                                   open opened, its project's), as a table the terminal's width:
                                   what needs you, running, queued, ended but not dealt with (no
                                   link, no push), then ended; the latest first in each, with its
                                   issue, links and the remote branches it was pushed to.
                                   Into a pipe or with --plain, a tab-separated line a task (its
                                   number, todo, status, turns, the time its age counts from,
                                   the note's first line, issue, links, pushes); --json, a JSON
                                   line a task
  nod show <task>                  history, links, then each turn's full report, the last at the
                                   very end. root: is the Claude session whose task it is: its
                                   project's latest session, by the project and how to reopen it,
                                   with the session that added it when that was another; else the
                                   session that added it (claude --resume <session>)
  nod search <ref>                 find by number: t<n>, n<n>, r<n>, p<n>, d<n>, or <n> for every
                                   kind
  nod stats
  nod gc [<task...> | --older-than <days>]
                                   close sessions and delete workspaces and worktrees of the named
                                   finished tasks, or of tasks finished that long ago, or, with
                                   neither, of the finished tasks a signal says are done with:
                                   dropped, taken over by a newer task on the same todo, merged
                                   into the default branch, a linked pull request merged, closed or
                                   approved by you, or finished 7+ days ago (one with commits no
                                   remote has only once a linked pull request of its branch in
                                   the repo origin pushes to merged after its last commit and no
                                   other linked one waits, and only if it succeeded). Branches go
                                   once the remote's default branch has the changes, as a pushed
                                   branch may go unmerged; with neither, gc also fetches the repos
                                   of the branches it kept and deletes those merged since. Ledger
                                   rows and session transcripts stay, ls stops listing the tasks,
                                   and resume or tell brings one back. With neither, it first moves
                                   the todos nod left open on their tasks' commits: done once the
                                   commits are in the default branch, waiting while the branch's
                                   pull request is open, next once none is. The schedule runs both
                                   every 5 minutes
  nod rule ls                      the rules every worker gets after the built-in ones: each one's
                                   number, on or off, the retrospective r<n> it came from, and
                                   the rule. Answering yes to a rule decision adds one
  nod rule add <rule...>           add a rule of your own
  nod rule off|on <rule>           stop or start giving a rule to workers. Nothing deletes or
                                   rewords a rule, so where one came from stays known: to reword
                                   one, turn it off and add the new words. Each change records
                                   who made it, as a todo's do; a worker cannot make one
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
                                   becomes a decision. Inside a sandbox (SANDBOX_RUNTIME=1) it
                                   lands nothing, as the check would run in it: it lists what the
                                   tick lands outside it, or says to run it outside if the
                                   schedule is off
  nod schedule [on | off]          whether the OS scheduler runs the tick every minute; on, it
                                   runs with this shell's PATH and Claude config dir, which the
                                   watches and the workers it restarts use. It stays on until off.
                                   For work at a set time, have cron or launchd run nod add
  nod tick                         run the watches, land what the repos let nod land, and gc the
                                   finished tasks a signal says are done with (as nod gc does);
                                   the scheduled tick does the watches, landing and gc every
                                   fifth minute.
                                   It also asks about turns whose terminal is gone (a restart of
                                   the machine or tmux) and about tasks that have waited an hour
                                   on background work, has a worker report again when Claude Code
                                   cut off the Stop hook checking its turn (its time limit, a
                                   sleep), and restarts the workers due a restart
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
  nod hook stop|notification|permission|prompt|inbox
                                   called by Claude Code hooks in worker sessions, and (inbox) in
                                   the sessions nod open opens. permission allows a worker's
                                   command that only touches what its folder can make again:
                                   rm -rf of paths holding no uncommitted work in its worktree,
                                   or a package manager adding or removing registry packages.
                                   nod show lists each, and the root session hears of it (nod
                                   tells a project session). Any other prompt becomes a decision
                                   as it shows
  nod run <task> <claude...>       what runs in a worker's terminal: keeps its Claude Code running

A <task> is n<n>, t<n> for the latest task doing todo t<n>, or r<n> for the task retrospective r<n>
runs in. A <decision> is d<n>. Each also takes its bare number <n>.
${TODO_USAGE}

A project's session (the latest nod open opened) hears from nod itself: a message when each of the
project's tasks ends (succeeded, error, cancelled, once its check and review are done) and when a
decision opens on one, with the task's number and attempt or the decision's, and what to do next.
The ledger keeps each until it went, so what comes while the session is closed goes, in one
message, once nod open opens it again. nod writes a line into the session's inbox socket, which
its hooks report as it starts (Claude Code's CLAUDE_CODE_MESSAGING_SOCKET), as another Claude
session does; Claude Code shows it as from another session, not the person. The line's format is
Claude Code's own, not documented, and the socket answers nothing: a line Claude Code drops counts
as sent. A session that skips permission prompts holds such messages for the person to approve.
One reopened with claude --resume instead of nod open, or opened before nod open gave it hooks,
reports its socket at its first nod command (Claude Code exports it to Bash too), and hears
nothing before. A nod command in a project's session that cannot hear (not the project's latest,
or no socket) says so on stderr. So does nod add, tell, resume, restart <task> or an answer in any
other Claude session, for a project whose latest session cannot hear either (none, no socket known,
or its socket gone): what that work brings waits unheard until nod open opens the project's
session, and nod --mine and nod ls --mine show it meanwhile. /clear goes on under an ID nod open
did not open: it hears nothing until nod open opens the project's session again. One with no hooks
cannot say it cleared, so what went to it after, until its next nod command, is lost: once
nod open opens it again, nod ls --mine and nod --mine show what it missed.
An orchestrator hears the same way of the tasks it added in no project: the latest session of its
name, even while another orchestrator runs. What comes while it is closed waits for it too. No
session hears of a task in no project that no orchestrator added (a shell's, say): what
comes for it goes to no session, nod add and the commands that set it going say so on stderr, as
does nod todo set --project moving its todo out of a project, and nod, nod ls and the web screen
show it.

When <home>/notify exists, nod runs it with a JSON event on stdin whenever a decision opens, a
task succeeds or fails to start, a watch passes or can no longer run, or a restart waits for a
person attached to the worker. <home> is $NOD_HOME, or ~/.nod.`

const [command, ...rest] = Bun.argv.slice(2)
const home = nodHome()
// The workers' terminals, made here once: every command and hook below is given them.
const terminals: Terminals = Tmux.of(home)
// Before the ledger opens here, as one that cannot open must not fail it either.
if (command === 'hook' && rest[0] === 'prompt') await promptHook()
if (command === 'hook' && rest[0] === 'inbox') await inboxHook()
if (command === 'hook' && rest[0] === 'permission') await permissionHook()
if (command === 'hook' && rest[0] === 'tool') await toolHook()
const ledger = new Ledger(home)
// The projects this command told stderr nobody hears, each told once (onCommand, warnUnheard).
const warned = new Set<number>()
// A session its hooks never told nod of says where it takes messages (onCommand); what goes wrong
// only goes to stderr, as the command still runs.
async function sayInbox(): Promise<void> {
  const unheard = await onCommand(
    ledger,
    sessionFromEnv(),
    process.env.CLAUDE_CODE_MESSAGING_SOCKET,
    sendLine,
    warned,
  ).catch((error) => `nod: could not record this session's inbox: ${message(error)}`)
  if (unheard !== null) console.error(unheard)
}
// nod session claim says it once the session has its role, which may change what it hears.
if (command !== 'session') await sayInbox()
const taskRef = (ref: string | undefined): number => new Todos(ledger).taskRef(ref ?? '')

switch (command) {
  case undefined:
  case '--issue':
  case '--mine': {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { issue: { type: 'string' }, mine: { type: 'boolean' } },
    })
    const keys = issueKeys(values.issue)
    const session = mySession(values.mine)
    printDecisions(
      ledger.openDecisions().filter((d) => {
        const task = ledger.get(d.taskId)
        return onIssues(keys, task) && isMine(session, task)
      }),
    )
    break
  }
  case 'add':
    await add(rest)
    break
  case 'session':
    await sessionCommand(rest)
    break
  case 'tell': {
    if (/^p\d+$/.test(rest[0] ?? '')) {
      const p = parseRef(rest[0] ?? '', 'p')
      checkTell(new Todos(ledger), sessionFromEnv(), p)
      const sent = await tellProject(ledger, p, words(rest.slice(1)), actorFromEnv())
      console.log(
        sent ? 'sent' : `not sent yet: p${p} has no session taking messages; it goes once one does`,
      )
      break
    }
    const id = taskRef(rest[0])
    warnUnheard([id])
    await tell(ledger, home, terminals, id, words(rest.slice(1)), answerer())
    console.log(heldUp(ledger, id) ?? 'sent')
    break
  }
  case 'resume': {
    const id = taskRef(rest[0])
    warnUnheard([id])
    console.log(await resume(ledger, home, terminals, id))
    break
  }
  case 'check':
    checkCommand(rest)
    break
  case 'attach':
    attach(taskRef(rest[0]))
    break
  case 'open':
    open(rest)
    break
  case 'peek':
    peek(taskRef(rest[0]))
    break
  case 'link': {
    const id = taskRef(rest[0])
    const urls = rest.slice(1)
    if (urls.length === 0) throw new Error(USAGE)
    ledger.link(id, urls)
    console.log(`linked n${id}: ${ledger.links(id).join(' ')}`)
    break
  }
  case 'ls': {
    const { values } = parseArgs({
      args: rest,
      options: {
        all: { type: 'boolean' },
        mine: { type: 'boolean' },
        plain: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    })
    const session = mySession(values.mine)
    const live = terminals.sessions()
    const tasks = await readAtOnce(
      ledger.list().filter((t) => (values.all || t.collectedAt === null) && isMine(session, t)),
      (t) => lsTask(t, live),
    )
    const listed = lsGroups(tasks).flatMap((g) => g.tasks)
    const mode = lsMode(values, process.stdout.isTTY, process.env.NO_COLOR)
    if (mode === 'json') {
      for (const t of listed) console.log(JSON.stringify(t))
    } else if (mode === 'plain') {
      for (const t of listed) console.log(lsLine(t))
    } else {
      // Some terminals report no width, or 0.
      const width = process.stdout.columns || 80
      console.log(lsTable(tasks, width, mode === 'color', new Date()))
      const ids = new Set(tasks.map((t) => t.id))
      const open = ledger.openDecisions().filter((d) => ids.has(d.taskId)).length
      if (open > 0) console.log(`답할 결정 ${open}개 — nod${values.mine ? ' --mine' : ''}`)
    }
    break
  }
  case 'show':
    await show(taskRef(rest[0]))
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
    const id = parseRef(rest[0] ?? '', 'd', true)
    console.log(said[await drop(ledger, home, terminals, id, answerer())])
    break
  }
  case 'cancel': {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reason: { type: 'string' } },
      allowPositionals: true,
    })
    if (positionals.length !== 1) throw new Error(USAGE)
    const id = taskRef(positionals[0])
    // A worker cancels only the tasks of its own work, as it tells only those (cannotTell in
    // worker.ts): one working on what anyone could write in an issue steers no other.
    const worker = process.env.NOD_TASK
    if (
      worker !== undefined &&
      !new Todos(ledger).sameWork(ledger.get(Number(worker)), ledger.get(id))
    ) {
      throw new Error(`a worker cancels only the tasks of its own work, and n${id} is not one`)
    }
    const reason = values.reason?.trim() || null
    await cancel(ledger, home, terminals, id, actorFromEnv(), reason)
    console.log('cancelled')
    break
  }
  case 'gc':
    await gc(rest)
    break
  case 'stats':
    console.log(JSON.stringify(ledger.stats(), null, 2))
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
    const { passed, collected, lost, waited, cut, restarted, closed, landed } = await tick(
      ledger,
      home,
      terminals,
      new Date(),
      true,
    )
    if (passed.length > 0) console.log(`watch passed: ${passed.map((id) => `t${id}`).join(', ')}`)
    if (collected.length > 0) console.log(`collected task(s) ${taskList(collected)}`)
    if (lost.length > 0) console.log(`turn(s) lost with their terminal: ${taskList(lost)}`)
    if (waited.length > 0) console.log(`waited too long on background work: ${taskList(waited)}`)
    if (cut.length > 0) console.log(`went on from a check cut off: ${taskList(cut)}`)
    if (restarted.length > 0) console.log(`restarted task(s) ${taskList(restarted)}`)
    if (closed.length > 0) console.log(`closed the terminal(s) of task(s) ${taskList(closed)}`)
    for (const m of landed) console.log(`landing n${m.id}: ${m.did}`)
    const did = [passed, collected, lost, waited, cut, restarted, closed, landed]
    if (did.every((x) => x.length === 0)) console.log('nothing due')
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
    await keepWorker(ledger, home, terminals, taskRef(rest[0]), rest.slice(1))
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
  // Gone in v32: whoever still types them hears what does that work now.
  case 'watch':
    console.error(
      'nod watch is gone: the session nod open <project> or nod session claim opened hears the decisions and ends; nod ls --mine shows what it missed',
    )
    process.exit(1)
    break
  case 'trigger':
    console.error(
      'nod trigger is gone: run nod add from cron or launchd at a set time; nod in --source <name> --key <key> takes each item once',
    )
    process.exit(1)
    break
  default: {
    const id = Number(/^d\d+$/.test(command) ? command.slice(1) : command)
    if (!Number.isInteger(id)) {
      console.error(USAGE)
      process.exit(1)
    }
    const { taskId, reason, answer: answered } = ledger.decision(id)
    // Yes to a rule decision adds a rule, which `nod rule` refuses a worker, and yes to a trust
    // decision trusts the repo for later tasks too (trustedBy in worker.ts).
    if (process.env.NOD_TASK !== undefined && reason === 'rule') {
      throw new Error('a worker cannot change the rules')
    }
    if (process.env.NOD_TASK !== undefined && reason === 'trust') {
      throw new Error('a worker cannot trust a repo')
    }
    const said = words(rest)
    // What sets nothing going: an answer to one answered already, or left open on a task that
    // finished, and no to landing again.
    const stops = reason === 'land' && !/^y(es)?$/i.test(said)
    if (answered === null && !finished(ledger, taskId) && !stops) warnUnheard([taskId])
    const took = await answer(ledger, home, terminals, id, said, actorFromEnv(), answerer())
    if (reason === 'land') {
      console.log(/^y(es)?$/i.test(said) ? 'landing it again' : 'stopped landing it')
      // Yes tries again now, not at the next fifth minute, unless this is a sandbox (leaveToTick).
      if (/^y(es)?$/i.test(said)) await landCommand([taskId])
    } else {
      const sent = heldUp(ledger, taskId) ?? `answered; sent to task n${taskId}`
      console.log(took ? sent : `closed; task n${taskId} had ended`)
    }
  }
}

// Every nod command checks the workers' account; after the command, so a message it sends goes
// first (deliver starts that worker again with it). The hooks check their own worker.
if (command !== 'hook' && command !== 'restart') {
  await restartDue(ledger, home, terminals).catch((error) =>
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
  const todo = values.todo === undefined ? null : todos.get(parseRef(values.todo, 't'))
  const rootSession = sessionFromEnv()
  const projectId = placeWork(todos, rootSession, values.project, todo)
  // A clarified todo already says what to do.
  const brief =
    todo !== null && positionals.length === 0
      ? [todo.title, todo.notes].filter((x) => x !== null).join('\n\n')
      : briefFile(words(positionals))
  const after = (values.after ?? '').split(',').filter(Boolean).map(taskRef)
  const repo = repoPath(values.repo)
  const task = {
    brief,
    repo,
    branch: branchName(repo, values.branch),
    checkCmd: values.check ?? null,
    model: values.model ?? null,
    after,
    issue: values.issue ?? null,
    rootSession,
  }
  const actor = actorFromEnv()
  const id =
    todo === null
      ? todos.delegateNew(task, projectId, actor)
      : todos.delegate(todo.id, task, actor, projectId)
  warnUnheard([id])
  // A task that comes after others starts here only if they have all succeeded already.
  if (after.length === 0) await startTask(ledger, home, terminals, id)
  else await startReady(ledger, home, terminals)
  console.log(id)
}

// A brief of one line naming a file is that file's text, so the todo, show and decisions say what
// the work is, not where its brief was written.
function briefFile(brief: string): string {
  if (brief.includes('\n')) return brief
  try {
    if (!statSync(brief).isFile()) return brief
  } catch {
    // No such file, or a line too long or odd for a path (ENAMETOOLONG, ENOTDIR): plain words.
    return brief
  }
  const text = readFileSync(brief, 'utf8').trim()
  if (text === '') throw new Error(`the brief file ${brief} is empty`)
  return text
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
  } else if ((sub === 'on' || sub === 'off') && args.length === 1) {
    printRule(ledger.setRule(ruleId(args[0]), sub, actor))
  } else {
    throw new Error(USAGE)
  }
}

// The check runs outside the sandbox, so a worker cannot set its own (or another's): only the person
// or a Claude session, which nod add --check already lets set one. The sandbox is what keeps a
// worker off the ledger; this refuses plainly, as rule does.
function checkCommand([ref, ...cmd]: string[]): void {
  if (ref === undefined) throw new Error(USAGE)
  // One shell command, as account's is: words joined back would lose their quotes.
  if (cmd.length > 1) {
    throw new Error(
      `give the check as one quoted argument: nod check ${ref} 'bun test && bun run lint'`,
    )
  }
  const id = taskRef(ref)
  if (cmd[0] !== undefined) {
    if (process.env.NOD_TASK !== undefined) throw new Error("a worker cannot change a task's check")
    // An empty command takes it away, as nod repo --check '' does.
    ledger.setCheck(id, cmd[0].trim() || null, actorFromEnv())
  }
  const { checkCmd } = ledger.get(id)
  console.log(checkCmd === null ? `n${id} has no check` : `n${id} check: ${checkCmd}`)
  for (const line of checkChanges(id)) console.log(`  ${line}`)
}

// Each change to the task's check, with when and who made it.
function checkChanges(id: number): string[] {
  return ledger.taskChanges(id).map((c) => {
    const [from, to] = c.change.checkCmd ?? []
    return `${c.at} ${c.actor}: ${String(from ?? '—')} → ${String(to ?? '—')}`
  })
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
        `task n${id}'s repo does not let nod land it: nod repo ${repo ?? '<path>'} pr`,
      )
    }
    if (ledger.landing(id)?.stopped) ledger.setLanding(id, { stopped: null, note: null })
  }
  if (process.env.SANDBOX_RUNTIME === '1') {
    leaveToTick(ids.length > 0 ? ids : undefined)
    return
  }
  const moved = await land(ledger, home, terminals, {
    sayBusy: true,
    ...(ids.length > 0 ? { only: ids } : {}),
  })
  for (const m of moved) console.log(`n${m.id} ${m.did}`)
  if (moved.length === 0) console.log('nothing to land')
}

// Claude Code adds SANDBOX_RUNTIME=1 to the commands it runs in its sandbox, and a check run from
// there runs in it: what the sandbox blocks skips (nod's tmux tests, test/tmux-server.ts), and the
// check passes all the same. So nod land lands nothing there and says what the tick, outside it,
// lands. One named that only nod land would look at (added before its repo went up) gets its
// landing row, from which on the tick lands it too.
function leaveToTick(only: number[] | undefined): void {
  const tasks = dueTasks(ledger, terminals, only)
  if (tasks.length === 0) {
    console.log('nothing to land')
    return
  }
  for (const t of tasks) if (ledger.landing(t.id) === null) ledger.setLanding(t.id, {})
  const ticks = scheduleEnv(home) !== null
  const why =
    'nod land lands nothing inside a sandbox (SANDBOX_RUNTIME=1): the check would run in it, where the tests it blocks skip, and could pass all the same.'
  console.log(
    ticks
      ? `${why} The tick lands these outside it at its next fifth minute; nod show <task> has where each stands.`
      : `${why} The schedule is off, so no tick lands them: run nod land in a shell outside the sandbox, or turn the schedule on there (nod schedule on).`,
  )
  const waits = ticks ? 'waits for the tick' : 'waits for nod land outside the sandbox'
  for (const t of tasks) console.log(`n${t.id} ${waits}`)
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
  const going: number[] = []
  for (const id of ids) {
    const how = await restart(ledger, home, terminals, id, 'nod restart')
    console.log(`n${id} ${said[how]}`)
    if (how !== 'no terminal') going.push(id)
  }
  // Restarting every worker (no task named) is an account switch, not this session taking on
  // their work.
  if (refs.length > 0) warnUnheard(going)
}

function accountCommand([how, ...args]: string[]): void {
  const [path] = args
  if (how === 'env' && args.length === 0) setAccountRule(home, null)
  else if (how === 'file' && path !== undefined && args.length === 1) {
    setAccountRule(home, { file: resolve(path) })
  } else if (how === 'command' && args.length === 1) {
    // One shell command, as a watch is: words joined back would lose their quotes.
    setAccountRule(home, { command: words(args) })
  } else if (how !== undefined) throw new Error(USAGE)
  console.log(describeRule(accountRule(home)))
  console.log(`  now ${configDir(home) ?? "(none: Claude Code's default)"}`)
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
    const out = await onStop(ledger, home, terminals, StopEvent.parse(input))
    if (out !== null) console.log(out)
  } else if (event === 'notification') {
    await onNotification(ledger, home, terminals, NotificationEvent.parse(input))
  } else if (event === 'stop-failure') {
    await onStopFailure(ledger, home, terminals, StopFailureEvent.parse(input))
  } else if (event === 'compact') {
    const out = onCompact(ledger, SessionStartEvent.parse(input))
    if (out !== null) console.log(out)
  } else {
    throw new Error(USAGE)
  }
}

// The UserPromptSubmit hook prints nothing, since Claude Code adds what it prints to the
// conversation, and exits 0 whatever goes wrong, which only goes to stderr: it must not stop or
// change a message a person types, with other hooks of theirs maybe on the same event.
async function promptHook(): Promise<never> {
  console.log = console.error
  try {
    const event = PromptEvent.parse(JSON.parse(await Bun.stdin.text()))
    await onPrompt(new Ledger(home), home, terminals, event)
  } catch (error) {
    console.error(`nod: could not record the turn: ${message(error)}`)
  }
  process.exit(0)
}

// The SessionStart and SessionEnd hook of a session nod open opened (onInbox), the same way: a
// project session starts and ends whatever becomes of this, and SessionStart's stdout would go
// into it.
async function inboxHook(): Promise<never> {
  console.log = console.error
  try {
    const event = InboxEvent.parse(JSON.parse(await Bun.stdin.text()))
    await onInbox(new Ledger(home), event, process.env.CLAUDE_CODE_MESSAGING_SOCKET)
  } catch (error) {
    console.error(`nod: could not record the session's inbox: ${message(error)}`)
  }
  process.exit(0)
}

// A worker's PermissionRequest hook (allow.ts), the same way: it prints Claude Code's allow only for
// a command nod allows, and else nothing, so the prompt shows, whatever goes wrong. One it does not
// allow becomes a decision here, as it shows (onPermissionAsk); if that fails, the prompt's
// Notification opens it. Claude Code acts on an allow once the hook exits, so the task's project
// session hears of it with a short limit: what does not go in time waits for the next send (a tick,
// an event), and the allow is not held toward the prompt's Notification (about 6 s).
async function permissionHook(): Promise<never> {
  console.log = console.error
  try {
    const event = PermissionEvent.parse(JSON.parse(await Bun.stdin.text()))
    const ledger = new Ledger(home)
    if (onPermissionRequest(ledger, event)) {
      await Bun.write(Bun.stdout, `${JSON.stringify(ALLOW)}\n`)
      await sendNotices(ledger, (socket, line) => sendLine(socket, line, ALLOWED_SEND_MS))
    } else {
      await onPermissionAsk(ledger, home, event)
    }
  } catch (error) {
    console.error(`nod: could not judge or record the permission prompt: ${message(error)}`)
  }
  process.exit(0)
}

// A worker's PostToolUse and PostToolUseFailure hook (onToolRan), the same way: it runs after every
// tool, and the worker goes on whatever becomes of it.
async function toolHook(): Promise<never> {
  console.log = console.error
  try {
    const event = ToolEvent.parse(JSON.parse(await Bun.stdin.text()))
    await onToolRan(new Ledger(home), home, event)
  } catch (error) {
    console.error(`nod: could not close the decision of the tool's dialog: ${message(error)}`)
  }
  process.exit(0)
}

function attach(taskId: number): void {
  if (!terminals.alive(sessionName(taskId))) throw noTerminal(taskId)
  // Unset TMUX so this also works from inside another tmux session.
  const { TMUX: _outer, ...env } = process.env
  const result = Bun.spawnSync(terminals.attachCommand(sessionName(taskId)), {
    stdio: ['inherit', 'inherit', 'inherit'],
    env,
  })
  process.exit(result.exitCode)
}

// Claude Code in this terminal, in the project's session, with this shell's environment and, unless
// that says, AUTOCOMPACT_PCT; nod ends as it does.
function open(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { new: { type: 'boolean' }, role: { type: 'string' } },
    allowPositionals: true,
  })
  const [ref, ...extra] = positionals
  if (ref === undefined || extra.length > 0) throw new Error(USAGE)
  const config = process.env.CLAUDE_CONFIG_DIR || null
  const { argv, cwd } = openSession(
    new Todos(ledger),
    ref,
    values.new ?? false,
    process.cwd(),
    config,
    values.role === undefined ? undefined : oneOf('session role', values.role, OPEN_ROLES),
  )
  const env = { ...process.env }
  env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ||= AUTOCOMPACT_PCT
  const result = Bun.spawnSync(argv, { cwd, env, stdio: ['inherit', 'inherit', 'inherit'] })
  process.exit(result.exitCode ?? 1)
}

// `nod session claim`: the Claude session running this takes a role and a name, its conversation
// going on. A new row's folder is where its transcript says it was opened, as Bash may stand
// elsewhere by now and nod open resumes it from there. It then says where it takes messages, as any
// session does at its first nod command, which sends what waited and tells it when it cannot hear.
async function sessionCommand([sub, ...args]: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { role: { type: 'string' } },
    allowPositionals: true,
  })
  const [name, ...extra] = positionals
  if (sub !== 'claim' || name === undefined || extra.length > 0 || values.role === undefined) {
    throw new Error(USAGE)
  }
  const role = oneOf('session role', values.role, OPEN_ROLES)
  const session = sessionFromEnv()
  if (session === null) {
    throw new Error('nod session claim names the Claude session it runs in; run it in one')
  }
  const todos = new Todos(ledger)
  const cwd =
    todos.session(session)?.cwd ?? openedIn(process.env.CLAUDE_CONFIG_DIR || null, session)
  if (cwd === null) {
    console.error(
      `nod: no transcript of this session says where it was opened, so nod records ${process.cwd()}, where nod open goes back to it`,
    )
  }
  todos.claimSession(session, role, name, cwd ?? process.cwd())
  await sayInbox()
  // Its role may be what a notice waited for, though its socket is the one nod knew.
  await tellSessions(home)
  console.log(`this session is ${roleLine(role, name)}`)
}

// What the worker shows right now, for a Claude session that cannot attach a terminal.
function peek(taskId: number): void {
  ledger.get(taskId)
  const name = sessionName(taskId)
  if (!terminals.alive(name)) throw noTerminal(taskId)
  console.log(
    terminals
      .screen(name)
      .replace(/\n\s*\n/g, '\n')
      .trimEnd(),
  )
}

// A finished task's terminal closes after a while (closeFinished in worker.ts), and a message
// starts it again in the same conversation: one that started, and no retrospective that ended. One
// that failed before it started has a failed start but no workspace and no conversation.
function noTerminal(taskId: number): Error {
  const task = ledger.get(taskId)
  const goesOn =
    FINISHED.has(task.status) &&
    task.workspace !== null &&
    (task.retroId === null || ledger.retro(task.retroId).outcome === null)
  const why = goesOn
    ? `task n${taskId} finished and its terminal is closed; nod tell n${taskId} <message> goes on in the same conversation, and`
    : `task n${taskId} has no live session;`
  return new Error(`${why} nod show n${taskId} has its history`)
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
    throw new Error("--mine picks a Claude session's tasks; run it in that session")
  }
  return session
}

// Who answers, drops or tells here, for the project's session (noticeAnswered): a nod worker, which
// is no person, or the Claude session this runs in, or null for a person's shell.
function answerer(): string | null {
  return process.env.NOD_TASK === undefined ? sessionFromEnv() : NO_PERSON
}

// Before a command sets these tasks going: a Claude session whose work no project session hears,
// and anyone of work in no project no session hears, is told so (unheardWork); what goes wrong
// only goes to stderr, as the command still runs.
function warnUnheard(ids: number[]): void {
  try {
    for (const line of unheardWork(ledger, sessionFromEnv(), ids, warned)) console.error(line)
  } catch (error) {
    console.error(`nod: could not check who hears this work: ${message(error)}`)
  }
}

// The session's work (Todos.isMine): in a session nod open opened, its project's tasks.
function isMine(session: string | null, task: Task): boolean {
  return session === null || new Todos(ledger).isMine(session, task)
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
    // As the tick: the todos first, with the same lookup, and their failure does not stop the gc.
    const prs = pullRequests(home)
    await followWork(ledger, SELF, prs).catch((error) =>
      console.error(`nod: could not follow the todos' tasks: ${message(error)}`),
    )
    const { report, done, unchecked } = await sweep(ledger, home, terminals, prs, new Date())
    printGc(report)
    for (const d of done) if (report.removed.includes(d.id)) console.log(`  n${d.id}: ${d.reason}`)
    for (const u of unchecked) console.log(`unchecked n${u.id}: ${u.error}`)
    await reportLostTells(ledger, home)
    return
  }
  printGc(await collect(ledger, home, terminals, gcPick(positionals, olderThan)))
  await reportLostTells(ledger, home)
}

function printGc(report: GcReport): void {
  console.log(`removed ${report.removed.length} task(s): ${taskList(report.removed) || '-'}`)
  if (report.clean.length > 0) console.log(`already clean: ${taskList(report.clean)}`)
  for (const s of report.skipped) console.log(`skipped n${s.id}: ${s.reason}`)
}

function gcPick(tasks: string[], olderThan: string | undefined): GcPick {
  if (tasks.length > 0) return { ids: tasks.map((t) => ledger.get(taskRef(t)).id) }
  const days = Number(olderThan)
  if (!(days >= 0)) throw new Error(`--older-than must be a number of days: ${olderThan}`)
  return { before: new Date(Date.now() - days * 86_400_000) }
}

async function show(id: number): Promise<void> {
  const task = ledger.get(id)
  const live = terminals.sessions()
  const pushed = unlinkedPushes(task)
  await printTask(task, live, pushed)
  if (task.issue !== null) console.log(`  issue: ${task.issue}`)
  // The project session whose work it is now, by its project, with the command that goes back
  // into it, and the session that added it when that was another.
  const place = new Todos(ledger).rootPlace(task)
  if (place !== null) {
    const { project, session } = place
    const added =
      task.rootSession === null || task.rootSession === session.sessionKey
        ? ''
        : ` · added from ${task.rootSession}`
    console.log(`  root: p${project.id} ${project.title} · ${reopenCommand(place)}${added}`)
  } else if (task.rootSession !== null) {
    console.log(`  root: ${task.rootSession}`)
  }
  console.log(`  brief: ${task.brief}`)
  if (task.repo) console.log(`  repo: ${task.repo} (branch ${branchOf(task)})`)
  if (task.workspace) console.log(`  workspace: ${task.workspace}`)
  if (task.account !== null) console.log(`  account: ${task.account || "Claude Code's default"}`)
  if (task.checkCmd) console.log(`  check: ${task.checkCmd}`)
  for (const line of checkChanges(id)) console.log(`  check changed ${line}`)
  if (task.retroId !== null) {
    const r = ledger.retro(task.retroId)
    console.log(`  retrospective: r${r.id} of n${r.ofTaskId}${r.outcome ? `, ${r.outcome}` : ''}`)
    // The rule it added, on or off now.
    for (const added of ledger.rules().filter((x) => x.retroId === r.id)) {
      console.log(`  rule ${added.id} ${added.state}: ${added.text}`)
    }
  }
  if (task.todoId !== null) console.log(`  todo: t${task.todoId}`)
  for (const url of ledger.links(id)) console.log(`  link: ${url}`)
  for (const ref of await pushed) console.log(`  pushed: ${ref}`)
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
    console.log(`  after: ${after.map((a) => `n${a.id} (${a.status})`).join(', ')}`)
  }
  if (live.has(sessionName(id))) console.log(`  terminal: nod attach n${id}`)
  for (const a of ledger.attempts(id)) printAttempt(a)
  for (const t of ledger.pendingTells(id)) {
    const state = t.lostAt === null ? 'kept for its start' : 'not passed on'
    console.log(`  ${state} from n${t.fromTask}: ${oneLine(t.text, 200)}`)
  }
  for (const d of ledger.decisions(id)) {
    const answered = d.answeredAt
      ? `answered after ${secsBetween(d.createdAt, d.answeredAt)}s: ${d.answer}`
      : d.answer === null
        ? 'open'
        : `closed: ${d.answer}`
    console.log(`  decision d${d.id} ${d.reason} — ${answered}`)
  }
  for (const n of ledger.allowed(id)) console.log(`  allowed by nod ${n.createdAt}: ${n.note}`)
  // Each turn's report in order, so the last is the very end, where readers look for it. Several
  // are told apart by the number a notice gives the turn (inbox.ts); one alone needs no heading.
  const attempts = ledger.attempts(id)
  const reported = attempts.filter((a) => a.report)
  for (const a of reported) {
    const head =
      reported.length > 1 ? `--- attempt ${attempts.indexOf(a) + 1} (${a.kind}) ---\n` : ''
    console.log(`\n${head}${a.report}`)
  }
}

// One match prints as the command that shows it does; several, a line each with that command.
async function search(args: string[]): Promise<void> {
  const [ref, ...extra] = args
  if (ref === undefined || extra.length > 0) throw new Error(USAGE)
  const todos = new Todos(ledger)
  const found = todos.find(ref, (t) => taskStatus(t, terminals.sessions()))
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
    await show(one.taskId)
  }
}

// A decision has no view of its own; its task's shows it.
function opens(f: Found): string {
  if (f.kind === 'todo') return `nod todo ${f.ref}`
  if (f.kind === 'project') return `nod project ${f.ref}`
  return `nod show ${f.kind === 'retro' ? f.ref : `n${f.taskId}`}`
}

function printDecisions(decisions: Decision[]): void {
  if (decisions.length === 0) {
    console.log('nothing to decide')
    return
  }
  for (const d of decisions) printDecision(d)
  console.log('answer: nod d<n> <answer>   end the task: nod drop d<n>')
}

function printDecision(d: Decision): void {
  const task = ledger.get(d.taskId)
  console.log(`d${d.id}  ${d.reason}  (${taskLabel(task)}: ${oneLine(task.brief, 60)})`)
  console.log(`${indent(d.question)}\n`)
}

// `live`: the sessions there are, read once for every task listed.
async function lsTask(t: Task, live: ReadonlySet<string>): Promise<LsTask> {
  const attempts = ledger.attempts(t.id)
  return {
    id: t.id,
    todoId: t.todoId,
    retroId: t.retroId,
    status: t.status,
    sessionEnded: taskStatus(t, live) === 'session ended',
    turns: attempts.length,
    createdAt: t.createdAt,
    startedAt: attempts.at(-1)?.startedAt ?? null,
    finishedAt: t.finishedAt,
    collectedAt: t.collectedAt,
    note: taskNote(ledger, t),
    issue: t.issue,
    links: ledger.links(t.id),
    pushed: await unlinkedPushes(t),
  }
}

// `pushed`: unlinkedPushes, waited on once the line above it is out.
async function printTask(
  t: Task,
  live: ReadonlySet<string>,
  pushed: Promise<string[]>,
): Promise<void> {
  const turns = ledger.attempts(t.id).length
  const status = taskStatus(t, live)
  console.log(
    `n${String(t.id).padEnd(4)} ${owner(t).padEnd(5)} ${status.padEnd(14)} ${String(turns).padStart(2)} turns  ${oneLine(taskNote(ledger, t), 80)}`,
  )
  for (const url of ledger.links(t.id)) console.log(`      link ${url}`)
  for (const ref of await pushed) console.log(`      pushed ${ref}`)
}

// The remote branches holding a succeeded task's branch, while it has no link: its result was
// pushed, maybe under another name, and is waiting to be linked. None while the branch has no
// commits of its own past where they start (where landing recorded them to start, else where the
// branch was created): it sits on others' commits, which every remote branch made since may hold.
// Only as fresh as the repo's last fetch; nod fetches only as it lands a repo's tasks (land.ts) and
// as gc looks again at the branches it kept (dropMerged in gc.ts).
// Not waited on in turn: ls asks of several tasks at once (readAtOnce).
// ponytail: a branch with no commits of its own moved onto a later default branch (a rebase onto
// it) shows the remote branches holding that. ownStart would tell those apart, but it counts the
// task's commits merged into the default branch as the default branch's, hiding where it went.
async function unlinkedPushes(t: Task): Promise<string[]> {
  const { repo } = t
  if (repo === null || t.status !== 'succeeded' || ledger.links(t.id).length > 0) return []
  const branch = branchOf(t)
  const ref = `refs/heads/${branch}`
  const git = (...args: string[]) => spawn(['git', '-C', repo, ...args])
  // The repo or the branch is gone: nothing left to look in.
  if ((await git('rev-parse', '--verify', '-q', ref)).code !== 0) return []
  // With the branch's reflog gone, the default branch stands in for where its commits start.
  const start =
    ledger.landing(t.id)?.base ?? (await createdFrom(repo, branch)) ?? 'refs/remotes/origin/HEAD'
  if ((await git('merge-base', '--is-ancestor', ref, start)).code === 0) return []
  return remotesHolding(repo, ref)
}

function printAttempt(a: Attempt): void {
  const secs = a.finishedAt ? `${secsBetween(a.startedAt, a.finishedAt)}s` : 'running'
  const check = a.checkResult ? ` check ${a.checkResult}` : ''
  // Its first turn takes what workers told a task before it started as messages, so those count.
  const within = ledger.messages(a.taskId).filter((m) => m.attemptId === a.id)
  const senders = new Set([a.fromTask, ...within.map((m) => m.fromTask)].filter((f) => f !== null))
  const from = senders.size === 0 ? '' : ` from ${taskList([...senders])}`
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

// Tasks as nod names them: `n3, n5`.
function taskList(ids: number[]): string {
  return ids.map((id) => `n${id}`).join(', ')
}

function secsBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000)
}
