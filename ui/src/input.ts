// What the browser sends, checked for shape before a server function runs. The values (a status, a
// day) are checked on the server, where the ledger's lists of them live.

// The todo fields a page edits as text; an empty string clears one.
export const TEXT_FIELDS = [
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
export function shown(v: unknown, what: string): number {
  const n = int(v, what)
  if (n < 1 || n > SHOWN_MAX) throw new Error(`${what} must be from 1 to ${SHOWN_MAX}`)
  return n
}

// The Done page's three lists, each with how many of it to show.
export const DONE_LISTS = ['done', 'dropped', 'collected'] as const
export type DoneShown = Record<(typeof DONE_LISTS)[number], number>

export function doneShown(v: unknown): DoneShown {
  const o = record(v, 'shown')
  return {
    done: shown(o.done, 'done'),
    dropped: shown(o.dropped, 'dropped'),
    collected: shown(o.collected, 'collected'),
  }
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
