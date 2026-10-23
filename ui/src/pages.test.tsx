import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AnyRoute } from '@tanstack/react-router'
import { tempDirs } from '../../test/tmp'

// The real pages and rows, in a DOM, under a router; the server functions are answered here.
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
process.env.NOD_HOME = tmp.make('nod-ui-pages-')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const R = await import('@tanstack/react-router')
const tasks = await import('./routes/tasks.$id')
const todos = await import('./routes/todos_.$id')
const { TodoRow } = await import('./todo-parts')
if (before === undefined) delete process.env.NOD_HOME
else process.env.NOD_HOME = before

const root = R.createRootRoute() as unknown as AnyRoute
// A list of todo rows, as the list pages show them.
let rows: ReturnType<typeof todoItem>[] = []
const rowsRoute = R.createRoute({
  getParentRoute: () => root,
  path: '/rows',
  loader: () => rows,
  component: function Rows() {
    return (rowsRoute.useLoaderData() as typeof rows).map((t) => (
      <TodoRow key={t.id} t={t as never} today="2026-10-23" usual="next" />
    ))
  },
})
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
    rowsRoute,
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
// A test that moved the clock puts it back, even when it fails.
afterEach(() => setSystemTime())
afterAll(async () => {
  act(() => view.unmount())
  await GlobalRegistrator.unregister()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: undefined })
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
async function press(code: string, key: string) {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { code, key, bubbles: true }),
    )
  })
  await settle()
}
const banners = () => [...document.querySelectorAll('.banner')].map((b) => b.textContent)

const AT = '2026-10-23T09:00:00.000Z'

const todoItem = (id: number, title: string) => ({
  id,
  title,
  notes: 'first',
  status: 'next',
  projectId: null,
  context: null as string | null,
  waitingOn: null,
  due: null,
  scheduled: null,
  start: null,
  repeat: null,
  focus: null,
  watch: null,
  backTo: null,
  source: 'cli',
  sourceKey: null,
  createdAt: AT,
  statusAt: AT,
  project: null,
  waitingFor: null,
})

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
  setSystemTime(new Date(Date.now() + 1500))
  await click('Yes')
  expect(posted.splice(0)).toEqual([{ taskId: 5, decisionId: 8, text: 'yes' }])
  expect(field<HTMLTextAreaElement>('textarea').value).toBe('half a thought')
})

test('a button does not answer a decision that just took the place of another', async () => {
  answer = (id) => detail(id as number)
  open[6] = { id: 10, reason: 'permission' }
  await go('/tasks/6')
  // The answer is taken, and the worker asks the next just as the person clicks again.
  onPost = () => {
    open[6] = { id: 11, reason: 'permission' }
  }
  await click('Yes')
  await click('Yes')
  expect(posted.splice(0)).toEqual([{ taskId: 6, decisionId: 10, text: 'yes' }])
  expect(banners().join()).toContain('#11')
  // A moment on, the person has seen it.
  setSystemTime(new Date(Date.now() + 1500))
  await click('Yes')
  expect(posted.splice(0)).toEqual([{ taskId: 6, decisionId: 11, text: 'yes' }])
})

test('a change to the todo keeps what is being typed in the form and says so', async () => {
  let todo = todoItem(9, 'old title')
  const changes = [{ actor: 'human', at: AT, text: 'captured' }]
  answer = () => ({ today: '2026-10-23', todo, links: [], tasks: [], changes, projects: [] })
  await go('/todos/9?edit=true')
  const title = () => field<HTMLInputElement>('.todo-form input').value
  type(field('.todo-form input'), 'new title')
  expect(banners()).toEqual([])

  // A worker sets the context.
  todo = { ...todo, context: '@desk' }
  changes.push({ actor: 'worker:1', at: AT, text: 'context @desk' })
  await reload()
  expect(title()).toBe('new title')
  expect(field<HTMLInputElement>('input[placeholder="@desk"]').value).toBe('@desk')
  expect(banners().join()).toContain('changed')

  // A line added to the notes shows in them, and the title stays.
  onPost = () => {
    todo = { ...todo, notes: 'first\nsecond' }
    changes.push({ actor: 'human:ui', at: AT, text: 'notes' })
  }
  type(field('input[placeholder="Add a line to the notes…"]'), 'second')
  await click('Add')
  expect(posted.splice(0)).toEqual([{ id: 9, edit: { addNote: 'second' } }])
  expect(field<HTMLTextAreaElement>('.todo-form textarea').value).toBe('first\nsecond')
  expect(title()).toBe('new title')
  onPost = () => {}

  await click('Save')
  expect(posted.splice(0)).toMatchObject([
    { id: 9, edit: { title: 'new title', context: '@desk', notes: 'first\nsecond' } },
  ])
})

test('a key pressed as the refresh takes its row away does not act on the next row', async () => {
  rows = [todoItem(1, 'one'), todoItem(2, 'two'), todoItem(3, 'three')]
  await go('/rows')
  const focused = () => document.activeElement?.textContent
  act(() => [...document.querySelectorAll<HTMLElement>('.todo-title')][0]?.focus())
  expect(focused()).toBe('one')

  // The CLI finishes the todo being read, and the refresh hands its focus to the next row.
  rows = rows.slice(1)
  await reload()
  expect(focused()).toBe('two')
  await press('KeyX', 'x')
  await press('KeyS', 's')
  expect(posted).toEqual([])
  // `s` would have opened the status menu and focused its current status.
  expect(focused()).toBe('two')

  // A moment on, the keys are for the row in front of the person.
  setSystemTime(new Date(Date.now() + 1500))
  onPost = () => {
    rows = rows.slice(1)
  }
  await press('KeyX', 'x')
  expect(posted.splice(0)).toEqual([{ id: 2, edit: { status: 'done' } }])
  // Its own row gone, the next takes keys at once.
  expect(focused()).toBe('three')
  await press('KeyX', 'x')
  expect(posted.splice(0)).toEqual([{ id: 3, edit: { status: 'done' } }])
})
