import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { type ReactNode, useEffect } from 'react'
import type { TaskRow } from '../nod.server'
import { overview } from '../nod.server'
import { statusClass } from '../parts'
import css from '../styles.css?url'

// Workers change the ledger while the page is open, so it reloads its data this often.
const REFRESH_MS = 3000

const getOverview = createServerFn({ method: 'GET' }).handler(() => overview())

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'nod' },
    ],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  loader: () => getOverview(),
  shellComponent: Shell,
  component: Root,
})

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Root() {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => router.invalidate(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [router])
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

function Sidebar() {
  const { decisions, groups, collected, inbox } = Route.useLoaderData()
  const active = groups.reduce((n, g) => n + g.tasks.length, 0)
  return (
    <aside className="sidebar">
      <Link to="/" className="brand">
        nod
      </Link>
      <nav className="side-nav">
        <Link
          to="/today"
          search={{ day: 'today' }}
          className="side-item"
          activeProps={{ className: 'active' }}
        >
          Today
        </Link>
        <Link to="/todos" className="side-item" activeProps={{ className: 'active' }}>
          Todos
          {inbox > 0 && <span className="side-count">{inbox}</span>}
        </Link>
        <Link to="/projects" className="side-item" activeProps={{ className: 'active' }}>
          Projects
        </Link>
      </nav>
      <div className="side-summary">
        <span>{active} tasks</span>
        <span className={decisions.length > 0 ? 'attention' : ''}>
          {decisions.length} to decide
        </span>
      </div>

      {decisions.length > 0 && (
        <div className="side-group">
          <div className="side-label">Waiting for you</div>
          {decisions.map((d) => (
            <Link
              key={d.id}
              to="/tasks/$id"
              params={{ id: String(d.taskId) }}
              className="side-item"
              activeProps={{ className: 'active' }}
            >
              <span className="dot needs_decision" />
              <span className="side-text">
                <span className="side-id">#{d.taskId}</span> {d.reason.replace('_', ' ')}:{' '}
                {d.question}
              </span>
            </Link>
          ))}
        </div>
      )}

      {groups.map((g) => (
        <div key={g.issue ?? ''} className="side-group">
          <div className="side-label">{g.issue ?? 'Tasks'}</div>
          {g.tasks.map((t) => (
            <TaskItem key={t.id} t={t} />
          ))}
        </div>
      ))}

      {collected.length > 0 && (
        <details className="side-group">
          <summary className="side-label">Collected ({collected.length})</summary>
          {collected.map((t) => (
            <TaskItem key={t.id} t={t} />
          ))}
        </details>
      )}

      <div className="side-foot">refreshes every {REFRESH_MS / 1000}s</div>
    </aside>
  )
}

function TaskItem({ t }: { t: TaskRow }) {
  return (
    <Link
      to="/tasks/$id"
      params={{ id: String(t.id) }}
      className="side-item"
      activeProps={{ className: 'active' }}
    >
      <span className={`dot ${statusClass(t.status)}`} title={t.status} />
      <span className="side-text">
        <span className="side-id">#{t.id}</span> {t.note}
      </span>
    </Link>
  )
}
