import { createFileRoute, redirect } from '@tanstack/react-router'

// The sidebar's link: Settings opens on its first page.
export const Route = createFileRoute('/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/rules' })
  },
})
