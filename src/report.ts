import { z } from 'zod'

// What a worker's report says, read from its text: the last `NOD: <status> | <text>` line, the
// `NOD: in` and `NOD: tell` lines above it, and as it lands the pull request's text above them all,
// with what the worker is asked for that text. What nod does with them is in worker.ts (settle),
// and with the pull request's text in verify.ts (verifyLanding).

// More than this in one report is more than a person can clarify, or a worker gone wrong.
const MAX_CAPTURES = 50

// A todo a worker asks nod to capture. Its sandbox keeps it out of the ledger, so nod captures for
// it, into the inbox only, where the person clarifies it.
const Capture = z
  .object({
    title: z.string().trim().min(1),
    notes: z.string().trim().min(1).optional(),
    link: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
    key: z.string().trim().min(1).optional(),
  })
  .refine((c) => c.key === undefined || c.source !== undefined, 'a key needs its source')
export type Capture = z.infer<typeof Capture>

// A message a worker asks nod to send another task's worker (`NOD: tell`). Its sandbox keeps it off
// the ledger and that worker's terminal, so its Stop hook sends it, the way `nod tell` does.
export type Tell = { to: number; text: string }

type Report = { status: 'done' | 'question' | 'failed'; text: string }

// The last `NOD: <status> | <text>` line, ignoring Markdown emphasis around it.
export function parseReport(text: string): Report | null {
  for (const line of text.split('\n').reverse()) {
    const match = /^NOD:\s*(done|question|failed)\s*\|\s*(.*)$/i.exec(
      line.replace(/[*`]/g, '').trim(),
    )
    const status = match?.[1]?.toLowerCase()
    if (status === 'done' || status === 'question' || status === 'failed') {
      return { status, text: match?.[2]?.trim() ?? '' }
    }
  }
  return null
}

// A report's `NOD: <word>` lines, without the code ticks or Markdown emphasis around them.
export const nodLines = (text: string, word: string): string[] =>
  text
    .split('\n')
    .map(nodLine)
    .filter((l): l is string => l !== null && new RegExp(`^NOD:\\s*${word}\\b`, 'i').test(l))

// A report line as `NOD:…`, or null for one that is not. The ticks or emphasis it opens with close
// right after its `NOD:` (`**NOD:** tell …`) or at its end (`**NOD: tell …**`), and no more of
// them goes than opened, so a message that ends in `*` or a tick keeps it. Counted, not matched by
// a pattern that backtracks: a worker's line may be long.
function nodLine(raw: string): string | null {
  const line = raw.trim()
  const [opened, marks = ''] = /^([`*]*)NOD:/i.exec(line) ?? []
  if (opened === undefined) return null
  const rest = line.slice(opened.length)
  if (marks !== '' && rest.startsWith(marks)) return `NOD:${rest.slice(marks.length)}`
  let end = rest.length
  while (end > 0 && rest.length - end < marks.length && '`*'.includes(rest.charAt(end - 1))) end--
  return `NOD:${rest.slice(0, end)}`
}

// The `NOD: in {…}` lines of a report, or what is wrong with them, to send back to the worker.
export function parseCaptures(text: string): { captures: Capture[] } | { error: string } {
  const lines = nodLines(text, 'in')
  if (lines.length > MAX_CAPTURES) {
    return { error: `${lines.length} \`NOD: in\` lines; report at most ${MAX_CAPTURES}` }
  }
  const captures: Capture[] = []
  for (const line of lines) {
    const parsed = Capture.safeParse(jsonOrNull(line.replace(/^NOD:\s*in\s*/i, '')))
    if (!parsed.success) {
      return {
        error: `A \`NOD: in\` line nod cannot read: ${line}\n${z.prettifyError(parsed.error)}\nWrite it as NOD: in {"title": "…"} with JSON, or leave it out.`,
      }
    }
    captures.push(parsed.data)
  }
  return { captures }
}

export function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// The `NOD: tell n<task> <message>` lines of a report, or what is wrong with one, to send back to
// the worker. `#<task>` is how workers wrote it before `n`, and one started then still may.
export function parseTells(text: string): { tells: Tell[] } | { error: string } {
  const tells: Tell[] = []
  for (const line of nodLines(text, 'tell')) {
    const [, to, said] = /^NOD:\s*tell\s+[n#](\d+)\s+(\S.*)$/i.exec(line) ?? []
    if (to === undefined || said === undefined) {
      return {
        error: `A \`NOD: tell\` line nod cannot read: ${line}\nWrite it as NOD: tell n<task> <message>, on one line, or leave it out.`,
      }
    }
    tells.push({ to: Number(to), text: said.trim() })
  }
  return { tells }
}

// The pull request's text a worker writes above its report line: the title on its first line,
// then the body. The `NOD:` lines are nod's. Null without a title.
export function prText(report: string): { title: string; body: string } | null {
  const lines = report.split('\n').filter((l) => nodLine(l) === null)
  const at = lines.findIndex((l) => l.trim() !== '')
  const first = lines[at]
  if (first === undefined) return null
  const title = first
    .replace(/^#+\s*/, '')
    .replace(/^[*`]+|[*`]+$/g, '')
    .trim()
    .slice(0, 256)
  if (title === '') return null
  return {
    title,
    body: lines
      .slice(at + 1)
      .join('\n')
      .trim(),
  }
}

// What a worker is asked when nod needs the pull request's text (land.ts), in a turn with nothing
// else to do (TEXT_ONLY).
export const TEXT_ONLY =
  'Change nothing else this turn, and skip the subagent review: nothing changes.'
export const PR_TEXT =
  "nod then opens a pull request for your branch. Above your report line, write it for the repo's readers: its title on the first line, then its body in Markdown (what changed and why, how it was checked, and the conflict table if you resolved any). It goes out as you write it, so leave out anything that must not be published."
