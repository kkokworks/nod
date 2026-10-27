import { createRouter } from '@tanstack/react-router'
import { Failed, NotFound } from './parts'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // As defaults, not the root's own: each page's error then shows in the root's outlet, beside the
  // sidebar, where the root's would take the whole window.
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: Failed,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
