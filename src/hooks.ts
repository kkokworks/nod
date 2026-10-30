import { z } from 'zod'
import type { PermissionEvent } from './allow'
import {
  announce,
  asking,
  closeDecisions,
  decide,
  ended,
  goesOn,
  QUESTION_LIMIT,
} from './decisions'
import type { Attempt, Ledger } from './ledger'
import { notify, taskRef } from './notify'
import { SETTLING_OPTION, sessionName } from './place'
import { message } from './proc'
import { askedAgain } from './review'
import { pasted, running, type Terminals } from './tmux'
import { Todos } from './todos'
import { endedWithoutStop, HELD_BACK, transcriptTail } from './transcript'
import {
  currentTurn,
  cutOff,
  forgetHeldBack,
  openTurn,
  STOPPED_DIALOG,
  stoppedDialogs,
  TYPED,
  typedHere,
} from './turns'
import {
  CLAUDE_OPTION,
  continueAfter,
  restartDue,
  SELF,
  STALLED_OPTION,
  type StopEvent,
  settle,
  startReady,
} from './worker'

// What nod does as a worker's Claude Code hooks come (`nod hook <event>` in cli.ts): what each
// hook passes on stdin, and the step of the worker's lifecycle (worker.ts, its turns and decisions
// in turns.ts and decisions.ts) it takes. Which hooks a session gets is settings.ts's; the
// PermissionRequest hook's allow is allow.ts's, a project session's inbox hook inbox.ts's.
// worker.ts does not import this module.

// What a permission decision gets once the tool it asked for ran (onToolRan): the person allowed it
// in the worker's terminal, nod not having answered it.
const ALLOWED_HERE = '(allowed in the terminal)'
const UNHEARD =
  'Claude Code ended while nod checked its turn, so the failed check nod sent back reached no one.'

// What Claude Code's hooks pass on stdin (measured on 2.1.290); only the fields nod reads. The Stop
// hook's is StopEvent in worker.ts, which settle takes.
export const NotificationEvent = z.object({
  session_id: z.string(),
  notification_type: z.string(),
  message: z.string(),
})
// Sent instead of Stop when an API error ended the turn: a usage limit, a login (2.1.309).
export const StopFailureEvent = z.object({ session_id: z.string(), error: z.string() })
// Sent as Claude Code takes in a message, before its turn (measured on 2.1.310 with `claude -p`:
// session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt).
export const PromptEvent = z.object({ session_id: z.string(), prompt: z.string() })

// `source`: why the session starts: startup, resume, clear or compact. A compacted conversation
// keeps its session ID (2.1.310).
export const SessionStartEvent = z.object({ session_id: z.string(), source: z.string() })

// Sent after a tool ran (PostToolUse) or ran and failed (PostToolUseFailure), with the input it
// ran with; a subagent's has its agent_id (2.1.312's binary).
export const ToolEvent = z.object({
  session_id: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  agent_id: z.string().optional(),
})

// Called by the Stop hook. Returns the hook's stdout: a "block" that makes Claude Code continue the
// same turn with a failed check's output, or null to let the worker stop.
export async function onStop(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  event: z.infer<typeof StopEvent>,
): Promise<string | null> {
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return null
  // The turn went on after all (Claude Code continued it once the limit reset). From here to the
  // end, after nod has closed the turn, a restart would end this hook with Claude Code, so restarts
  // wait for it (settling, restartDue below). Hooks a test runs itself have no terminal.
  const name = sessionName(taskId)
  const live = terminals.alive(name)
  // Set first: a message that comes from here on runs as a turn of its own (deliver).
  if (live) terminals.setOption(name, SETTLING_OPTION, String(process.pid))
  // The Claude Code this hook answers; 0 for one keepWorker did not start.
  const claude = live ? Number(terminals.option(name, CLAUDE_OPTION)) : 0
  if (live) terminals.setOption(name, STALLED_OPTION, null)
  const attemptId = await currentAttempt(ledger, home, taskId, event.session_id)
  // And the turn it checks, so a message that finds another one open, the retry it starts, goes
  // into that one.
  if (live) terminals.setOption(name, SETTLING_OPTION, `${process.pid} ${attemptId}`)
  let out = await settle(ledger, home, terminals, ledger.get(taskId), attemptId, event).catch(
    (error) => {
      ledger.failAttempt(attemptId, message(error))
      // A task that ended meanwhile (dropped while this hook checked) stays as it ended.
      if (!ended(ledger, taskId)) ledger.error(taskId, message(error))
      return null
    },
  )
  // Claude Code ended while nod checked its turn, and keepWorker starts another: a failed check
  // sent back now reaches no one, so the turn it would have gone on in was cut off.
  if (out !== null && claude !== 0 && !running(claude)) {
    out = null
    const retry = ledger.openAttempt(taskId)
    if (retry !== null) await cutOff(ledger, home, taskId, retry, UNHEARD)
  }
  new Todos(ledger).followTasks(SELF)
  // A task that just succeeded may let others start.
  await startReady(ledger, home, terminals)
  if (live && terminals.alive(name)) terminals.setOption(name, SETTLING_OPTION, null)
  // A restart that waited for this turn to end. One that cannot run must not change what the hook
  // answers; Claude Code keeps a hook's stderr in its debug log.
  await restartDue(ledger, home, terminals, taskId).catch((error) =>
    console.error(`nod: could not restart task n${taskId}: ${message(error)}`),
  )
  return out
}

// Called by the StopFailure hook. The turn stays open: Claude Code continues it by itself once a
// usage limit resets. A restart it waits on, as another account, runs now and continues it. Other
// errors (a login, the server) it does not go on from, so the person hears of them.
export async function onStopFailure(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  event: z.infer<typeof StopFailureEvent>,
): Promise<void> {
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return
  if (terminals.alive(sessionName(taskId))) {
    terminals.setOption(sessionName(taskId), STALLED_OPTION, event.error)
  }
  if (event.error !== 'rate_limit') {
    await notify(home, {
      event: 'error',
      task: taskRef(ledger.get(taskId)),
      error: `Its turn stopped on an API error (${event.error}), which Claude Code does not go on from by itself.`,
    })
  }
  await restartDue(ledger, home, terminals, taskId).catch((error) =>
    console.error(`nod: could not restart task n${taskId}: ${message(error)}`),
  )
}

// Called by the UserPromptSubmit hook. A turn a person types into the worker's terminal is in the
// ledger from its start, with their words, as one nod sends is: until its Stop, nothing takes the
// worker for idle (closeFinished, restarts), and the review hears what they said (reviewBrief).
// Only the turn opens here; what it changes of the task waits for its Stop, as before
// (currentAttempt). Mostly the ledger, as the person's message waits on this: a turn still open,
// one they stopped say, takes this one too, as a message of its own, and its Stop closes what the
// stopped one left. A message nod pasted comes here too, into the turn deliver opened with its
// words before pasting it, and is not kept again. Words are kept only while a person is attached:
// Claude Code also runs this hook for a message it gives the worker by itself (another session's,
// as a background agent's result), which is not theirs, and that turn opens with no words, as one
// Claude Code went on to by itself.
// A command (/exit) or bash mode does not come here: it does not go through prompt.submit, as the
// 2.1.310 binary says of a prompt with no submit outcome. So a message that starts with `/` (a path)
// is a turn like any other. A permission dialog the person stopped with Escape closes here, as
// before nod's message (deliver): the message goes on past it at once, and the decision would
// otherwise hold the task and refuse nod's messages through the turn it goes on to.
// ponytail: not measured in an interactive session; a command that did come here would open a
// turn its Stop never closes, read as cut off once Claude Code starts again. Nor whether Claude Code
// runs this hook for a message it gives the worker in the middle of a turn, or how it passes one
// nod pasted: words of nod's it changed read as the person's, and are kept twice. A message Claude
// Code gives by itself while a person is attached, in a shape OWN_MESSAGE misses, reads as theirs.
export async function onPrompt(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  event: z.infer<typeof PromptEvent>,
): Promise<void> {
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return
  const name = sessionName(taskId)
  const typed = terminals.attached(name) && !OWN_MESSAGE.test(event.prompt)
  // What a restart after an API error left for the new start (restart), which nod keeps nowhere
  // else; the mark stays until a Stop.
  const stalled = typed ? terminals.option(name, STALLED_OPTION) : ''
  const left = stalled === '' ? [] : [continueAfter(stalled)]
  const said = `${TYPED}\n${event.prompt}`
  openTurn(ledger, taskId, event.session_id, typed ? said : TYPED, (open) => {
    if (!typed || pastedByNod(ledger, open, event.prompt, left)) return
    // What they typed before this, if a hook of theirs held it back, the review does not go by.
    if (endedWithoutStop(transcriptTail(ledger, home, open)) === HELD_BACK) {
      forgetHeldBack(ledger, home, open)
    }
    ledger.addMessage(taskId, open.id, said)
  })
  // After their words are in: closing the dialog's decision may fail (the ledger busy), and those
  // words are what the review and a question's answer go by. The turn stays the one it was.
  const stopped = typed ? stoppedDialogs(ledger, home, taskId) : []
  await announce(home, ledger.get(taskId), stopped, STOPPED_DIALOG)
}

// A message Claude Code gives the worker by itself, while a person may be attached: a background
// task's end, another session's message. ponytail: the tags as Claude Code shows such messages to
// the model (2.1.310); not measured as the prompt hook gets them.
const OWN_MESSAGE = /<(task-notification|agent-message)[\s>]/

// Whether `prompt`, a message Claude Code took in, holds only what nod sent into the open turn
// `open` (deliver, carryUnheard) or the start's first message (on a fresh start, nextRun puts a
// message left for it after that), or `left` for a start: nod's own, come back through the prompt
// hook. A paste of several lines comes wrapped in `<pasted_content>`, as Claude Code keeps it in its
// transcript (heardOf).
function pastedByNod(ledger: Ledger, open: Attempt, prompt: string, left: string[]): boolean {
  const start = ledger.attempts(open.taskId).findLast((a) => a.kind === 'start')
  const told = ledger
    .messages(open.taskId)
    .filter((m) => m.attemptId === open.id && !typedHere(m.text))
  const sent = [
    start?.prompt,
    typedHere(open.prompt) ? undefined : open.prompt,
    ...told.map((m) => m.text),
    ...left,
  ]
    .flatMap((t) => (t === undefined || pasted(t).trim() === '' ? [] : [pasted(t).trim()]))
    // The longest first, so one inside another goes with it.
    .sort((a, b) => b.length - a.length)
  let rest = prompt.replace(/<\/?pasted_content\b[^>]*>/g, '')
  for (const s of sent) rest = rest.replaceAll(s, '')
  return rest.trim() === ''
}

// Called by the PermissionRequest hook for a prompt nod does not allow itself (allow.ts). A permission
// prompt pauses the worker mid-turn, so it becomes a decision. Claude Code runs the hook as it shows
// the dialog (2.1.310's binary), some 6 s before the dialog's Notification, so the decision opens
// here: from then on deliver sends no message into the turn, whose Enter would answer the dialog.
// Each dialog opens its own, as each Notification did. The dialog may not be on the screen yet, so
// the question gives what the worker asked for. The decision goes in before what the turn's start
// closed is told, which may take a while (notify). Not a subagent's: a background one's runs this
// hook too, then is denied with no dialog (2.1.310's binary), so its decision waits for the
// Notification, which comes only for a dialog shown, as before.
// ponytail: beside the dialog, not before it: while the hook starts (Bun, the ledger), a message
// can still go in; only Claude Code could close that. A foreground subagent's dialog keeps the 6 s
// to its Notification; the hook cannot tell it from a background one's.
export async function onPermissionAsk(
  ledger: Ledger,
  home: string,
  event: z.infer<typeof PermissionEvent>,
): Promise<void> {
  if (event.agent_id !== undefined) return
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return
  const turn = currentTurn(ledger, taskId, event.session_id)
  await decide(
    ledger,
    home,
    taskId,
    turn.id,
    'permission',
    permissionQuestion(event.tool_name, event.tool_input),
  )
  await announce(home, ledger.get(taskId), turn.closed, turn.why)
}

// What a permission decision asks, from the tool and the input it would run with; the decision of
// the dialog a tool's run answered is found by it again (onToolRan).
function permissionQuestion(tool: string, input: Record<string, unknown>): string {
  const { command } = input
  const asked = typeof command === 'string' ? command : JSON.stringify(input)
  return `Claude needs your permission to use ${tool}. Answer yes to allow; anything else denies.\n${asked.slice(0, QUESTION_LIMIT)}`
}

// Called by the PostToolUse and PostToolUseFailure hooks: a tool ran, so the dialog that asked for
// it was answered yes, in the worker's terminal if nod did not answer it. Its decision closes, or
// nod's answer after would type Enter or Escape into a worker that went on (answer), and the task
// would wait on it to its turn's end. Only the first open one of the turn that asked for this tool
// with this input: the dialogs tools that ran at once queued may still show. Every tool run of
// every worker comes here, so with no permission decision open it ends at the first looks. Not a
// subagent's: its dialog's decision is worded from the screen (onNotification), and could match a
// main thread's by chance. Nor one whose turn has the same dialog nod answered: this run may be
// that one's, and the next such dialog still show, which a message's Enter would answer.
// ponytail: matched by the question as onPermissionAsk words it; an input Claude Code changed
// between the two hooks (a hook's updatedInput), or the same command asked twice in a turn with
// one answered through nod, leaves the decision to close at its turn's end, as before.
export async function onToolRan(
  ledger: Ledger,
  home: string,
  event: z.infer<typeof ToolEvent>,
): Promise<void> {
  if (event.agent_id !== undefined) return
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return
  const open = ledger.openAttempt(taskId)
  if (open === null) return
  const asked = permissionQuestion(event.tool_name, event.tool_input)
  const same = ledger
    .decisions(taskId)
    .filter((d) => d.reason === 'permission' && d.attemptId === open.id && d.question === asked)
  const ran = same.find((d) => d.answer === null)
  if (ran === undefined || same.some((d) => d.answeredAt !== null)) return
  const closed = closeDecisions(ledger, taskId, (d) => d.id === ran.id, ALLOWED_HERE)
  // A dialog another tool queued still holds the task.
  if (ledger.decisions(taskId).every((d) => d.answer !== null)) goesOn(ledger, taskId, closed)
  await announce(home, ledger.get(taskId), closed, ALLOWED_HERE)
}

// Called by the Notification hook: a permission prompt still shown after some 6 s. The other
// notifications need nothing from nod.
export async function onNotification(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  event: z.infer<typeof NotificationEvent>,
): Promise<void> {
  if (event.notification_type !== 'permission_prompt') return
  const taskId = ledger.taskOfSession(event.session_id)
  if (taskId === null) return
  const attemptId = await currentAttempt(ledger, home, taskId, event.session_id)
  // The PermissionRequest hook opened the dialog's decision as it showed (onPermissionAsk). One
  // Claude Code runs no hook for, a prompt only a person may answer (2.1.310), or whose hook
  // failed, opens here.
  if (asking(ledger, taskId, attemptId) !== undefined) return
  const screen = terminals.screen(sessionName(taskId))
  const prompt = screen.trimEnd().split('\n').slice(-15).join('\n')
  await decide(
    ledger,
    home,
    taskId,
    attemptId,
    'permission',
    `${event.message}. Answer yes to allow; anything else denies.\n${prompt}`,
  )
}

// Called by the SessionStart hook once Claude Code has compacted a worker's conversation: what it
// was asked is a summary there now, while the review goes by the words themselves, so it hears them
// again (askedAgain). Returns the hook's stdout, which Claude Code adds to the conversation; null
// for a session of no task, and for any other start: startup and resume still have the words, and
// a clear is the person's.
export function onCompact(ledger: Ledger, event: z.infer<typeof SessionStartEvent>): string | null {
  if (event.source !== 'compact') return null
  const taskId = ledger.taskOfSession(event.session_id)
  return taskId === null ? null : askedAgain(ledger, ledger.get(taskId))
}

// The attempt a hook event belongs to. A turn nod did not send, one a person typed straight into
// the worker's terminal or one Claude Code went on to by itself (once background agents it waited
// on finished), is recorded as a follow-up, and what the worker asked before it waits on nothing.
async function currentAttempt(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): Promise<number> {
  const turn = currentTurn(ledger, taskId, sessionId)
  await announce(home, ledger.get(taskId), turn.closed, turn.why)
  return turn.id
}
