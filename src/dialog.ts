import { announce, closeDecisions, decide } from './decisions'
import type { Decision, Ledger } from './ledger'
import { sessionName } from './place'
import { message } from './proc'
import type { Terminals } from './tmux'

// The permission dialog a worker's terminal shows: what it asks (dialogOn), the decision it opens
// (askOnScreen), and whether a yes to a decision would go to its own (toAnswer). Of the dialogs that
// wait in a session only one shows, while each sends a Notification, the ones behind it too, that
// does not say which it is of (2.1.330 on). So a decision opens only on the dialog that shows, in its
// words: one behind it gets its own once it shows, and the words a person says yes to are those of
// the dialog that takes it. This module imports none of worker.ts or hooks.ts.

// How long nod waits for a dialog to be drawn, or to go. In the open so a test can lower it.
export const WAIT = { dialogMs: 2000 }
const POLL_MS = 100
// A dialog's Notification comes some 6 s after it shows, so one that comes sooner after a dialog was
// answered is that one's, and late.
const ANSWERED_MS = 5000

// Text as it compares: with no wrapping, boxes or width of rules.
export const squeeze = (text: string): string =>
  text.replace(/[─╌]{3,}/g, '─').replace(/[\s│]/g, '')

export type Dialog = {
  // As it shows.
  text: string
  // Whether all of it does: the top of a tall one may be out of sight, and what it asks with it.
  whole: boolean
  // What it asks, up to its answers, to compare: without the place in the queue and the time left,
  // which change as it shows.
  asks: string
  // What it holds between its rules, as a Bash call's command; null for none.
  holds: string | null
  // Whether a subagent asks, which has no hook-opened decision (onPermissionAsk).
  subagents: boolean
  // Whether another waits behind it.
  more: boolean
}

// The dialog on `screen`, the last thing there, under a rule as wide as the terminal (2.1.332's binary,
// and as nod's decisions show it). Null for none, and one nod cannot read.
// ponytail: by how Claude Code draws it; one drawn otherwise reads as none, and its decision says so.
export function dialogOn(screen: string): Dialog | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  const rule = lines.findLastIndex((l) => /^─{10,}$/.test(l))
  return readDialog(lines.slice(rule + 1), rule !== -1)
}

function readDialog(lines: string[], whole: boolean): Dialog | null {
  const answers = lines.findLastIndex((l) => /^\s*(❯\s+)?1\. /.test(l))
  if (answers === -1 || !lines.slice(answers).some((l) => /^\s*❯\s+\d+\. /.test(l))) return null
  const [title = '', ...rest] = untimed(lines.slice(0, answers))
  const [, name = title, at, of] = /^(.*?)\s+(\d+) of (\d+)$/.exec(title) ?? []
  const isRule = (l: string): boolean => /^\s*╌{10,}$/.test(l)
  const [from, to] = [rest.findIndex(isRule), rest.findLastIndex(isRule)]
  return {
    text: lines.join('\n').trimEnd(),
    whole,
    asks: squeeze([name, ...rest].join('\n')),
    holds: from === to ? null : squeeze(rest.slice(from + 1, to).join('\n')),
    subagents: / · from (a subagent|a workflow|the .+ (agent|workflow))$/.test(name),
    more: at !== undefined && Number(at) < Number(of),
  }
}

// Without the warning of the time left (2.1.331's words), which is gone once a person is there. It
// may wrap, at any width; a blank line or the question follows it.
const WARNING = squeeze('⚠ Claude Code will automatically block this request')
function untimed(lines: string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let end = i + 1
    while (
      end < lines.length &&
      lines[end]?.trim() !== '' &&
      !/^\s*Do you/.test(lines[end] ?? '')
    ) {
      end++
    }
    const warns = /^\s*⚠/.test(lines[i] ?? '')
    if (warns && squeeze(lines.slice(i, end).join('')).startsWith(WARNING)) i = end - 1
    else kept.push(lines[i] ?? '')
  }
  return kept
}

function shown(terminals: Terminals, taskId: number): Dialog | null {
  try {
    return dialogOn(terminals.screen(sessionName(taskId)))
  } catch (error) {
    console.error(`nod: could not read n${taskId}'s terminal: ${message(error)}`)
    return null
  }
}

// How a decision's first line ends when the dialog's words follow it, and what follows it when nod
// cannot tell what its dialog asks: no other command's words.
const SHOWS = ' Its dialog:'
const UNSEEN = '어느 명령인지 확인하지 못함'
// Closes one nod could not read, once it can.
const READ = '(nod can read its dialog now)'

const FIRST = /^.*/
const bodyOf = (d: Decision): string => d.question.replace(FIRST, '').slice(1)
export const isUnseen = (d: Decision): boolean => bodyOf(d).startsWith(UNSEEN)
// The dialog it was worded from, if one: one the hook words (permissionQuestion) is worded from none.
const drawnIn = (d: Decision): Dialog | null =>
  FIRST.exec(d.question)?.[0].endsWith(SHOWS) ? readDialog(bodyOf(d).split('\n'), true) : null

// Whether decision `d` is about `dialog`, for sure: worded from that dialog, or from the command it
// holds.
function isFor(d: Decision, dialog: Dialog): boolean {
  if (!dialog.whole) return false
  const drawn = drawnIn(d)
  if (drawn !== null) return dialog.asks === drawn.asks
  return !dialog.subagents && dialog.holds === squeeze(bodyOf(d))
}

// Whether the hook worded it from a Bash command; and from one short enough that its dialog holds it
// whole (2.1.332 shows a command whole or not at all) and fits the terminal (50 rows, 200 columns, as
// nod opens it; a person's narrower one only refuses a yes): at most 20 rows of 200, 1000 characters.
const isBash = (d: Decision): boolean =>
  d.question.startsWith('Claude needs your permission to use Bash.')
const rowsOf = (text: string): number =>
  text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 200)), 0)
const isShort = (d: Decision): boolean =>
  isBash(d) && bodyOf(d).length <= 1000 && rowsOf(bodyOf(d)) <= 20

// Whether it may be: one the hook worded, for all nod can tell of a long command's or another tool's;
// of a dialog whose top is out of sight, not a short command's, but one nod could not read.
function mayBe(d: Decision, dialog: Dialog): boolean {
  if (isFor(d, dialog)) return true
  if (isUnseen(d)) return !dialog.whole
  return !dialog.subagents && drawnIn(d) === null && (dialog.whole || !isShort(d))
}

// Whether the hook worded it from another command than the Bash command that shows, or for another
// tool.
// ponytail: not told of a long command's, nor while another tool's dialog shows, whose words are not
// the input's (a file's edit, also one of sed's).
const isOther = (d: Decision, dialog: Dialog): boolean =>
  dialog.whole &&
  /^\s*Bash command\b/.test(dialog.text) &&
  !isFor(d, dialog) &&
  (!isBash(d) || isShort(d))

// Whether a yes to it may go to `dialog`.
const mayTake = (d: Decision, dialog: Dialog): boolean => mayBe(d, dialog) && !isOther(d, dialog)

const ofTurn = (ledger: Ledger, taskId: number, attemptId: number): Decision[] =>
  ledger.decisions(taskId).filter((d) => d.reason === 'permission' && d.attemptId === attemptId)

// Whether one of `decisions` is open for the dialog that shows; any, when nod reads none there.
const covered = (decisions: Decision[], dialog: Dialog | null): boolean =>
  decisions.some((d) => d.answer === null && (dialog === null || mayTake(d, dialog)))
// The decision of `turn` answered whose dialog `dialog` is: one that still shows for a moment.
const answeredFor = (turn: Decision[], dialog: Dialog): Decision | undefined =>
  turn.find((d) => d.answer !== null && isFor(d, dialog))

const answeredNow = (d: Decision): boolean =>
  d.answeredAt !== null && Date.now() - Date.parse(d.answeredAt) < ANSWERED_MS

// Opens the decision of the dialog that shows, unless the turn has one open for it; `said`, what its
// Notification says. Not of one just answered through nod, which may still show for a moment.
export async function askOnScreen(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  taskId: number,
  attemptId: number,
  said: string,
): Promise<void> {
  for (const until = Date.now() + WAIT.dialogMs; ; await Bun.sleep(POLL_MS)) {
    const dialog = shown(terminals, taskId)
    const turn = ofTurn(ledger, taskId, attemptId)
    if (covered(turn, dialog) || (dialog === null && turn.some(answeredNow))) return
    const stands = dialog?.whole && answeredFor(turn, dialog) === undefined
    if (stands || Date.now() >= until) {
      await open(ledger, home, taskId, attemptId, dialog, said)
      return
    }
  }
}

// Opens the decision of `dialog`, or of one nod cannot read. Two Notifications at once read the same
// screen, so whether it is open is looked at as it opens. One of those nod could not read closes as
// it can read what shows: it would take the same answer again.
async function open(
  ledger: Ledger,
  home: string,
  taskId: number,
  attemptId: number,
  dialog: Dialog | null,
  said = 'Claude needs your permission',
): Promise<void> {
  const whole = dialog?.whole === true
  const asks = whole ? `${SHOWS}\n${dialog.text}` : `\n${UNSEEN} (nod attach n${taskId})`
  let read: Decision[] = []
  await decide(
    ledger,
    home,
    taskId,
    attemptId,
    'permission',
    `${said}. Answer yes to allow; anything else denies.${asks}`,
    () => {
      const unseen = ofTurn(ledger, taskId, attemptId).filter((d) => whole && isUnseen(d))
      read = closeDecisions(ledger, taskId, (d) => unseen.some((u) => u.id === d.id), READ)
    },
    () =>
      ledger.openAttempt(taskId)?.id !== attemptId ||
      covered(ofTurn(ledger, taskId, attemptId), dialog),
  )
  await announce(home, ledger.get(taskId), read, READ)
}

// The dialog a yes to the permission decision `decision` goes to, null when nod reads none. Refuses
// one that would go to another dialog, and opens that one's decision if it has none: one answered in
// the terminal, or tools that ran at once, leave a decision whose dialog is not the one that shows.
// Not of one that a decision answered just now, which may still show for a moment.
export async function toAnswer(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  decision: Decision,
): Promise<Dialog | null> {
  const { id, taskId, attemptId } = decision
  const dialog = shown(terminals, taskId)
  if (dialog === null || isFor(decision, dialog)) return dialog
  // The one it is for: of one whose top is out of sight, one nod could not read.
  const itsOwn = (): Decision | undefined =>
    ofTurn(ledger, taskId, attemptId).find(
      (d) =>
        d.answer === null && d.id !== id && (isFor(d, dialog) || (!dialog.whole && isUnseen(d))),
    )
  if (mayTake(decision, dialog) && itsOwn() === undefined) return dialog
  const answered = answeredFor(ofTurn(ledger, taskId, attemptId), dialog)
  if (answered === undefined) await open(ledger, home, taskId, attemptId, dialog)
  const own = itsOwn()
  const then =
    own !== undefined
      ? `answer d${own.id} first`
      : answered !== undefined
        ? `that of d${answered.id}, answered, may still show: try again in a moment`
        : `look at it (nod attach n${taskId}) first`
  throw new Error(`n${taskId}'s terminal shows another dialog than d${id}'s: ${then}`)
}

// Once `dialog` is answered: the one behind it shows, and its Notification comes some 6 s later. Its
// decision opens here, so that no message goes into it meanwhile. Nothing to do while the turn has
// another open, which holds messages back as well (deliver).
export async function askNext(
  ledger: Ledger,
  home: string,
  terminals: Terminals,
  { taskId, attemptId }: Decision,
  dialog: Dialog | null,
): Promise<void> {
  if (!dialog?.more || covered(ofTurn(ledger, taskId, attemptId), null)) return
  for (const until = Date.now() + WAIT.dialogMs; ; await Bun.sleep(POLL_MS)) {
    const next = shown(terminals, taskId)
    if (next?.whole && next.asks !== dialog.asks) {
      await open(ledger, home, taskId, attemptId, next)
      return
    }
    if (Date.now() >= until) return
  }
}
