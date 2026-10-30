import { ASKED, announce, asking, closeDecisions, decide, goesOn, WENT_ON } from './decisions'
import type { Attempt, Decision, Ledger } from './ledger'
import {
  endedWithoutStop,
  HELD_BACK,
  heardOf,
  STOPPED_TURN,
  transcriptLines,
  transcriptTail,
} from './transcript'
import { oneLine } from './view'

// A worker's turns in the ledger: the turn a hook belongs to (currentTurn, openTurn), and a turn
// that ended without its Stop hook, as the person stopped it or a hook of theirs held their message
// back (endTurnWithoutStop, stoppedDialogs, forgetHeldBack, as its transcript shows) or as its
// Claude Code or terminal went (cutOff), with the decisions it closes or opens (decisions.ts). What
// goes into the worker's terminal (deliver, carryUnheard) is worker.ts's. This module takes no
// terminal, and imports none of worker.ts, hooks.ts or land.ts.

// The prompt of a turn nod did not send: one a person typed into the worker's terminal, or one
// Claude Code went on to by itself. What a person typed follows it on the next line, as the prompt
// of a turn or as a message that went into one (onPrompt), so the reviewer reads it as theirs.
export const TYPED = '(typed into the terminal)'
export const typedHere = (text: string): boolean => text.startsWith(TYPED)
// What a decision a turn showed gets once that turn is cut off with its terminal or Claude Code.
export const CUT = '(the turn was cut off)'
// What a permission decision gets once the person stopped its turn with Escape (stoppedDialogs).
export const STOPPED_DIALOG = '(the person stopped its turn)'

// Takes out of the ledger the last words a person typed into turn `open` once a hook of theirs held
// that message back (endedWithoutStop): Claude Code never took it in, so neither the review nor the
// worker goes by it, and what they type instead is what counts. Only if no message in the whole
// transcript has those words: a held-back message may also keep nod's hook from recording it, and
// then the last words recorded are ones Claude Code did take in, maybe long before. A transcript
// that cannot be read leaves them.
// ponytail: words Claude Code keeps otherwise than the hook got them read as never taken in (heardOf).
export function forgetHeldBack(ledger: Ledger, home: string, open: Attempt): void {
  const last = ledger
    .messages(open.taskId)
    .findLast((m) => m.attemptId === open.id && typedHere(m.text))
  const words = last?.text ?? (typedHere(open.prompt) ? open.prompt : TYPED)
  if (words === TYPED) return
  const lines = transcriptLines(ledger, home, open.taskId, open.sessionId)
  if (lines === null) return
  if (heardOf(lines, words.slice(TYPED.length + 1)) !== 'lost') return
  if (last === undefined) ledger.setPrompt(open.id, TYPED)
  else ledger.forgetMessage(last.id)
}

// currentAttempt's turn, in the ledger only, with what it closed and with what, for the caller to
// announce.
export function currentTurn(
  ledger: Ledger,
  taskId: number,
  sessionId: string,
): { id: number; closed: Decision[]; why: string } {
  const turn = openTurn(ledger, taskId, sessionId)
  // A turn nod sent closed these as it started (deliver). One the prompt hook opened leaves them
  // to here, the turn's end as before it was opened at its start, so a turn the person stops
  // (Escape, no Stop) leaves the question open and the task waiting on it. What the person typed in
  // it so far answers them, all of it, in order: the worker took it in after what it asked, and a
  // turn they stopped takes what they type next. One with no words of theirs (Claude Code went on
  // by itself, or a hook of theirs held them back) went on without an answer.
  if (!typedHere(turn.prompt)) return { id: turn.id, closed: [], why: WENT_ON }
  const said = ledger.messages(taskId).filter((m) => m.attemptId === turn.id)
  const words = [turn.prompt, ...said.map((m) => m.text)]
    .filter((t) => typedHere(t) && t !== TYPED)
    .map((t) => t.slice(TYPED.length + 1))
  const why = words.length === 0 ? WENT_ON : words.join('\n')
  const asked = (d: Decision) => ASKED.includes(d.reason) && d.attemptId !== turn.id
  const closed = closeDecisions(ledger, taskId, asked, why)
  goesOn(ledger, taskId, closed)
  return { id: turn.id, closed, why }
}

// The task's open turn, or one opened as a turn nod did not send, with `prompt`. In one transaction
// with the look, as deliver opens its turns in one, so of a hook and a message at once only one
// opens it. `taken`: what goes into the ledger with a turn found open, in that transaction.
export function openTurn(
  ledger: Ledger,
  taskId: number,
  sessionId: string,
  prompt = TYPED,
  taken: (open: Attempt) => void = () => {},
): Attempt {
  return ledger.db
    .transaction((): Attempt => {
      const open = ledger.openAttempt(taskId)
      if (open !== null) {
        taken(open)
        return open
      }
      const id = ledger.startAttempt({
        taskId,
        kind: 'followup',
        decisionId: null,
        sessionId,
        prompt,
      })
      return ledger.attempt(id)
    })
    .immediate()
}

// Ends the open turn a person typed in once its transcript shows it ended without a Stop hook: they
// stopped it with Escape (no Stop, measured on 2.1.290), or a hook of theirs held the message back
// before it became a turn. Open for good, it would keep its terminal, take the next message as one
// of its own, hold restarts back, and read as cut off once Claude Code starts again. Not one with a
// decision open, a permission dialog the person stopped say: closing that would leave its task
// waiting on nothing, so it goes as before, closed by the next turn's Stop, or cut off. Words of a
// message held back leave the ledger (forgetHeldBack), also from a turn nod sent that a person
// typed into, which is not theirs to end here. Errors only go to stderr: what calls this goes on as
// before.
// ponytail: reads the transcript's end, in Claude Code's own format; a format that changes reads as
// not ended, which leaves the turn open as before.
export function endTurnWithoutStop(ledger: Ledger, home: string, taskId: number): void {
  const open = ledger.openAttempt(taskId)
  if (open === null) return
  const theirs = typedHere(open.prompt)
  const said = ledger.messages(taskId).some((m) => m.attemptId === open.id && typedHere(m.text))
  if (!theirs && !said) return
  const why = endedWithoutStop(transcriptTail(ledger, home, open))
  if (why === HELD_BACK) forgetHeldBack(ledger, home, open)
  if (!theirs || why === null) return
  if (ledger.decisions(taskId).some((d) => d.answer === null && d.attemptId === open.id)) return
  ledger.failOpenAttempt(open.id, why)
}

// Closes the permission decisions of the open turn once its transcript shows the person stopped it
// with Escape: the dialog went with the turn (no Stop, 2.1.290). Since the dialog's decision opens
// as it shows (onPermissionAsk), one they answered so within seconds is a decision too. Only before
// a message, nod's (deliver) or one they type (onPrompt), which goes on past it at once: elsewhere
// the decision stays as before, so a typed turn it closes does not leave its task running with no
// turn. A transcript that cannot be read leaves it open (transcriptTail).
// ponytail: the prompt hook runs before Claude Code writes the message to the transcript, as a
// message a hook holds back leaves none (2.1.310), so its end still shows the stop; not measured
// with a dialog stopped.
// ponytail: reads the transcript's end as endTurnWithoutStop does; a format that changes leaves
// the decision open, as before.
export function stoppedDialogs(ledger: Ledger, home: string, taskId: number): Decision[] {
  const open = ledger.openAttempt(taskId)
  if (open === null || asking(ledger, taskId, open.id) === undefined) return []
  if (endedWithoutStop(transcriptTail(ledger, home, open)) !== STOPPED_TURN) return []
  const ofTurn = (d: Decision) => d.reason === 'permission' && d.attemptId === open.id
  const closed = closeDecisions(ledger, taskId, ofTurn, STOPPED_DIALOG)
  goesOn(ledger, taskId, closed)
  return closed
}

// A turn a person typed that ended without a Stop (endTurnWithoutStop): it ran no turn of the
// worker's, or none that went anywhere.
export const noTurn = (a: Attempt): boolean =>
  typedHere(a.prompt) && (a.error === STOPPED_TURN || a.error === HELD_BACK)

// A turn that ended without its Stop hook, because its Claude Code or terminal went. It may have
// done part of its work, so the person decides how it goes on instead of nod running it again. A
// permission or trust prompt it was showing went with it. Returns whether it raised the decision.
export async function cutOff(
  ledger: Ledger,
  home: string,
  taskId: number,
  attempt: Attempt,
  why: string,
): Promise<boolean> {
  // Taken first, in one statement: of two that find the turn open at once (ticks, say), one raises
  // the decision. A message sent while Claude Code started again may have run it to its end since.
  if (!ledger.failOpenAttempt(attempt.id, why.split('\n')[0] ?? why)) return false
  const closed = closeDecisions(ledger, taskId, (d) => d.attemptId === attempt.id, CUT)
  await announce(home, ledger.get(taskId), closed, CUT)
  await decide(
    ledger,
    home,
    taskId,
    attempt.id,
    'interrupted',
    `${why}\nThe turn did not finish, and part of it may be done. It was on:\n> ${oneLine(attempt.prompt, 200)}\nAnswer with how to go on, such as to check what is done and carry on; the answer goes into the same conversation.`,
  )
  return true
}
