import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { z } from 'zod'
import { configDir, transcriptPath } from './account'
import type { Attempt, Ledger } from './ledger'
import { message } from './proc'
import { jsonOrNull } from './report'
import { pasted } from './tmux'

// Reading the transcript Claude Code keeps of a worker's session (JSONL): whether there is one, its
// lines or its end, how its last turn ended, and what became of a message pasted in while a turn
// ran. It only reads: what nod changes in the ledger by it (endTurnWithoutStop, forgetHeldBack,
// stoppedDialogs, carryUnheard) is worker.ts's. This module imports none of worker.ts, hooks.ts or
// land.ts.

// How Claude Code marks a turn the person stopped (endTurnWithoutStop), how much of the
// transcript's end is read for it, and what a typed turn that ended without a Stop ends with in the
// ledger.
const STOP_MARK = '[Request interrupted by user'
const TRANSCRIPT_TAIL = 256 * 1024
export const STOPPED_TURN = 'the person stopped it (Escape)'
export const HELD_BACK = 'a hook held the message back'

// The lines of the transcript of a task's session; null for one there is none of, or that cannot
// be read, which goes to stderr only.
export function transcriptLines(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): string[] | null {
  try {
    const file = transcriptOf(ledger, home, taskId, sessionId)
    return file === null ? null : readFileSync(file, 'utf8').split('\n')
  } catch (error) {
    console.error(`nod: could not read the transcript of task n${taskId}: ${message(error)}`)
    return null
  }
}

// The lines at the end (TRANSCRIPT_TAIL) of the transcript of turn `open`'s session; none for one
// there is none of, or that cannot be read, which goes to stderr only.
export function transcriptTail(ledger: Ledger, home: string, open: Attempt): string[] {
  try {
    const file = transcriptOf(ledger, home, open.taskId, open.sessionId)
    if (file === null) return []
    const fd = openSync(file, 'r')
    try {
      const size = fstatSync(fd).size
      const end = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL))
      readSync(fd, end, 0, end.length, size - end.length)
      return end.toString().split('\n')
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    console.error(`nod: could not read the transcript of task n${open.taskId}: ${message(error)}`)
    return []
  }
}

// Where Claude Code keeps the transcript of the task's session `sessionId`: in the account its
// worker runs as, where '' is Claude Code's default folder and null an account nod never recorded.
function transcriptOf(
  ledger: Ledger,
  home: string,
  taskId: number,
  sessionId: string,
): string | null {
  const { account } = ledger.get(taskId)
  return transcriptPath(account === null ? configDir(home) : account || null, sessionId)
}

// Whether Claude Code keeps a transcript of session `sessionId` in the config dir `config`.
export function hasTranscript(config: string | null, sessionId: string): boolean {
  return transcriptPath(config, sessionId) !== null
}

const TranscriptEntry = z.object({
  type: z.string(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  interruptedByShutdown: z.boolean().optional(),
  promptSubmitEnding: z.unknown().optional(),
  message: z.object({ content: z.unknown() }).optional(),
  // Of Claude Code's queue (heardOf); an entry they do not fit still reads.
  operation: z.string().optional().catch(undefined),
  content: z.unknown().optional(),
  attachment: z.object({ type: z.string(), prompt: z.unknown() }).optional().catch(undefined),
})

// How the last turn in a transcript's end `lines` (transcriptTail) ended, if without a Stop hook;
// null if it did not, or for all this can tell. Read as Claude Code reads its own transcript
// (2.1.310's binary): the last message of the person's or the worker's, not a subagent's
// (sidechain), decides. The person's stop
// is their message `[Request interrupted by user…]`, in a text block, so a tool's output holding
// the words is none, and not one Claude Code marks as written as it shut down
// (`interruptedByShutdown`), a turn cut off. A message a hook held back leaves no message of the
// person's but a system entry with `promptSubmitEnding` (measured on 2.1.310 with `claude -p`).
export function endedWithoutStop(lines: string[]): string | null {
  for (const line of lines.toReversed()) {
    const parsed = TranscriptEntry.safeParse(jsonOrNull(line))
    if (!parsed.success || parsed.data.isSidechain === true) continue
    const entry = parsed.data
    if (entry.type === 'system' && entry.promptSubmitEnding !== undefined) return HELD_BACK
    if (entry.type === 'assistant') return null
    if (entry.type !== 'user' || entry.isMeta === true) continue
    const texts = textsOf(entry.message?.content)
    // What a local command such as /exit leaves is no turn of its own.
    if (texts.some((t) => typeof t === 'string' && /^<(command-|local-command-)/.test(t))) continue
    const stopped = texts.some((t) => typeof t === 'string' && t.startsWith(STOP_MARK))
    return stopped && entry.interruptedByShutdown !== true ? STOPPED_TURN : null
  }
  return null
}

// What became of a message pasted into a worker's Claude Code while a turn ran (heardOf).
type Fate = 'heard' | 'queued' | 'lost'

// What became of `text`, pasted into a worker's Claude Code while a turn ran, as the transcript
// `lines` show it (2.1.310, read from nod's own workers). Claude Code queues it (a
// `queue-operation` entry, `enqueue`, one of several lines wrapped in `<pasted_content>`), and
// takes it out of the queue (`remove`) as it gives it to the worker at the turn's next tool call,
// in an `attachment` entry of type `queued_command`, or (`dequeue`) as it runs it as a turn of its
// own once the turn ends. One that waited in the prompt file while Claude Code started again
// (deliver) is in the first message of that start, a `user` entry, with no queue. The last entry
// with the words decides, so words sent again count from their last. 'lost': no entry, so Claude
// Code never had it.
// ponytail: reads the whole transcript, parsing only the lines with the words; words inside other
// words count as those, and words Claude Code changed read as lost and go twice.
export function heardOf(lines: string[], text: string): Fate {
  const sent = pasted(text).trim()
  // Claude Code takes no blank message.
  if (sent === '') return 'heard'
  const words = JSON.stringify(sent).slice(1, -1)
  let fate: Fate = 'lost'
  for (const line of lines) {
    if (!line.includes(words)) continue
    const parsed = TranscriptEntry.safeParse(jsonOrNull(line))
    if (!parsed.success || parsed.data.isSidechain === true || parsed.data.isMeta === true) continue
    const { type, operation, content, attachment, message } = parsed.data
    const said =
      type === 'queue-operation'
        ? [content]
        : type === 'user'
          ? textsOf(message?.content)
          : attachment?.type === 'queued_command'
            ? [attachment.prompt]
            : []
    if (!said.some((s) => typeof s === 'string' && s.includes(sent))) continue
    fate = type === 'queue-operation' && operation === 'enqueue' ? 'queued' : 'heard'
  }
  return fate
}

// The text of a transcript message's `content`: a string, or the text blocks of a list.
const textsOf = (content: unknown): unknown[] =>
  Array.isArray(content)
    ? content.flatMap((b) => (b?.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    : [content]
