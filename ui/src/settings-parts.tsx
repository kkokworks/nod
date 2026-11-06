import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { SessionRow } from './nod.server'
import { localTime } from './parts'
import { Section } from './todo-parts'

// What nod is set to, a page for each kind, with the links between them. Shown only: nod's commands
// change it.
export function SettingsPage({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <h1 className="title">Settings</h1>
      <nav className="tags">
        <Link to="/settings/rules" className="tag">
          Rules
        </Link>
        <Link to="/settings/orchestrators" className="tag">
          Orchestrators
        </Link>
        <Link to="/settings/relays" className="tag">
          Relays
        </Link>
      </nav>
      {children}
    </div>
  )
}

// A role's Settings page: what it shows (`children`), then a row for each name. `of`: the role.
export function SessionRows({
  of: role,
  title,
  rows,
  children,
}: {
  of: string
  title: string
  rows: SessionRow[]
  children: ReactNode
}) {
  return (
    <SettingsPage>
      <p className="subtitle">{children}</p>
      <Section title={title} count={rows.length} bare={rows.length === 0}>
        {rows.length === 0 ? (
          <p className="muted">
            No {role} sessions yet. <code>nod open &lt;name&gt; --role {role}</code> opens one, and{' '}
            <code>nod session claim &lt;name&gt; --role {role}</code> gives the role to a session
            already running.
          </p>
        ) : (
          rows.map((s) => <Row key={s.name} s={s} />)
        )}
      </Section>
    </SettingsPage>
  )
}

function Row({ s }: { s: SessionRow }) {
  return (
    <div className="todo-row">
      <div className="todo-line">
        <span className="todo-title">{s.name}</span>
      </div>
      <div className="todo-tags">
        <span className={s.on ? 'chip running' : 'chip'}>{s.on ? 'on' : 'off'}</span>
        <span className="tag">{s.cwd}</span>
        <span>created {localTime(s.createdAt)}</span>
      </div>
      {s.projects !== undefined && (
        <div className="todo-tags">
          {s.projects.length === 0 ? (
            <span>no projects</span>
          ) : (
            s.projects.map((p) => (
              <Link key={p.id} to="/projects" hash={`p${p.id}`} className="tag">
                p{p.id} {p.title}
                {p.status !== 'active' && ` (${p.status})`}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}
