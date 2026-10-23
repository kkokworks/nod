import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { type ReactNode, type Ref, useEffect, useRef } from 'react'
import { bindKeys, ignoreOnPage, KEYS } from '../keys'
import { overview } from '../nod.server'
import { TaskId, TaskItem } from '../parts'
import css from '../styles.css?url'
import { focusRow, UndoBar } from '../todo-parts'

// Workers change the ledger while the page is open, so it reloads its data this often.
const REFRESH_MS = 5000

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
  const help = useRef<HTMLDivElement>(null)
  useEffect(
    () =>
      bindKeys(
        window,
        { list: () => focusRow(null, 0), help: () => help.current?.togglePopover() },
        ignoreOnPage,
      ),
    [],
  )
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <UndoBar>
          <Outlet />
        </UndoBar>
      </main>
      <KeysHelp ref={help} />
    </div>
  )
}

// Every shortcut, from the list the keys are bound from. `?` or the sidebar's button opens it;
// Escape or a click outside closes it.
function KeysHelp({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <div
      id="keys-help"
      ref={ref}
      popover="auto"
      role="dialog"
      aria-labelledby="keys-help-title"
      className="keys-help"
    >
      <h2 id="keys-help-title" className="section">
        Keyboard shortcuts
      </h2>
      <table>
        <tbody>
          {Object.values(KEYS).map((k) => (
            <tr key={k.does}>
              <td>
                {k.show.map((s) => (
                  <kbd key={s}>{s}</kbd>
                ))}
              </td>
              <td>{k.does}</td>
              <td className="muted">{k.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Line icons for the pages, drawn on a 16-unit grid.
const ICONS = {
  focus: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="2.75" />
    </>
  ),
  inbox: (
    <path d="M2 9h3.5l1 1.5h3l1-1.5H14M3.5 3h9L14 9v3.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V9z" />
  ),
  projects: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  ),
  someday: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </>
  ),
  waiting: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.6 5.75v4.5M9.4 5.75v4.5" />
    </>
  ),
  done: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>
  ),
}

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
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
        <Link to="/focus" className="side-item" activeProps={{ className: 'active' }}>
          <NavIcon name="focus" />
          Focus
        </Link>
        <Link to="/inbox" className="side-item" activeProps={{ className: 'active' }}>
          <NavIcon name="inbox" />
          Inbox
          {inbox > 0 && <span className="side-count">{inbox}</span>}
        </Link>
        {/* Mindwtr's lists, folded away when not wanted. */}
        <details className="side-lists" open>
          <summary className="side-label">Lists</summary>
          <Link to="/projects" className="side-item" activeProps={{ className: 'active' }}>
            <NavIcon name="projects" />
            Projects
          </Link>
          <Link to="/someday" className="side-item" activeProps={{ className: 'active' }}>
            <NavIcon name="someday" />
            Someday/Maybe
          </Link>
          <Link to="/waiting" className="side-item" activeProps={{ className: 'active' }}>
            <NavIcon name="waiting" />
            Waiting For
          </Link>
          <Link to="/done" className="side-item" activeProps={{ className: 'active' }}>
            <NavIcon name="done" />
            Done
          </Link>
        </details>
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
                <TaskId id={d.taskId} todoId={d.todoId} /> {d.reason.replace('_', ' ')}:{' '}
                {d.question}
              </span>
            </Link>
          ))}
        </div>
      )}

      {groups.map((g) => (
        <details key={g.project?.id ?? 0} className="side-group" open>
          <summary className="side-label">{g.project?.title ?? 'No project'}</summary>
          {g.tasks.map((t) => (
            <TaskItem key={t.id} t={t} />
          ))}
        </details>
      ))}

      {collected.total > 0 && (
        <details className="side-group">
          <summary className="side-label">Collected ({collected.total})</summary>
          {collected.items.map((t) => (
            <TaskItem key={t.id} t={t} />
          ))}
          <Link to="/done" hash="collected" className="side-item side-more">
            See all in Done →
          </Link>
        </details>
      )}

      <div className="side-foot">
        <button
          type="button"
          className="keys-button"
          popoverTarget="keys-help"
          aria-keyshortcuts={KEYS.help.aria}
        >
          Keyboard shortcuts <kbd>{KEYS.help.show}</kbd>
        </button>
        refreshes every {REFRESH_MS / 1000}s
      </div>
    </aside>
  )
}
