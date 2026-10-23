import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { rules } from '../nod.server'
import { localTime } from '../parts'
import { Section } from '../todo-parts'

const getRules = createServerFn({ method: 'GET' }).handler(() => rules())

export const Route = createFileRoute('/settings')({
  loader: () => getRules(),
  component: SettingsPage,
})

// What nod is set to. Shown only: `nod rule` changes the rules, and records who did.
function SettingsPage() {
  const rules = Route.useLoaderData()
  return (
    <div className="page">
      <h1 className="title">Settings</h1>
      <p className="subtitle">
        Every worker gets the rules that are on, after nod's built-in ones. To change them, use{' '}
        <code>nod rule</code>.
      </p>
      <Section title="Rules" count={rules.length} bare={rules.length === 0}>
        {rules.length === 0 ? (
          <p className="muted">No rules yet.</p>
        ) : (
          rules.map((r) => (
            <div key={r.id} className={r.state === 'off' ? 'todo-row rule-off' : 'todo-row'}>
              <div className="todo-line">
                <span className="side-id">{r.id}</span>
                <span className="todo-title">{r.text}</span>
              </div>
              <div className="todo-tags">
                <span className="chip">{r.state}</span>
                {r.retroId === null ? (
                  <span>by hand</span>
                ) : r.retroTaskId === null ? (
                  <span>r{r.retroId}</span>
                ) : (
                  <Link to="/tasks/$id" params={{ id: String(r.retroTaskId) }}>
                    r{r.retroId}
                  </Link>
                )}
                {r.edited && <span>edited</span>}
                <span>changed {localTime(r.changedAt)}</span>
              </div>
            </div>
          ))
        )}
      </Section>
    </div>
  )
}
