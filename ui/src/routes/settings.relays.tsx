import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { relays } from '../nod.server'
import { keep } from '../parts'
import { SessionRows } from '../session-rows'

const getRelays = createServerFn({ method: 'GET' }).handler(() => relays())

export const Route = createFileRoute('/settings/relays')({
  loader: (ctx) => keep(ctx, () => getRelays()),
  component: RelaysPage,
})

function RelaysPage() {
  return (
    <SessionRows of="relay" title="Relays" rows={Route.useLoaderData()}>
      Each name by its latest session. A relay passes what comes from outside to the project session
      it is for.
    </SessionRows>
  )
}
