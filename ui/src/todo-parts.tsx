import { Link, useNavigate, useRouter } from '@tanstack/react-router'
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { dayOf, daysBetween, localDay } from '../../src/days'
import { localTime, Markdown } from './parts'
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

// The lists a todo can be moved to from its menu; done is the circle, dropped its own item.
const MOVES = ['inbox', 'next', 'waiting', 'someday', 'reference']

type MenuItem = { label: string; onSelect: () => void; danger?: boolean }

// What a todo's "…" menu does, as in Mindwtr: edit it, pick it for today or let it go, move it to
// another list, or drop it. A next action that has started can be picked unless the focus is
// `full`; one already picked can always be let go. A move is offered back for a while.
export function useTodoActions(t: TodoItem, today: string, full: boolean) {
  const { busy, error, run } = useChange()
  const offer = useContext(UndoContext)
  const navigate = useNavigate()
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
  const items: MenuItem[] = [
    {
      label: 'Edit',
      onSelect: () =>
        void navigate({ to: '/todos/$id', params: { id: String(t.id) }, search: { edit: true } }),
    },
    ...(focused
      ? [{ label: 'Unfocus', onSelect: () => focus('') }]
      : pickable
        ? [{ label: 'Focus today', onSelect: () => focus(today) }]
        : []),
    ...MOVES.filter((s) => s !== t.status).map((s) => ({
      label: `Move to ${s}`,
      onSelect: () => move(s),
    })),
    ...(t.status === 'dropped'
      ? []
      : [{ label: 'Drop', onSelect: () => move('dropped'), danger: true }]),
  ]
  return { busy, error, items, focused, pickable, focus, move }
}

// The "…" button and its menu. A popover, so a click outside or Escape closes it; it sits under
// the button that opens it (CSS anchor positioning).
export function MoreMenu({ items, disabled }: { items: MenuItem[]; disabled: boolean }) {
  const id = useId()
  const menu = useRef<HTMLDivElement>(null)
  return (
    <>
      <button
        type="button"
        className="more"
        popoverTarget={id}
        aria-label="More"
        title="More"
        disabled={disabled}
      >
        …
      </button>
      <div id={id} ref={menu} popover="auto" className="more-menu" role="menu">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              menu.current?.hidePopover()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  )
}

// What a todo holds beyond its line: its notes, and each date and place in full.
export function TodoFacts({ t }: { t: TodoItem }) {
  const facts: [string, string | null][] = [
    ['Project', t.project],
    ['Context', t.context],
    ['Waiting on', t.waitingFor],
    ['On', t.scheduled],
    ['Due', t.due],
    ['Starts', t.start],
    ['Repeats', t.repeat],
    ['Focus', t.focus],
    [
      'Captured',
      `${localTime(t.createdAt)} from ${t.source}${t.sourceKey === null ? '' : ` ${t.sourceKey}`}`,
    ],
  ]
  return (
    <div className="todo-facts">
      {t.notes === null ? <p className="muted">No notes.</p> : <Markdown text={t.notes} />}
      <dl>
        {facts.map(([name, value]) =>
          value === null ? null : (
            <Fragment key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </Fragment>
          ),
        )}
      </dl>
    </div>
  )
}

// A todo on one line, as in Mindwtr: the circle finishes it, the title unfolds its notes and
// details, the star picks it for the day's focus, and the rest is in the "…" menu. Its status
// shows when it is not the list's `usual` one.
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
  const { busy, error, items, focused, pickable, focus, move } = useTodoActions(t, today, full)
  const [open, setOpen] = useState(false)
  return (
    <div className={`todo-item${focused ? ' focused' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="check"
        aria-label="Done"
        title="Done"
        disabled={busy}
        onClick={() => move('done')}
      />
      <div className="todo-main">
        <button
          type="button"
          className="todo-title"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t.title}
        </button>
        <div className="todo-tags">
          <span className="side-id">t{t.id}</span>
          {todoTags(t, today).map((tag) => (
            <span key={tag.text} className={`tag ${tag.kind}`}>
              {tag.text}
            </span>
          ))}
          {t.status !== usual && <span className={`status-pill ${t.status}`}>{t.status}</span>}
        </div>
        {open && (
          <>
            <TodoFacts t={t} />
            <Link to="/todos/$id" params={{ id: String(t.id) }} className="todo-open">
              Links, tasks and history →
            </Link>
          </>
        )}
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
      <MoreMenu items={items} disabled={busy} />
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
