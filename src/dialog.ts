import { decide } from './decisions'
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
  // What it asks, up to its answers, to compare: without the place in the queue and the time left,
  // which change as it shows.
  asks: string
  // Whether a subagent asks, which has no hook-opened decision (onPermissionAsk).
  subagents: boolean
  // Whether another waits behind it.
  more: boolean
}

// The dialog on `screen`, the last thing there, under a rule as wide as the terminal (2.1.332's binary,
// and as nod's decisions show it). Null for none, one whose top is out of sight, and one nod cannot read.
// ponytail: by how Claude Code draws it; one drawn otherwise reads as none, and its decision says so.
export function dialogOn(screen: string): Dialog | null {
  const lines = screen.split('\n').map((l) => l.trimEnd())
  const rule = lines.findLastIndex((l) => /^─{10,}$/.test(l))
  return rule === -1 ? null : readDialog(lines.slice(rule + 1))
}

function readDialog(lines: string[]): Dialog | null {
  const answers = lines.findLastIndex((l) => /^\s*(❯\s+)?1\. /.test(l))
  if (answers === -1 || !lines.slice(answers).some((l) => /^\s*❯\s+\d+\. /.test(l))) return null
  const [title = '', ...rest] = lines.slice(0, answers)
  const [, name = title, at, of] = /^(.*?)\s+(\d+) of (\d+)$/.exec(title) ?? []
  return {
    text: lines.join('\n').trimEnd(),
    asks: squeeze([name, ...rest.filter((l) => !/^\s*⚠/.test(l))].join('\n')),
    subagents: / · from (a subagent|a workflow|the .+ (agent|workflow))$/.test(name),
    more: at !== undefined && Number(at) < Number(of),
  }
}

function shown(terminals: Terminals, taskId: number): Dialog | null {
  try {
    return dialogOn(terminals.screen(sessionName(taskId)))
  } catch (error) {
    console.error(`nod: could not read n${taskId}'s terminal: ${message(error)}`)
    return null
  }
}

// What a decision says when nod cannot tell what its dialog asks: no other command's words.
const UNSEEN = '어느 명령인지 확인하지 못함'
const isUnseen = (d: Decision): boolean => bodyOf(d).startsWith(UNSEEN)
const SHORT = /^.{1,200}$/
const bodyOf = (d: Decision): string => d.question.slice(d.question.indexOf('\n') + 1)
// The dialog it was worded from, if one. Until 2026-11-25 that was the end of the screen, what is
// above the dialog with it or its top missing.
const drawnIn = (d: Decision): Dialog | null =>
  dialogOn(bodyOf(d)) ?? readDialog(bodyOf(d).split('\n'))

// Whether decision `d` is about `dialog`, for sure: worded from that dialog, or from the command in
// it (permissionQuestion).
function isFor(d: Decision, dialog: Dialog): boolean {
  const drawn = drawnIn(d)
  if (drawn !== null) return dialog.asks.endsWith(drawn.asks)
  return !dialog.subagents && squeeze(dialog.text).includes(`─${squeeze(bodyOf(d))}─`)
}

// Whether it may be: one nod could not tell, or one the hook worded, for all nod can tell of a long
// command's or another tool's.
const mayBe = (d: Decision, dialog: Dialog): boolean =>
  isFor(d, dialog) || isUnseen(d) || (!dialog.subagents && drawnIn(d) === null)

// Whether the hook worded it from another command than the Bash command that shows: a dialog holds a
// short command whole, and no other tool's is one.
// ponytail: not told of a long command's, nor while another tool's dialog shows, whose words are not
// the input's (a file's edit, also one of sed's).
const isOther = (d: Decision, dialog: Dialog): boolean =>
  /^\s*Bash command\b/.test(dialog.text) &&
  !isFor(d, dialog) &&
  !isUnseen(d) &&
  (!d.question.startsWith('Claude needs your permission to use Bash.') || SHORT.test(bodyOf(d)))

const ofTurn = (ledger: Ledger, taskId: number, attemptId: number): Decision[] =>
  ledger.decisions(taskId).filter((d) => d.reason === 'permission' && d.attemptId === attemptId)

// Whether one of `decisions` is open for the dialog that shows; any, when nod cannot read it.
const covered = (decisions: Decision[], dialog: Dialog | null): boolean =>
  decisions.some((d) => d.answer === null && (dialog === null || mayBe(d, dialog)))

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
    const stands = dialog !== null && !turn.some((d) => d.answer !== null && isFor(d, dialog))
    if (stands || Date.now() >= until) {
      await open(ledger, home, taskId, attemptId, said, dialog)
      return
    }
  }
}

// Two Notifications at once read the same screen, so whether it is open is looked at as it opens.
async function open(
  ledger: Ledger,
  home: string,
  taskId: number,
  attemptId: number,
  said: string,
  dialog: Dialog | null,
): Promise<void> {
  const asks = dialog?.text ?? `${UNSEEN} (nod attach n${taskId})`
  await decide(
    ledger,
    home,
    taskId,
    attemptId,
    'permission',
    `${said}. Answer yes to allow; anything else denies.\n${asks}`,
    undefined,
    () => covered(ofTurn(ledger, taskId, attemptId), dialog),
  )
}

// The dialog a yes to the permission decision `decision` goes to, null when nod cannot read it.
// Refuses one that would go to another dialog: one answered in the terminal, or tools that ran at
// once, leave a decision whose dialog is not the one that shows.
export function toAnswer(ledger: Ledger, terminals: Terminals, decision: Decision): Dialog | null {
  const { id, taskId, attemptId } = decision
  const dialog = shown(terminals, taskId)
  if (dialog === null || isFor(decision, dialog)) return dialog
  const other = ofTurn(ledger, taskId, attemptId).find(
    (d) => d.id !== id && d.answer === null && isFor(d, dialog),
  )
  if (other === undefined && mayBe(decision, dialog) && !isOther(decision, dialog)) return dialog
  const first = other === undefined ? `look at it (nod attach n${taskId})` : `answer d${other.id}`
  throw new Error(`n${taskId}'s terminal shows another dialog than d${id}'s: ${first} first`)
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
    if (ledger.openAttempt(taskId)?.id !== attemptId) return
    if (next !== null && next.asks !== dialog.asks) {
      await open(ledger, home, taskId, attemptId, 'Claude needs your permission', next)
      return
    }
    if (Date.now() >= until) return
  }
}
