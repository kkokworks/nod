import { createFileRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

// What nod is set to, a page for each kind. Shown only: nod's commands change it.
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
