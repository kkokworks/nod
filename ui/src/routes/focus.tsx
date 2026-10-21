import { createFileRoute } from '@tanstack/react-router'
import { getFocus } from '../todo-fns'
import { done, type Edits, focusToggle, Section, TodoRow } from '../todo-parts'
import type { TodoItem } from '../todos.server'

export const Route = createFileRoute('/focus')({
  loader: () => getFocus(),
  component: FocusPage,
})

// Mindwtr's Focus: the few todos picked for today, what the day holds, the next actions to pick
// from, and those that start later.
function FocusPage() {
  const page = Route.useLoaderData()
  const full = page.focus.length >= page.limit
  // A full focus offers no more picks; unfocusing one makes room.
  const actions = (t: TodoItem): Edits =>
    full && t.focus !== page.today ? [done] : [focusToggle(t, page.today), done]
  const rows = (ts: TodoItem[], edits: (t: TodoItem) => Edits) =>
    ts.map((t) => <TodoRow key={t.id} t={t} today={page.today} actions={edits(t)} />)
  return (
    <div className="page">
      <h1 className="title">Focus</h1>

      <Section title={`Today's focus ${page.focus.length}/${page.limit}`}>
        {page.focus.length === 0 ? (
          <p className="muted">Nothing picked yet. Pick up to {page.limit} from below.</p>
        ) : (
          rows(page.focus, actions)
        )}
        {full && <p className="muted">Full. Unfocus one to pick another.</p>}
      </Section>

      {page.day.length > 0 && <Section title="Today">{rows(page.day, actions)}</Section>}

      <Section title="Next actions">
        {page.next.length === 0 ? <p className="muted">None.</p> : rows(page.next, actions)}
      </Section>

      {page.upcoming.length > 0 && (
        <Section title="Upcoming">{rows(page.upcoming, () => [done])}</Section>
      )}
    </div>
  )
}
