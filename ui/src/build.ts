// Which build of the UI this is, the same in a page and in the server built with it; '' where Vite
// did not build it (the tests). A page from another build than the server's loads itself again
// (routes/__root.tsx).
declare const __NOD_BUILD__: string
export const BUILD = typeof __NOD_BUILD__ === 'string' ? __NOD_BUILD__ : ''
