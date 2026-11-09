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

// The pull request's text a worker writes above its report line: the title, then the body. The
// title is the first heading when that is a `# ` one, and the lines above it go: a worker may say
// how its work went before the text it was asked for. Else it is the first line, as before nod
// asked for the heading; a body's `##` section or a shell comment in its code then is no title.
// ponytail: under such a first-line title, a body whose first heading is a `# ` one gives that
// heading as the title: it is the shape of a status line above the title, told apart only by
// guessing, so PR_TEXT asks for `##` sections.
// The lines nod reads are nod's; any other `nod:` line, and a code fence's, is the text's. Null
// without a title.
export function prText(report: string): { title: string; body: string } | null {
  const all = report.split('\n')
  const code = keptCode(all)
  const lines = all.filter((l, i) => code[i] || !nodReads(l))
  const heading = firstHeading(lines)
  const titled = /^ {0,3}#[ \t]/.test(lines[heading] ?? '')
  const at = titled ? heading : lines.findIndex((l) => l.trim() !== '')
  const first = titled ? lines[at]?.trimStart() : lines[at]
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

// Whether one line opens as a status. Not parseReport, which runs here for each line of the text:
// its pattern takes seconds over a long run of spaces before a carriage return.
const isStatus = (line: string): boolean =>
  /^NOD:\s*(done|question|failed)\s*\|/i.test(line.replace(/[*`]/g, '').trim())

// Whether one line has a form parseReport, parseCaptures or parseTells read: nod acts on it, or
// sends it back to be fixed, so it is what nod takes out of the text.
const nodReads = (line: string): boolean =>
  isStatus(line) || nodLines(line, 'in').length > 0 || nodLines(line, 'tell').length > 0

// The index of the first Markdown heading with words, outside code fences, or -1: an empty one is
// neither a title nor a section.
function firstHeading(lines: string[]): number {
  const { inside } = fences(lines)
  return lines.findIndex((line, i) => !inside[i] && /^ {0,3}#{1,6}[ \t]+\S/.test(line))
}

// Which lines of a report are code the pull request's text keeps whole: those of a fence that
// closes. Markdown runs a fence never closed to the end, but a report line under one is still nod's:
// such a fence keeps nothing. Nor does any with no status out of code: that worker wrapped its
// report, whose lines must not go out in the text.
// ponytail: fences only, with up to three spaces before them and LF line ends: an indented code
// block, a fence indented further under a list or one in CRLF text loses its lines in a form nod
// reads. Tell those apart when one bites.
function keptCode(lines: string[]): boolean[] {
  const { inside, unclosed } = fences(lines)
  const code = inside.map((fenced, i) => fenced && i < unclosed)
  return lines.some((l, i) => !code[i] && isStatus(l)) ? code : []
}

// Which lines are in a code fence, its mark lines too, and the line where a fence never closed
// opens (`lines.length` with none). A fence closes on a line of its own marks, at least as many and
// nothing after them: a "```sh" line inside it is its code. Ticks with more ticks after them on the
// line are inline code, and open none.
function fences(lines: string[]): { inside: boolean[]; unclosed: number } {
  const inside: boolean[] = []
  let fence: string | null = null
  let unclosed = lines.length
  for (const [i, line] of lines.entries()) {
    const marks = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1]
    const closes = marks?.startsWith(fence ?? '\n') && /^ {0,3}(`+|~+)[ \t]*$/.test(line)
    inside.push(fence !== null || marks !== undefined)
    if (fence === null && marks !== undefined) {
      fence = marks
      unclosed = i
    } else if (closes) {
      fence = null
      unclosed = lines.length
    }
  }
  return { inside, unclosed }
}

// What a worker is asked when nod needs the pull request's text (land.ts), in a turn with nothing
// else to do (TEXT_ONLY).
export const TEXT_ONLY =
  'Change nothing else this turn, and skip the subagent review: nothing changes.'
export const PR_TEXT =
  "nod then opens a pull request for your branch. Above your report line, write it for the repo's readers: its title as a `# ` heading on the first line, then its body in Markdown with `##` sections (what changed and why, how it was checked, and the conflict table if you resolved any). It goes out as you write it, so leave out anything that must not be published."
