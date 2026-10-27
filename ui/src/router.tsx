import { createRouter } from '@tanstack/react-router'
import { Failed, NotFound } from './parts'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  // As defaults, so each page has its own: its error then shows in the root's outlet, its sidebar
  // with all its lists beside it. Without one it would reach a boundary above the root.
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
