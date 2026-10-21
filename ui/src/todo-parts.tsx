import { Link, useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { dayOf, daysBetween, localDay } from '../../src/days'
import { changeTodo } from './todo-fns'
import type { TodoItem } from './todos.server'

// The ledger's statuses (todos.ts), which the browser cannot import: it reaches the database.
export const STATUSES = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'dropped']

// How long a moved todo can be put back.
const UNDO_MS = 6000

// Runs a change on the server, then reloads the page's data. The error stays beside what failed.
export function useChange() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await change()
      await router.invalidate()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

// A day as counted from today: today, tomorrow, yesterday, a weekday in the coming week, days ago
// in the past one, else the date. A time on it stays.
export function relDay(when: string, today: string): string {
  const day = dayOf(when)
  const n = daysBetween(today, day)
  const date = new Date(`${day}T12:00`)
  const name =
    n === 0
      ? 'today'
      : n === 1
        ? 'tomorrow'
        : n === -1
          ? 'yesterday'
          : n > 0 && n < 7
            ? date.toLocaleDateString('en-US', { weekday: 'short' })
            : n < 0 && n > -7
              ? `${-n}d ago`
              : date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' as const }),
                })
  const time = when.slice(11, 16)
  return time === '' ? name : `${name} ${time}`
}

// What `nod todo` shows beside a title, and what kind of thing each is, for its look: where it
// belongs, a date, a date that has come, or the rest. Today's focus shows as the row's star.
export type Tag = { text: string; kind: 'place' | 'when' | 'due' | 'plain' }

export function todoTags(t: TodoItem, today: string): Tag[] {
  const date = (label: string, when: string): Tag => ({
    text: `${label} ${relDay(when, today)}`,
    kind: dayOf(when) <= today ? 'due' : 'when',
  })
  const tags: (Tag | null)[] = [
    t.context === null ? null : { text: t.context, kind: 'place' },
    t.project === null ? null : { text: t.project, kind: 'place' },
    t.waitingFor === null ? null : { text: `waiting on ${t.waitingFor}`, kind: 'plain' },
    t.scheduled === null ? null : date('on', t.scheduled),
    t.due === null ? null : date('due', t.due),
    t.start === null ? null : { text: `starts ${relDay(t.start, today)}`, kind: 'when' },
    t.repeat === null ? null : { text: `repeats ${t.repeat}`, kind: 'plain' },
    t.status === 'inbox' || t.status === 'waiting'
      ? { text: `since ${relDay(localDay(new Date(t.statusAt)), today)}`, kind: 'plain' }
      : null,
  ]
  return tags.filter((x) => x !== null)
}

// A move that took a todo off its list, offered back for a while: the circle and the status menu
// are one click, and the row is gone once the change lands.
type Undo = { text: string; back: () => Promise<unknown> }

const UndoContext = createContext<(undo: Undo) => void>(() => {})

export function UndoBar({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ key: number; undo: Undo } | null>(null)
  const offer = useCallback((undo: Undo) => setShown({ key: Date.now(), undo }), [])
  const close = useCallback(() => setShown(null), [])
  return (
    <UndoContext.Provider value={offer}>
      {children}
      {shown !== null && <Toast key={shown.key} undo={shown.undo} close={close} />}
    </UndoContext.Provider>
  )
}

function Toast({ undo, close }: { undo: Undo; close: () => void }) {
  const { busy, error, run } = useChange()
  // A failed undo stays until the person has read it.
  useEffect(() => {
    if (error !== null) return
    const timer = setTimeout(close, UNDO_MS)
    return () => clearTimeout(timer)
  }, [error, close])
  return (
    <div className="toast" role="status">
      <span className="toast-text">{error ?? undo.text}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(undo.back).then((ok) => ok && close())}
      >
        Undo
      </button>
    </div>
  )
}

const movedTo = (status: string): string =>
  status === 'done' ? 'Done' : status === 'dropped' ? 'Dropped' : `Moved to ${status}`

// A todo on one line, as in Mindwtr: the circle finishes it, the title opens it, the star picks it
// for the day's focus, and the status menu moves it. A next action that has started can be picked
// unless the focus is `full`; one already picked can always be let go. The menu shows when the
// todo's status is not the list's `usual` one, and otherwise waits for the pointer.
export function TodoRow({
  t,
  today,
  usual,
  full = false,
}: {
  t: TodoItem
  today: string
  usual: string
  full?: boolean
}) {
  const { busy, error, run } = useChange()
  const offer = useContext(UndoContext)
  const focus = (day: string) =>
    void run(() => changeTodo({ data: { id: t.id, edit: { focus: day } } }))
  const move = (status: string) => {
    const edit = (to: string) => changeTodo({ data: { id: t.id, edit: { status: to } } })
    const was = t.status
    void run(() => edit(status)).then((ok) => {
      // ponytail: a repeating todo done has made its next one, which putting it back would leave.
      if (ok && !(status === 'done' && t.repeat !== null)) {
        offer({ text: `${movedTo(status)}: ${t.title}`, back: () => edit(was) })
      }
    })
  }
  const focused = t.focus === today
  const pickable = t.status === 'next' && (t.start === null || t.start <= today) && !full
  return (
    <div className={focused ? 'todo-item focused' : 'todo-item'}>
      <button
        type="button"
        className="check"
        aria-label="Done"
        title="Done"
        disabled={busy}
        onClick={() => move('done')}
      />
      <div className="todo-main">
        <Link to="/todos/$id" params={{ id: String(t.id) }} className="todo-title">
          {t.title}
        </Link>
        <div className="todo-tags">
          <span className="side-id">t{t.id}</span>
          {todoTags(t, today).map((tag) => (
            <span key={tag.text} className={`tag ${tag.kind}`}>
              {tag.text}
            </span>
          ))}
          <select
            aria-label="Status"
            className={`status-pill ${t.status}${t.status === usual ? ' quiet' : ''}`}
            value={t.status}
            disabled={busy}
            onChange={(e) => move(e.target.value)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {error !== null && <div className="banner">{error}</div>}
      </div>
      {(focused || pickable) && (
        <button
          type="button"
          className={focused ? 'star on' : 'star'}
          aria-label={focused ? 'Unfocus' : 'Focus today'}
          title={focused ? 'Unfocus' : 'Focus today'}
          disabled={busy}
          onClick={() => focus(focused ? '' : today)}
        >
          {focused ? '★' : '☆'}
        </button>
      )}
    </div>
  )
}

// A titled list. Rows sit on one card; `bare` leaves the children as they are (cards of their own,
// or a line saying the list is empty).
export function Section({
  title,
  count,
  bare = false,
  children,
}: {
  title: string
  count?: string | number
  bare?: boolean
  children: ReactNode
}) {
  return (
    <>
      <h2 className="section">
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {bare ? children : <div className="list">{children}</div>}
    </>
  )
}
