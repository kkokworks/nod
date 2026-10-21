import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { captureTodo, getLists } from '../todo-fns'
import { done, focusToggle, Section, TodoRow, useChange } from '../todo-parts'
import type { TodoItem } from '../todos.server'

export const Route = createFileRoute('/todos')({
  loader: () => getLists(),
  component: TodosPage,
})

// The lists GTD works from, as `nod todo` shows them: decisions first, then the inbox to clarify,
// the next actions, and what is waited on.
function TodosPage() {
  const l = Route.useLoaderData()
  const [context, setContext] = useState<string | null>(null)
  // A next action with no context can be done anywhere, so it shows in every context.
  const next = l.next.filter((t) => context === null || t.context === null || t.context === context)
  return (
    <div className="page">
      <h1 className="title">Todos</h1>
      <p className="subtitle">
        {l.inbox.length} in the inbox · {l.next.length} next · {l.waiting.length} waiting
      </p>
      <Capture />

      {l.decisions.length > 0 && (
        <Section title={`Decide (${l.decisions.length})`}>
          {l.decisions.map((d) => (
            <div key={d.id} className="todo-row">
              <div className="todo-line">
                <Link to="/tasks/$id" params={{ id: String(d.taskId) }} className="todo-title">
                  {d.title}
                </Link>
              </div>
              <div className="todo-tags">
                <span className="side-id">#{d.id}</span>
                <span>{d.reason.replace('_', ' ')}</span>
                <span>task #{d.taskId}</span>
                {d.project !== null && <span>{d.project}</span>}
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section title={`Inbox (${l.inbox.length})`}>
        {l.inbox.length === 0 && <p className="muted">Empty.</p>}
        {l.inbox.map((t) => (
          <TodoRow
            key={t.id}
            t={t}
            today={l.today}
            actions={[
              ['Next', { status: 'next' }],
              ['Someday', { status: 'someday' }],
              ['Reference', { status: 'reference' }],
              done,
              ['Drop', { status: 'dropped' }],
            ]}
          />
        ))}
      </Section>

      <Section title={`Next (${l.next.length})`}>
        {l.contexts.length > 0 && (
          <div className="filters">
            {[null, ...l.contexts].map((c) => (
              <button
                key={c ?? ''}
                type="button"
                className={context === c ? 'on' : ''}
                onClick={() => setContext(c)}
              >
                {c ?? 'Anywhere'}
              </button>
            ))}
          </div>
        )}
        {next.map((t) => (
          <TodoRow key={t.id} t={t} today={l.today} actions={[focusToggle(t, l.today), done]} />
        ))}
      </Section>

      <Section title={`Waiting (${l.waiting.length})`}>
        {l.waiting.map((t) => (
          <TodoRow key={t.id} t={t} today={l.today} actions={[done]} />
        ))}
      </Section>

      <Fold name="Someday" ts={l.someday} today={l.today} />
      <Fold name="Reference" ts={l.reference} today={l.today} />
    </div>
  )
}

// Someday and reference are reviewed weekly, not worked from, so they stay folded.
function Fold({ name, ts, today }: { name: string; ts: TodoItem[]; today: string }) {
  if (ts.length === 0) return null
  return (
    <details className="fold">
      <summary className="section fold-label">
        {name} ({ts.length})
      </summary>
      {ts.map((t) => (
        <TodoRow key={t.id} t={t} today={today} actions={[['Next', { status: 'next' }]]} />
      ))}
    </details>
  )
}

// Capture asks for nothing but the words, as `nod in`.
function Capture() {
  const [title, setTitle] = useState('')
  const { busy, error, run } = useChange()
  return (
    <form
      className="composer capture"
      onSubmit={(e) => {
        e.preventDefault()
        const words = title.trim()
        if (words === '') return
        void run(() => captureTodo({ data: words })).then((ok) => ok && setTitle(''))
      }}
    >
      <input
        value={title}
        placeholder="Capture a todo…"
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy || title.trim() === ''}>
        Capture
      </button>
      {error !== null && <div className="banner">{error}</div>}
    </form>
  )
}
