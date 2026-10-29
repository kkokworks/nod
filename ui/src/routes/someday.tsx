import { createFileRoute } from '@tanstack/react-router'
import { keep } from '../parts'
import { getLists } from '../todo-fns'
import { Section, TodoRow } from '../todo-parts'

export const Route = createFileRoute('/someday')({
  loader: (ctx) => keep(ctx, () => getLists()),
  component: SomedayPage,
})

// Mindwtr's Someday/Maybe: what might be done one day, looked over in the weekly review.
// Someday projects stay on the Projects page.
function SomedayPage() {
  const l = Route.useLoaderData()
  return (
    <div className="page">
      <h1 className="title">Someday/Maybe</h1>
      <p className="subtitle">Looked over in the weekly review.</p>
      <Section title="Someday" count={l.someday.length} bare={l.someday.length === 0}>
        {l.someday.length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          l.someday.map((t) => <TodoRow key={t.id} t={t} today={l.today} usual="someday" />)
        )}
      </Section>
    </div>
  )
}
