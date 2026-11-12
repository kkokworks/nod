import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { announce, closeDecisions, decide, goesOn } from './decisions'
import type { Decision, Ledger } from './ledger'
import { notifyError } from './notify'
import { PROMPTED_OPTION, sessionName } from './place'
import { message } from './proc'
import { withoutRebuilt } from './review'
import { pasted, type Terminals } from './tmux'
import { heardOf, holds, promptMark, transcriptSince, transcriptSize } from './transcript'
import { oneLine } from './view'

// Knowing that a message nod typed into a worker's terminal went in (docs/design.md, 「안내 창에
// 막힌 메시지」): a paste reports nothing, and a dialog on the screen takes its keys. So this closes a
// dialog nod knows with Escape, the one key that picks nothing, and looks for the message in what
// Claude Code shows of it; one that does not go in is a decision with the screen in it. It only
// sends, looks and asks: which turn a message is for is worker.ts's.

// In the open so a test can shorten them. `waitMs`: how long a pasted message has to show, past a
// hook of the person's, which runs before Claude Code writes it down. `closeMs`: between looks while
// closing a dialog, past what it refuses keys for after one it refused (600 ms, 2.1.319's binary)
// and past Claude Code's double Escape, which one too many on an empty prompt would start. `closes`:
// how many Escapes a dialog gets; a paste it took costs one, and that guard may cost another.
// `startMs`: how long Claude Code has to take the message it started with, past its MCP servers.
export const SENDING = {
  waitMs: 15_000,
  pollMs: 250,
  closeMs: 1000,
  closes: 5,
  startMs: 60_000,
}

// The dialogs nod may close: with Escape only, as anything else picks for the person. A footer that
// is a whole line of the screen, near its end, and a title in a line above it, as the dialog shows
// them (2.1.319's binary, which does not tell what it draws beside a title), with no prompt below
// the footer, as none is drawn while the dialog is up (same binary): a conversation that quotes them
// has them in a sentence, or in a block above the prompt, and a wrong match is an Escape that stops a
// running turn.
const KNOWN_DIALOGS = [
  {
    title: 'We recommend compacting earlier',
    footer: '↑/↓ choose · ←/→ change size · enter confirm · esc not now',
  },
]
const FOOTER_FROM_END = 10
// What a dialog's box may put around its lines.
const BOX = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯─━]+$/g
const PROMPT_LINE = /^[>❯]/

export function knownDialog(screen: string): boolean {
  const lines = screen.split('\n').map((line) => line.replace(BOX, ''))
  const shown = lines.slice(0, lines.findLastIndex((line) => line !== '') + 1)
  return KNOWN_DIALOGS.some(({ title, footer }) => {
    const at = shown.lastIndexOf(footer)
    if (at === -1 || at < shown.length - FOOTER_FROM_END) return false
    if (shown.slice(at + 1).some((line) => PROMPT_LINE.test(line))) return false
    return shown.slice(0, at).some((line) => line.includes(title))
  })
}

// Who a message goes to: the turn it is for, and the session that keeps its transcript. `gone`: that
// turn closed, or its Claude Code went, so a message it lost is another's to send (carryUnheard,
// keepWorker's next start), and nothing is to be raised here.
export type Worker = {
  ledger: Ledger
  home: string
  terminals: Terminals
  taskId: number
  attemptId: number
  sessionId: string
  gone: () => boolean
}

// Closes a dialog nod knows on the screen, if there is one; false for one that stays. Looks before
// each Escape: one too many, with the dialog gone, starts Claude Code's double Escape.
async function closeDialog(to: Worker): Promise<boolean> {
  const name = sessionName(to.taskId)
  for (let i = 0; i < SENDING.closes; i++) {
    if (!knownDialog(to.terminals.screen(name))) return true
    to.terminals.keys(name, 'Escape')
    await Bun.sleep(SENDING.closeMs)
  }
  return !knownDialog(to.terminals.screen(name))
}

// Starts listening for `text`, before it can go in, and returns whether it has shown since: its
// words in the transcript's new lines (heardOf: queued is enough, it is Claude Code's now), or the
// prompt hook's mark of them, which comes first when a hook of the person's takes its time, or holds
// the message back for good. So what was sent before counts for nothing, and a message sent twice
// counts from its first.
// ponytail: another message sent at the same moment may clear this one's mark; it then goes by the
// transcript, and only a hook of the person's slow enough to last `waitMs` makes that a decision,
// which the message going in closes (onPrompt).
export function listen(to: Worker, text: string): () => boolean {
  const { ledger, home, terminals, taskId, sessionId } = to
  const name = sessionName(taskId)
  const from = transcriptSize(ledger, home, taskId, sessionId)
  const mark = promptMark(text)
  terminals.setOption(name, PROMPTED_OPTION, null)
  return () =>
    terminals.alive(name) &&
    (terminals.option(name, PROMPTED_OPTION) === mark ||
      heardOf(transcriptSince(ledger, home, taskId, sessionId, from), text) !== 'lost')
}

// Blank, a command or bash mode: no words to look for (heardOf), nor a prompt hook (onPrompt).
// ponytail: nod does not check such a message; it sends one only if a person tells it to.
function unchecked(text: string): boolean {
  const words = pasted(text).trim()
  return words === '' || words.startsWith('/') || words.startsWith('!')
}

// Types `text` into a worker's terminal and sees it go in. Returns whether the way is still clear, so
// a caller with more to send knows; false once a decision holds what is on the screen.
// A dialog nod knows is closed first, and again if one took the paste, which then goes once more:
// the dialog shows only with no turn running and nothing queued, so Claude Code ran none of it, and
// words on their way are looked for again after the close. Anything else in the way past `waitMs` is
// a decision. `told`: what must be in the ledger before the wait, for carryUnheard and the
// decision's answer to find, also of a message a dialog that stayed kept from being pasted. What
// fails after the paste is told as an error, not thrown: the message may well be on its way.
// ponytail: a dialog that comes between the look and the paste still gets its Enter. 2.1.319 refuses
// that (the paste went first, 600 ms), and nod cannot take it back from a version that does not.
export async function sendWatched(
  to: Worker,
  text: string,
  told: () => void = () => {},
): Promise<boolean> {
  const { ledger, home, terminals, taskId } = to
  const name = sessionName(taskId)
  if (!(await closeDialog(to))) {
    told()
    await stuck(to, text)
    return false
  }
  if (unchecked(text)) {
    terminals.send(name, text)
    told()
    return true
  }
  const heard = listen(to, text)
  terminals.send(name, text)
  told()
  return seeIn(to, text, heard).catch(async (error) => {
    console.error(`nod: could not see a message go in to n${taskId}: ${message(error)}`)
    await notifyError(ledger, home, taskId)(error)
    return true
  })
}

async function seeIn(to: Worker, text: string, heard: () => boolean): Promise<boolean> {
  const name = sessionName(to.taskId)
  let again = true
  let deadline = Date.now() + SENDING.waitMs
  while (!heard()) {
    if (to.gone()) return true
    const inTheWay = knownDialog(to.terminals.screen(name))
    if (inTheWay && again && (await closeDialog(to))) {
      await Bun.sleep(SENDING.closeMs)
      if (heard() || to.gone()) return true
      again = false
      to.terminals.send(name, text)
      deadline = Date.now() + SENDING.waitMs
    } else if (inTheWay || Date.now() > deadline) {
      await stuck(to, text)
      return false
    } else {
      await Bun.sleep(SENDING.pollMs)
    }
  }
  return true
}

// Watches the message a Claude Code started with, from its arguments (keepWorker), which has no
// paste to redo: only a screen nothing takes it past. `holding`: nothing to raise yet, a trust dialog
// or its decision has the start. A dialog nod knows does not show before such a message ran (2.1.319's
// binary: not with `initialMessage` set), so nothing here presses Escape.
export async function watchStart(
  to: Worker,
  text: string,
  heard: () => boolean,
  holding: () => boolean,
): Promise<void> {
  if (unchecked(text)) return
  let deadline = Date.now() + SENDING.startMs
  while (!heard()) {
    if (to.gone()) return
    if (holding()) deadline = Date.now() + SENDING.startMs
    if (Date.now() > deadline) {
      await stuck(to, text, true)
      return
    }
    await Bun.sleep(SENDING.pollMs)
  }
}

// How much a decision shows of what is on the screen and of the message.
const SCREEN_LINES = 15
const WORDS_SHOWN = 200
const SCREEN_HEAD = '\nThe screen:\n'

const lastLines = (terminals: Terminals, taskId: number): string => {
  const name = sessionName(taskId)
  return terminals.alive(name)
    ? terminals.screen(name).trimEnd().split('\n').slice(-SCREEN_LINES).join('\n')
    : ''
}

// The message a stuck decision holds and where the transcript stood before it: only its first words
// fit the question, and the same words may have gone in before. `started`: Claude Code has it from
// its arguments (watchStart). One file per decision, found by its question: two messages sent into
// one screen are two decisions. A file left is a message nod still owes, whatever closed its
// decision (a turn cut off, a message that went on past it): the next turn's end sends it (owed).
const stuckPrefix = (taskId: number): string => `.stuck-${taskId}-`
const stuckFile = (home: string, taskId: number, question: string): string =>
  join(home, 'work', `${stuckPrefix(taskId)}${Bun.hash(question).toString(36)}`)
const StuckMessage = z.object({ text: z.string(), from: z.number(), started: z.boolean() })
export type Unsent = z.infer<typeof StuckMessage>
const stuckMessage = (file: string): Unsent | null =>
  existsSync(file) ? StuckMessage.parse(JSON.parse(readFileSync(file, 'utf8'))) : null
const stuckFiles = (home: string, taskId: number): string[] => {
  const work = join(home, 'work')
  if (!existsSync(work)) return []
  return readdirSync(work)
    .filter((file) => file.startsWith(stuckPrefix(taskId)))
    .map((file) => join(work, file))
}

export function forgetStuck(home: string, taskId: number): void {
  for (const file of stuckFiles(home, taskId)) rmSync(file, { force: true })
}

// What a command that sent a message says instead of "sent" while one has stayed out, so whoever ran
// it does not read it as in.
export function heldUp(ledger: Ledger, taskId: number): string | null {
  const open = ledger.decisions(taskId).find((d) => d.answer === null && d.reason === 'stuck')
  return open === undefined
    ? null
    : `not in yet: something on the worker's screen is in the way; see decision d${open.id}`
}

// Raises what kept `text` out. The person looks at the terminal, and their answer sends it again if
// it did not go in (unsent, answer in worker.ts). Until then deliver refuses messages, whose Enter
// would go to the same screen. `from`: where the transcript stood before it, for one raised again.
async function stuck(
  to: Worker,
  text: string,
  started = false,
  from = transcriptSize(to.ledger, to.home, to.taskId, to.sessionId),
): Promise<void> {
  const { ledger, home, terminals, taskId, attemptId } = to
  const then = started
    ? '. Claude Code has this message from its start and takes it once it can, so nod types nothing, and asks again if it has not gone in'
    : ', and nod sends the message again if it has not gone in. Into a screen that has not changed nod types nothing, and asks again; you may type the message there yourself'
  const question = `A message nod sent did not reach the worker: something on its screen is in the way. Look with nod attach n${taskId} and clear it, and do not pick anything in a dialog you do not know, as that may change the person's Claude Code settings. Then answer yes${then}. Anything else you answer goes to the worker as well.\nThe message: ${oneLine(withoutRebuilt(text), WORDS_SHOWN)}${SCREEN_HEAD}${lastLines(terminals, taskId)}`
  await decide(ledger, home, taskId, attemptId, 'stuck', question, () => {
    const file = stuckFile(home, taskId, question)
    writeFileSync(file, JSON.stringify({ text, from, started }), { mode: 0o600 })
  })
}

// Sends the message of a stuck decision a person answered, unless that can do harm; then raises it
// anew, and returns false as sendWatched does. Not into the screen the decision showed, which nobody
// cleared and where Enter may pick in a dialog, and not one Claude Code has from its arguments, which
// it takes by itself: pasted too, it would run twice.
// ponytail: a screen with a clock in it reads as changed, and a person who typed nothing has to type
// the message into a screen that did not change.
export async function sendUnsent(to: Worker, decision: Decision, held: Unsent): Promise<boolean> {
  const screen = `${SCREEN_HEAD}${lastLines(to.terminals, to.taskId)}`
  if (!held.started && !decision.question.endsWith(screen)) return sendWatched(to, held.text)
  await stuck(to, held.text, held.started, held.from)
  return false
}

// The message in `file` if it has still not gone in. Reads and forgets the file: of two answers one
// gets here (the decision closes first), and a message goes once.
// ponytail: an answer the moment the person cleared the screen of a Claude Code that had the message
// waiting may find it not yet written down, and send it twice; a person is rarely that quick.
function take(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
  file: string,
): Unsent | null {
  const held = stuckMessage(file)
  if (held === null) return null
  rmSync(file, { force: true })
  // Only what the transcript got since the decision: the same words may have gone in before.
  const lines = transcriptSince(ledger, home, taskId, sessionId, held.from)
  return heardOf(lines, held.text) === 'lost' ? held : null
}

// The message the stuck decision waited on, if it has still not gone in.
export function unsent(ledger: Ledger, home: string, decision: Decision): Unsent | null {
  const { sessionId } = ledger.attempt(decision.attemptId)
  const file = stuckFile(home, decision.taskId, decision.question)
  return take(ledger, home, decision.taskId, sessionId, file)
}

// What nod still owes the worker as turn `attemptId` ends, oldest first, which is the caller's to
// send: the messages of that turn's stuck decisions, and of those closed before anyone answered. Not
// of one open on another turn, which its answer sends.
export function owed(ledger: Ledger, home: string, taskId: number, attemptId: number): string[] {
  const { sessionId } = ledger.attempt(attemptId)
  const waiting = ledger
    .decisions(taskId)
    .filter((d) => d.answer === null && d.reason === 'stuck' && d.attemptId !== attemptId)
    .map((d) => stuckFile(home, taskId, d.question))
  return stuckFiles(home, taskId)
    .filter((file) => !waiting.includes(file))
    .toSorted((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .map((file) => take(ledger, home, taskId, sessionId, file)?.text ?? null)
    .filter((text) => text !== null)
}

// A message stuck decisions waited on went in by itself (the person cleared the screen in the
// terminal, or what looked stuck was only slow), so nothing waits on it any more.
export async function wentIn(
  ledger: Ledger,
  home: string,
  taskId: number,
  prompt: string,
): Promise<void> {
  const went = ledger.decisions(taskId).filter((d) => {
    if (d.answer !== null || d.reason !== 'stuck') return false
    const file = stuckFile(home, taskId, d.question)
    const held = stuckMessage(file)
    if (held === null || !holds(prompt, held.text)) return false
    rmSync(file)
    return true
  })
  if (went.length === 0) return
  const why = '(the message went in)'
  const closed = closeDecisions(ledger, taskId, (d) => went.some((w) => w.id === d.id), why)
  // Another dialog that came since still holds the task.
  if (ledger.decisions(taskId).every((d) => d.answer !== null)) goesOn(ledger, taskId, closed)
  await announce(home, ledger.get(taskId), closed, why)
}
