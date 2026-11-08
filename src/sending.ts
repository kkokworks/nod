import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { announce, closeDecisions, decide, goesOn } from './decisions'
import type { Decision, Ledger } from './ledger'
import { notifyError } from './notify'
import { PROMPTED_OPTION, sessionName } from './place'
import { pasted, type Terminals } from './tmux'
import { heardOf, promptMark, spoken, transcriptSince, transcriptSize } from './transcript'
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
// them (2.1.319's binary, which does not tell what it draws beside a title): a conversation that
// quotes them has them in a sentence, and a wrong match is an Escape that stops a running turn.
const KNOWN_DIALOGS = [
  {
    title: 'We recommend compacting earlier',
    footer: '↑/↓ choose · ←/→ change size · enter confirm · esc not now',
  },
]
const FOOTER_FROM_END = 10
// What a dialog's box may put around its lines.
const BOX = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯─━]+$/g

export function knownDialog(screen: string): boolean {
  const lines = screen.split('\n').map((line) => line.replace(BOX, ''))
  const shown = lines.slice(0, lines.findLastIndex((line) => line !== '') + 1)
  return KNOWN_DIALOGS.some(({ title, footer }) => {
    const at = shown.lastIndexOf(footer)
    if (at === -1 || at < shown.length - FOOTER_FROM_END) return false
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
  // Blank, a command or bash mode: no words to look for (heardOf), nor a prompt hook (onPrompt).
  // ponytail: nod does not check such a message; it sends one only if a person tells it to.
  const words = pasted(text).trim()
  if (words === '' || words.startsWith('/') || words.startsWith('!')) {
    terminals.send(name, text)
    told()
    return true
  }
  const heard = listen(to, text)
  terminals.send(name, text)
  told()
  return seeIn(to, text, heard).catch(async (error) => {
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
  let deadline = Date.now() + SENDING.startMs
  while (!heard()) {
    if (to.gone()) return
    if (holding()) deadline = Date.now() + SENDING.startMs
    if (Date.now() > deadline) {
      await stuck(to, text)
      return
    }
    await Bun.sleep(SENDING.pollMs)
  }
}

// How much a decision shows of what is on the screen and of the message.
const SCREEN_LINES = 15
const WORDS_SHOWN = 200

// The message a stuck decision waits to send and where the transcript stood before it, kept for its
// answer: only the first words fit a decision's question, and the same words may have gone in before.
// ponytail: a decision that closes without an answer (the turn ended) leaves the file until the task's
// next one writes over it; nod reads it only for an open decision.
const stuckFile = (home: string, taskId: number): string => join(home, 'work', `.stuck-${taskId}`)
const StuckMessage = z.object({ text: z.string(), from: z.number() })

// Raises what kept `text` out. The person looks at the terminal, and their answer sends it again if
// it did not go in (unsent, answer in worker.ts). Until then deliver refuses messages, whose Enter
// would go to the same screen.
async function stuck(to: Worker, text: string): Promise<void> {
  const { ledger, home, terminals, taskId, attemptId, sessionId } = to
  const name = sessionName(taskId)
  const from = transcriptSize(ledger, home, taskId, sessionId)
  writeFileSync(stuckFile(home, taskId), JSON.stringify({ text, from }))
  const screen = terminals.alive(name)
    ? terminals.screen(name).trimEnd().split('\n').slice(-SCREEN_LINES).join('\n')
    : ''
  await decide(
    ledger,
    home,
    taskId,
    attemptId,
    'stuck',
    `A message nod sent did not reach the worker: something on its screen is in the way. Look with nod attach n${taskId} and clear it, and do not pick anything in a dialog you do not know, as that may change the person's Claude Code settings. Then answer yes, and nod sends the message again if it has not gone in; anything else goes to the worker as well.\nThe message: ${oneLine(text, WORDS_SHOWN)}\nThe screen:\n${screen}`,
  )
}

// The message the answered stuck decision waited on, if it has still not gone in. Reads and forgets
// the file: of two answers one gets here (the decision closes first), and a message goes once.
// ponytail: an answer the moment the person cleared the screen of a Claude Code that had the message
// waiting may find it not yet written down, and send it twice; a person is rarely that quick.
export function unsent(ledger: Ledger, home: string, decision: Decision): string | null {
  const file = stuckFile(home, decision.taskId)
  if (!existsSync(file)) return null
  const { text, from } = StuckMessage.parse(JSON.parse(readFileSync(file, 'utf8')))
  rmSync(file)
  // Only what the transcript got since the decision: the same words may have gone in before.
  const { sessionId } = ledger.attempt(decision.attemptId)
  const lines = transcriptSince(ledger, home, decision.taskId, sessionId, from)
  return heardOf(lines, text) === 'lost' ? text : null
}

// The message a stuck decision waited on went in by itself (the person cleared the screen in the
// terminal, or what looked stuck was only slow), so nothing waits on it any more.
export async function wentIn(
  ledger: Ledger,
  home: string,
  taskId: number,
  prompt: string,
): Promise<void> {
  const open = (d: Decision): boolean => d.answer === null && d.reason === 'stuck'
  if (!ledger.decisions(taskId).some(open)) return
  const file = stuckFile(home, taskId)
  if (!existsSync(file)) return
  const { text } = StuckMessage.parse(JSON.parse(readFileSync(file, 'utf8')))
  if (!spoken(prompt).includes(spoken(text))) return
  const why = '(the message went in)'
  const closed = closeDecisions(ledger, taskId, (d) => d.reason === 'stuck', why)
  // Another dialog that came since still holds the task.
  if (ledger.decisions(taskId).every((d) => d.answer !== null)) goesOn(ledger, taskId, closed)
  await announce(home, ledger.get(taskId), closed, why)
}
