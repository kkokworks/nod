import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { RawEdit } from '../input'
import { localTime, Url } from '../parts'
import { changeTodo, getTodo } from '../todo-fns'
import {
  MoreMenu,
  STATUSES,
  StatusSelect,
  TodoFacts,
  todoTags,
  useChange,
  useTodoActions,
} from '../todo-parts'
import type { TodoPage } from '../todos.server'

export const Route = createFileRoute('/todos_/$id')({
  // The page shows the todo; `?edit=true`, from its "…" menu, shows the form instead.
  validateSearch: (s: Record<string, unknown>): { edit?: true } =>
    s.edit === true ? { edit: true } : {},
  loader: ({ params }) => getTodo({ data: Number(params.id) }),
  component: TodoDetail,
})

// The ledger's repeats (days.ts), which the browser cannot import: it reaches the database.
const REPEATS = ['', 'daily', 'weekly', 'monthly']

function TodoDetail() {
  const page = Route.useLoaderData()
  const { edit } = Route.useSearch()
  const { todo } = page
  const { busy, error, items, move } = useTodoActions(todo, page.today, false)
  return (
    <div className="page">
      <div className="task-meta">
        <StatusSelect status={todo.status} disabled={busy} onChange={move} />
        <span className="muted">
          t{todo.id} · from {todo.source}
          {todo.sourceKey !== null && ` ${todo.sourceKey}`} · {localTime(todo.createdAt)}
        </span>
        <span className="todo-page-menu">
          <MoreMenu items={items.filter((i) => !(edit && i.label === 'Edit'))} disabled={busy} />
        </span>
      </div>
      <h1 className="title task-title">{todo.title}</h1>
      <div className="tags">
        {todoTags(todo, page.today).map((tag) => (
          <span key={tag.text} className={`tag ${tag.kind}`}>
            {tag.text}
          </span>
        ))}
      </div>

      {error !== null && <div className="banner">{error}</div>}
      {edit ? <EditForm page={page} /> : <TodoFacts t={todo} />}

      {page.links.length > 0 && (
        <>
          <h2 className="section">Links</h2>
          {page.links.map((l) => (
            <div key={l.url} className="link">
              <Url url={l.url} />
              {l.title !== null && <span className="muted"> {l.title}</span>}
            </div>
          ))}
        </>
      )}

      {page.tasks.length > 0 && (
        <>
          <h2 className="section">Delegated to</h2>
          {page.tasks.map(({ task, summary, links }) => (
            <div key={task.id} className="todo-row">
              <div className="todo-line">
                <Link to="/tasks/$id" params={{ id: String(task.id) }} className="todo-title">
                  task #{task.id}
                </Link>
                <span className="muted">{task.status}</span>
              </div>
              {summary !== null && <div className="todo-tags">{summary}</div>}
              {links.map((url) => (
                <div key={url} className="link">
                  <Url url={url} />
                </div>
              ))}
            </div>
          ))}
        </>
      )}

      <h2 className="section">Changes</h2>
      {page.changes.map((c) => (
        <div key={`${c.at}${c.text}`} className="change">
          <span className="muted">{localTime(c.at)}</span> <span className="tag">{c.actor}</span>{' '}
          {c.text}
        </div>
      ))}
    </div>
  )
}

// `YYYY-MM-DD HH:MM` in the ledger; a date and a time field here.
const datePart = (when: string | null) => when?.slice(0, 10) ?? ''
const timePart = (when: string | null) => when?.slice(11, 16) ?? ''
const join = (date: string, time: string) =>
  date === '' ? '' : time === '' ? date : `${date} ${time}`

// Every field at once, as `nod todo set` takes them; the ledger records only what changed.
function EditForm({ page }: { page: TodoPage }) {
  const { todo } = page
  const held = {
    title: todo.title,
    status: todo.status,
    projectId: todo.projectId === null ? '' : String(todo.projectId),
    context: todo.context ?? '',
    waitingOn: todo.waitingOn ?? '',
    dueDate: datePart(todo.due),
    dueTime: timePart(todo.due),
    onDate: datePart(todo.scheduled),
    onTime: timePart(todo.scheduled),
    start: todo.start ?? '',
    repeat: todo.repeat ?? '',
    focus: todo.focus ?? '',
    notes: todo.notes ?? '',
  }
  // Only the fields the person changed, over what the ledger holds now: a change from elsewhere,
  // or a line added below, shows in the others and leaves what is being typed alone.
  const [typed, setTyped] = useState<Partial<typeof held>>({})
  const f = { ...held, ...typed }
  // How many changes the ledger had when the person began, to say when it changed under them.
  const [began, setBegan] = useState(page.changes.length)
  const [note, setNote] = useState('')
  const { busy, error, run } = useChange()
  const navigate = useNavigate()
  const done = () => navigate({ to: '/todos/$id', params: { id: String(todo.id) }, search: {} })
  const set = (field: keyof typeof f) => (e: { target: { value: string } }) => {
    if (Object.keys(typed).length === 0) setBegan(page.changes.length)
    setTyped({ ...typed, [field]: e.target.value })
  }
  const save = (edit: RawEdit) => run(() => changeTodo({ data: { id: todo.id, edit } }))
  const all: RawEdit = {
    title: f.title,
    status: f.status,
    projectId: f.projectId === '' ? null : Number(f.projectId),
    context: f.context,
    waitingOn: f.waitingOn,
    due: join(f.dueDate, f.dueTime),
    scheduled: join(f.onDate, f.onTime),
    start: f.start,
    repeat: f.repeat,
    focus: f.focus,
    notes: f.notes,
  }
  return (
    <form
      className="composer todo-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save(all).then((ok) => {
          if (ok) void done()
        })
      }}
    >
      {Object.keys(typed).length > 0 && page.changes.length !== began && (
        <div className="banner wide">
          This todo changed while you were editing; the other fields show it. Save keeps what you
          typed.
        </div>
      )}
      <label className="wide">
        Title
        <input value={f.title} onChange={set('title')} />
      </label>
      <label>
        Status
        <select value={f.status} onChange={set('status')}>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label>
        Project
        <select value={f.projectId} onChange={set('projectId')}>
          <option value="">—</option>
          {page.projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.title}
              {p.status === 'someday' ? ' (someday)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Context
        <input value={f.context} placeholder="@desk" onChange={set('context')} />
      </label>
      <label>
        Waiting on
        <input value={f.waitingOn} placeholder="who" onChange={set('waitingOn')} />
      </label>
      <label>
        Due
        <span className="pair">
          <input type="date" value={f.dueDate} onChange={set('dueDate')} />
          <input type="time" value={f.dueTime} onChange={set('dueTime')} />
        </span>
      </label>
      <label>
        On (day- or time-specific)
        <span className="pair">
          <input type="date" value={f.onDate} onChange={set('onDate')} />
          <input type="time" value={f.onTime} onChange={set('onTime')} />
        </span>
      </label>
      <label>
        Start (hidden until)
        <input type="date" value={f.start} onChange={set('start')} />
      </label>
      <label>
        Repeat
        <select value={f.repeat} onChange={set('repeat')}>
          {REPEATS.map((r) => (
            <option key={r} value={r}>
              {r === '' ? '—' : r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Focus on
        <input type="date" value={f.focus} onChange={set('focus')} />
      </label>
      <label className="wide">
        Notes
        <textarea value={f.notes} rows={4} onChange={set('notes')} />
      </label>
      <div className="composer-actions wide">
        <button type="button" className="secondary" disabled={busy} onClick={() => void done()}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          Save
        </button>
      </div>
      <div className="pair wide">
        <input
          value={note}
          placeholder="Add a line to the notes…"
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || note.trim() === ''}
          onClick={() => void save({ addNote: note }).then((ok) => ok && setNote(''))}
        >
          Add
        </button>
      </div>
      {error !== null && <div className="banner wide">{error}</div>}
    </form>
  )
}
