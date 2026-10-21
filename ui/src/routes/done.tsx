import { createFileRoute } from '@tanstack/react-router'
import { getDone } from '../todo-fns'
import { Section, TodoRow } from '../todo-parts'

export const Route = createFileRoute('/done')({
  loader: () => getDone(),
  component: DoneView,
})

// Mindwtr's Done: the todos finished or dropped, the latest first. Each one's status menu moves it back.
function DoneView() {
  const d = Route.useLoaderData()
  return (
    <div className="page">
      <h1 className="title">Done</h1>
      <p className="subtitle">The latest first. Move one back with its status menu.</p>
      <Section title="Done" count={d.done.length} bare={d.done.length === 0}>
        {d.done.length === 0 ? (
          <p className="muted">Nothing done yet.</p>
        ) : (
          d.done.map((t) => <TodoRow key={t.id} t={t} today={d.today} usual="done" />)
        )}
      </Section>
      <Section title="Dropped" count={d.dropped.length} bare={d.dropped.length === 0}>
        {d.dropped.length === 0 ? (
          <p className="muted">Nothing dropped.</p>
        ) : (
          d.dropped.map((t) => <TodoRow key={t.id} t={t} today={d.today} usual="dropped" />)
        )}
      </Section>
    </div>
  )
}
