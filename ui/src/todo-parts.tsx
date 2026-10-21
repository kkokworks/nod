import { Link, useRouter } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import type { RawEdit } from './input'
import { localTime } from './parts'
import { changeTodo } from './todo-fns'
import type { TodoItem } from './todos.server'

// The ledger's statuses (todos.ts), which the browser cannot import: it reaches the database.
export const STATUSES = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'dropped']

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

// What `nod todo` shows beside a title.
export function todoTags(t: TodoItem, today: string): string[] {
  return [
    t.context,
    t.project,
    t.waitingFor === null ? null : `waiting on ${t.waitingFor}`,
    t.scheduled === null ? null : `on ${t.scheduled}`,
    t.due === null ? null : `due ${t.due}`,
    t.start === null ? null : `starts ${t.start}`,
    t.repeat === null ? null : `repeats ${t.repeat}`,
    t.focus === null ? null : t.focus === today ? 'focus today' : `focus ${t.focus}`,
    t.status === 'inbox' || t.status === 'waiting' ? `since ${localTime(t.statusAt)}` : null,
  ].filter((x) => x !== null)
}

// A todo on one line: its title opens it, the status menu and the buttons change it in place.
export function TodoRow({ t, today, actions }: { t: TodoItem; today: string; actions: Edits }) {
  const { busy, error, run } = useChange()
  return (
    <div className="todo-row">
      <div className="todo-line">
        <Link to="/todos/$id" params={{ id: String(t.id) }} className="todo-title">
          {t.title}
        </Link>
        <span className="todo-actions">
          <select
            aria-label="status"
            value={t.status}
            disabled={busy}
            onChange={(e) =>
              void run(() => changeTodo({ data: { id: t.id, edit: { status: e.target.value } } }))
            }
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {actions.map(([label, edit]) => (
            <button
              key={label}
              type="button"
              disabled={busy}
              onClick={() => void run(() => changeTodo({ data: { id: t.id, edit } }))}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="todo-tags">
        <span className="side-id">t{t.id}</span>
        {todoTags(t, today).map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      {error !== null && <div className="banner">{error}</div>}
    </div>
  )
}

// Buttons for a row: a label, and the edit it makes.
export type Edits = [string, RawEdit][]

export const done: [string, RawEdit] = ['Done', { status: 'done' }]
export const focusToggle = (t: TodoItem, today: string): [string, RawEdit] =>
  t.focus === today ? ['Unfocus', { focus: '' }] : ['Focus', { focus: 'today' }]

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="section">{title}</h2>
      {children}
    </>
  )
}
