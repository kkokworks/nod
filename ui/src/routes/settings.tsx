import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

// What nod is set to, a page for each kind. Shown only: nod's commands change it. The links are
// here, not on each page, so that going from page to page leaves the one followed in place, with
// the focus on it.
function SettingsPage() {
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
      <Outlet />
    </div>
  )
}
