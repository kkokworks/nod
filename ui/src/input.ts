// What the browser sends, checked for shape before a server function runs. The values (a status, a
// day) are checked on the server, where the ledger's lists of them live.

// The todo fields a page edits as text; an empty string clears one.
const TEXT_FIELDS = [
  'title',
  'notes',
  'addNote',
  'status',
  'context',
  'waitingOn',
  'due',
  'scheduled',
  'start',
  'repeat',
  'focus',
] as const
export type RawEdit = Partial<Record<(typeof TEXT_FIELDS)[number], string>> & {
  projectId?: number | null
}
export type RawProjectEdit = { title?: string; outcome?: string; status?: string }

export function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${what} must be an object`)
  }
  return v as Record<string, unknown>
}

export function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${what} must be an integer`)
  return v
}

// The Done page shows this many of each list at first, and this many more at a time.
export const SHOWN_STEP = 100
// The most a page can ask for: each 5-second reload makes every row shown again.
export const SHOWN_MAX = 5000

// How many of a list to show: the number of rows the page asks for.
const isShown = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SHOWN_MAX

function shown(v: unknown, what: string): number {
  if (!isShown(v)) throw new Error(`${what} must be an integer from 1 to ${SHOWN_MAX}`)
  return v
}

// The Done page's three lists, each with how many of it to show.
const DONE_LISTS = ['done', 'dropped', 'collected'] as const
export type DoneShown = Record<(typeof DONE_LISTS)[number], number>

export function doneShown(v: unknown): DoneShown {
  const o = record(v, 'shown')
  return {
    done: shown(o.done, 'done'),
    dropped: shown(o.dropped, 'dropped'),
    collected: shown(o.collected, 'collected'),
  }
}

// The counts in the Done page's address. One that is not a count (an address edited by hand, a
// bookmark from before SHOWN_MAX was lowered) is dropped, as the todo page drops a bad `edit`, and
// its list shows the first SHOWN_STEP.
export function doneSearch(s: Record<string, unknown>): Partial<DoneShown> {
  const out: Partial<DoneShown> = {}
  for (const list of DONE_LISTS) {
    const v = s[list]
    if (isShown(v)) out[list] = v
  }
  return out
}

export function text(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what} must be text`)
  return v
}

export function rawEdit(v: unknown): RawEdit {
  const edit: RawEdit = {}
  for (const [key, value] of Object.entries(record(v, 'edit'))) {
    if (key === 'projectId') {
      edit.projectId = value === null ? null : int(value, key)
      continue
    }
    const field = TEXT_FIELDS.find((f) => f === key)
    if (field === undefined) throw new Error(`a todo has no field ${key}`)
    edit[field] = text(value, key)
  }
  return edit
}

export function rawProjectEdit(v: unknown): RawProjectEdit {
  const o = record(v, 'edit')
  const edit: RawProjectEdit = {}
  for (const key of Object.keys(o)) {
    if (key !== 'title' && key !== 'outcome' && key !== 'status') {
      throw new Error(`a project has no field ${key}`)
    }
    edit[key] = text(o[key], key)
  }
  return edit
}
