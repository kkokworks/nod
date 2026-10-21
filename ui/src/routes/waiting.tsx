import { createFileRoute } from '@tanstack/react-router'
import { getLists } from '../todo-fns'
import { Section, TodoRow } from '../todo-parts'

export const Route = createFileRoute('/waiting')({
  loader: () => getLists(),
  component: WaitingPage,
})

// Mindwtr's Waiting For: what others owe the person, each with whom and since when.
function WaitingPage() {
  const l = Route.useLoaderData()
  return (
    <div className="page">
      <h1 className="title">Waiting For</h1>
      <p className="subtitle">{l.waiting.length} waited on</p>
      <Section title="Waiting" count={l.waiting.length} bare={l.waiting.length === 0}>
        {l.waiting.length === 0 ? (
          <p className="muted">Nothing waited on.</p>
        ) : (
          l.waiting.map((t) => <TodoRow key={t.id} t={t} today={l.today} usual="waiting" />)
        )}
      </Section>
    </div>
  )
}
