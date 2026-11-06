import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { orchestrators } from '../nod.server'
import { keep } from '../parts'
import { SessionRows } from '../settings-parts'

const getOrchestrators = createServerFn({ method: 'GET' }).handler(() => orchestrators())

export const Route = createFileRoute('/settings/orchestrators')({
  loader: (ctx) => keep(ctx, () => getOrchestrators()),
  component: OrchestratorsPage,
})

function OrchestratorsPage() {
  return (
    <SessionRows of="orchestrator" title="Orchestrators" rows={Route.useLoaderData()}>
      Each name by its latest session, with the projects it is in charge of. To change those, use{' '}
      <code>nod project set --orchestrator</code>.
    </SessionRows>
  )
}
