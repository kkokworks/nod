import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AnyRoute } from '@tanstack/react-router'
import { tempDirs } from '../../test/tmp'

// The forms on the real pages, in a DOM, under a router; the server functions are answered here.
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// What a GET answers, what a POST does to it, and the POSTs sent.
let answer: (data: unknown) => unknown = () => undefined
let onPost: (data: unknown) => void = () => {}
const posted: unknown[] = []
mock.module('@tanstack/react-start', () => ({
  createServerFn: ({ method }: { method: 'GET' | 'POST' }) => {
    const fn = {
      validator: () => fn,
      handler:
        () =>
        async ({ data }: { data: unknown }) => {
          if (method === 'GET') return answer(data)
          posted.push(data)
          onPost(data)
        },
    }
    return fn
  },
}))

// The pages reach the ledger as they load, so they load at an empty home. Test files share the
// loaded server module, and another may use this home's ledger after this file is done, so the
// home goes when the run does.
const tmp = tempDirs()
process.on('exit', tmp.removeAll)
const before = process.env.NOD_HOME
process.env.NOD_HOME = tmp.make('nod-ui-forms-')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const R = await import('@tanstack/react-router')
const tasks = await import('./routes/tasks.$id')
const todos = await import('./routes/todos_.$id')
if (before === undefined) delete process.env.NOD_HOME
else process.env.NOD_HOME = before

const root = R.createRootRoute() as unknown as AnyRoute
const router = R.createRouter({
  routeTree: root.addChildren([
    tasks.Route.update({
      id: '/tasks/$id',
      path: '/tasks/$id',
      getParentRoute: () => root,
    } as never),
    todos.Route.update({
      id: '/todos_/$id',
      path: '/todos/$id',
      getParentRoute: () => root,
    } as never),
  ]),
  history: R.createMemoryHistory({ initialEntries: ['/'] }),
  defaultNotFoundComponent: () => null,
})
const view = createRoot(document.body.appendChild(document.createElement('div')))
await act(async () => view.render(<R.RouterProvider router={router as never} />))

beforeEach(() => {
  posted.length = 0
  onPost = () => {}
})
afterAll(async () => {
  act(() => view.unmount())
  await GlobalRegistrator.unregister()
})

// Lets the sends and reloads a click started finish.
const settle = () => act(() => new Promise((done) => setTimeout(done, 20)))
const go = async (href: string) => {
  await act(() => router.navigate({ href }))
  await settle()
}
// The page's 5 second reload.
const reload = async () => {
  await act(() => router.invalidate())
  await settle()
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(selector: string): T {
  const el = document.querySelector(selector)
  if (el === null) throw new Error(`no ${selector}`)
  return el as T
}
// As typing does: React sees the change only through the element's own setter and an input event.
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === text)
  if (button === undefined) throw new Error(`no ${text} button`)
  act(() => button.click())
  await settle()
}
async function submit(selector: string) {
  act(() => {
    field(selector).form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}
const banners = () => [...document.querySelectorAll('.banner')].map((b) => b.textContent)

const AT = '2026-10-23T09:00:00.000Z'

// The task pages: tasks 3 to 5, each with the decision open on it, if any.
const open: Record<number, { id: number; reason: string } | undefined> = {}
const detail = (id: number) => ({
  task: {
    id,
    brief: `task ${id}`,
    collectedAt: null,
    createdAt: AT,
    finishedAt: null,
    issue: null,
    repo: null,
    branch: null,
    checkCmd: null,
    triggerId: null,
    rootSession: null,
    error: null,
  },
  status: 'running',
  links: [],
  after: [],
  attempts: [{ id: 1, kind: 'start', outcome: null, startedAt: AT, finishedAt: null }],
  decisions: [open[id]]
    .filter((d) => d !== undefined)
    .map((d) => ({ ...d, taskId: id, attemptId: 1, question: 'ok?', answer: null, createdAt: AT })),
  report: null,
  place: { todo: null, project: null },
  retro: null,
  screen: 'working',
})

test('what is written to one task does not go to another', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/3')
  type(field('textarea'), 'for three')
  await go('/tasks/4')
  expect(field<HTMLTextAreaElement>('textarea').value).toBe('')
  type(field('textarea'), 'for four')
  await submit('textarea')
  expect(posted.splice(0)).toEqual([{ taskId: 4, decisionId: null, text: 'for four' }])
})

test('a message does not answer a decision that opened while it was written', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/4')
  type(field('textarea'), 'carry on')
  open[4] = { id: 7, reason: 'question' }
  await reload()
  await submit('textarea')
  expect(posted).toEqual([])
  expect(banners().join()).toContain('#7')
  expect(field<HTMLTextAreaElement>('textarea').value).toBe('carry on')
  // Sent again, having seen it, it answers the decision.
  await submit('textarea')
  expect(posted.splice(0)).toEqual([{ taskId: 4, decisionId: 7, text: 'carry on' }])

  // And an answer to a decision that closed meanwhile does not become a message.
  type(field('textarea'), 'use the first')
  open[4] = undefined
  await reload()
  await submit('textarea')
  expect(posted).toEqual([])
  expect(banners().join()).toContain('#7')
})

test('answering with a button keeps what was being written', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/5')
  type(field('textarea'), 'half a thought')
  open[5] = { id: 8, reason: 'permission' }
  onPost = () => {
    open[5] = undefined
  }
  await reload()
  await click('Yes')
  expect(posted.splice(0)).toEqual([{ taskId: 5, decisionId: 8, text: 'yes' }])
  expect(field<HTMLTextAreaElement>('textarea').value).toBe('half a thought')
})
