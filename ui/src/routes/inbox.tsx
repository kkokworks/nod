import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { keep } from '../parts'
import { captureTodo, getLists } from '../todo-fns'
import { Section, TodoRow, useChange } from '../todo-parts'

export const Route = createFileRoute('/inbox')({
  loader: (ctx) => keep(ctx, () => getLists()),
  component: InboxPage,
})

// Mindwtr's Inbox: capture, and the todos still to clarify. Next actions and reference are on
// Focus, decisions on the home page, Waiting For and Someday/Maybe on pages of their own.
function InboxPage() {
  const l = Route.useLoaderData()
  return (
    <div className="page">
      <h1 className="title">Inbox</h1>
      <p className="subtitle">{l.inbox.length} to clarify</p>
      <Capture />
      <Section title="Inbox" count={l.inbox.length} bare={l.inbox.length === 0}>
        {l.inbox.length === 0 && <p className="muted">Empty.</p>}
        {l.inbox.map((t) => (
          <TodoRow key={t.id} t={t} today={l.today} usual="inbox" />
        ))}
      </Section>
    </div>
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
