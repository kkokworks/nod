import { afterAll, afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AnyRoute } from '@tanstack/react-router'
import { tempDirs } from '../../test/tmp'

// The real pages and rows, in a DOM, under a router; the server functions are answered here.
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// What a GET answers, what a POST does to it, and the POSTs sent. Bun keeps a module mock for the
// rest of the run, which can't be undone, so no other test file may import the server functions.
let answer: (data: unknown) => unknown = () => undefined
let onPost: (data: unknown) => void = () => {}
const posted: unknown[] = []
mock.module('@tanstack/react-start', () => ({
  createServerFn: ({ method }: { method: 'GET' | 'POST' }) => {
    const fn = {
      validator: () => fn,
      handler:
        () =>
        async ({ data }: { data?: unknown } = {}) => {
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
const { Search } = await import('./search')
const projects = await import('./routes/projects')
const { Failed, NotFound } = await import('./parts')
const shell = await import('./routes/__root')
if (before === undefined) delete process.env.NOD_HOME
else process.env.NOD_HOME = before

// The pages in a layout, as the real root puts them beside the sidebar. Its loader fails while
// `rootFails` is set, as the real root's does when the sidebar's data does not load, and the real
// root's error component shows then.
let rootFails: Error | null = null
const root = R.createRootRoute({
  loader: () => {
    if (rootFails !== null) throw rootFails
  },
  errorComponent: shell.Route.options.errorComponent,
  component: () => (
    <div className="layout">
      <R.Outlet />
    </div>
  ),
}) as unknown as AnyRoute
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
// The sidebar's search box, on a page of its own.
const findRoute = R.createRoute({ getParentRoute: () => root, path: '/find', component: Search })
const router = R.createRouter({
  routeTree: root.addChildren([
    findRoute,
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
    projects.Route.update({
      id: '/projects',
      path: '/projects',
      getParentRoute: () => root,
    } as never),
    rowsRoute,
  ]),
  history: R.createMemoryHistory({ initialEntries: ['/'] }),
  // As router.tsx has them.
  defaultNotFoundComponent: NotFound,
  defaultErrorComponent: Failed,
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
    workspace: `/work/${id}`,
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
  root: null,
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

test('⌘↵ pressed again before the message is through sends it once', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/7')
  type(field('textarea'), 'hi')
  const send = () =>
    act(() => {
      field('textarea').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      )
    })
  send()
  send()
  await settle()
  expect(posted.splice(0)).toEqual([{ taskId: 7, decisionId: null, text: 'hi' }])
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

test("a task's root shows as its project session, with the command that reopens it, else as the session's ID", async () => {
  const project = { id: 3, title: 'Release', outcome: null, status: 'active', createdAt: AT }
  const rootTag = () =>
    [...document.querySelectorAll('.tag')].find((t) => t.textContent?.startsWith('root'))
  answer = (id) => ({
    ...detail(id as number),
    root: { project, command: 'nod open p3', addedFrom: 'ffff6666' },
  })
  await go('/tasks/8')
  expect(rootTag()?.textContent).toBe('root p3 Release nod open p3')
  expect(rootTag()?.getAttribute('title')).toContain('added from session ffff6666')
  const base = detail(9)
  answer = () => ({ ...base, task: { ...base.task, rootSession: 'ffff6666' } })
  await go('/tasks/9')
  expect(rootTag()?.textContent).toBe('root ffff6666')
})

test('a finished task whose terminal is closed says a message goes on, where one cut off says to resume it', async () => {
  // Task 10 is a retrospective that ended, which takes no message.
  const idle = (id: number, status: string) => {
    const d = detail(id)
    const retro = id === 10 ? { id: 1, ofTaskId: 2, outcome: 'none', rules: [] } : null
    return { ...d, task: { ...d.task, status }, status, retro, screen: null }
  }
  answer = (id) => idle(id as number, id === 9 ? 'running' : 'succeeded')
  const note = () => document.querySelector('.idle-note')?.textContent ?? ''
  await go('/tasks/8')
  expect(note()).toContain('a message goes on in the same conversation')
  expect(note()).not.toContain('nod resume')
  await go('/tasks/9')
  expect(note()).toContain('nod resume 9 reopens it')
  await go('/tasks/10')
  expect(note()).toContain('No live session')
  expect(note()).not.toContain('a message goes on')
})

test('a task that failed before it started has no box to message it, having no conversation', async () => {
  answer = (id) => {
    const d = detail(id as number)
    const failed = { ...d.attempts[0], outcome: 'error', finishedAt: AT }
    const task = { ...d.task, status: 'error', workspace: null, error: 'it did not start' }
    return { ...d, task, status: 'error', attempts: [failed], screen: null }
  }
  await go('/tasks/11')
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.querySelector('.idle-note')).toBeNull()
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
    changes.push({ actor: 'human:ui', at: AT, text: 'notes + second' })
  }
  type(field('input[placeholder="Add a line to the notes…"]'), 'second')
  await click('Add')
  expect(posted.splice(0)).toEqual([{ id: 9, edit: { addNote: 'second' } }])
  expect(field<HTMLTextAreaElement>('.todo-form textarea').value).toBe('first\nsecond')
  expect(title()).toBe('new title')

  // Added below notes being rewritten, the line goes below what is typed too.
  type(field('.todo-form textarea'), 'first, edited\nsecond')
  onPost = () => {
    todo = { ...todo, notes: 'first\nsecond\nthird' }
    changes.push({ actor: 'human:ui', at: AT, text: 'notes + third' })
  }
  type(field('input[placeholder="Add a line to the notes…"]'), 'third')
  await click('Add')
  expect(posted.splice(0)).toEqual([{ id: 9, edit: { addNote: 'third' } }])
  expect(field<HTMLTextAreaElement>('.todo-form textarea').value).toBe(
    'first, edited\nsecond\nthird',
  )
  onPost = () => {}

  // Saving sends only what the person changed, so a change the page has not reloaded yet stays.
  todo = { ...todo, status: 'done' }
  await click('Save')
  expect(posted.splice(0)).toEqual([
    { id: 9, edit: { title: 'new title', notes: 'first, edited\nsecond\nthird' } },
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

  // A change done here that the next refresh brings, the reload after it having been cut short.
  rows = [todoItem(4, 'four'), todoItem(5, 'five')]
  await reload()
  act(() => [...document.querySelectorAll<HTMLElement>('.todo-title')][0]?.focus())
  onPost = () => {}
  await press('KeyX', 'x')
  expect(posted.splice(0)).toEqual([{ id: 4, edit: { status: 'done' } }])
  rows = rows.slice(1)
  await reload()
  expect(focused()).toBe('five')
  await press('KeyX', 'x')
  expect(posted.splice(0)).toEqual([{ id: 5, edit: { status: 'done' } }])
})

// What the search finds for each ref, as `Todos.find` would; a number is a task page, and no data
// the Projects page, where p3 is done.
const found: Record<string, unknown[]> = {
  r2: [{ kind: 'retro', id: 2, ref: 'r2', title: 'of #4: task 4', status: 'queued', taskId: 5 }],
  '3': [
    { kind: 'task', id: 3, ref: '#3', title: 'task 3', status: 'running', taskId: 3 },
    { kind: 'project', id: 3, ref: 'p3', title: 'Health', status: 'done' },
  ],
  '9': [],
}
const project = (id: number, title: string, status: string) => ({
  id,
  title,
  outcome: null,
  status,
  createdAt: AT,
  statusAt: AT,
  next: 0,
  waiting: 0,
  todos: [],
})
const searchAnswer = (data: unknown) =>
  typeof data === 'string'
    ? found[data]
    : data === undefined
      ? {
          today: '2026-10-23',
          projects: [project(1, 'Travel', 'active'), project(3, 'Health', 'done')],
        }
      : detail(data as number)
const cards = () => [...document.querySelectorAll('.card')].map((c) => c.className + c.textContent)
const search = async (ref: string) => {
  type(field('.side-search input'), ref)
  await submit('.side-search input')
}
const picks = () =>
  [...document.querySelectorAll('.side-search a')].map((a) => a.getAttribute('href'))
const at = () =>
  `${router.state.location.pathname}${router.state.location.hash && '#'}${router.state.location.hash}`

test('a search opens the one match, lists several to pick from, and says when none', async () => {
  answer = searchAnswer
  await go('/find')
  // A retrospective opens the task it runs in.
  await search('r2')
  expect(at()).toBe('/tasks/5')

  await go('/find')
  await search('3')
  expect(at()).toBe('/find')
  expect(picks()).toEqual(['/tasks/3', '/projects#p3'])
  act(() => document.querySelector<HTMLElement>('.side-search a[href="/projects#p3"]')?.click())
  await settle()
  expect(at()).toBe('/projects#p3')
  // A finished project shows when picked, and only then.
  expect(cards().filter((c) => c.includes('Health'))).toEqual([
    expect.stringMatching(/^card picked.*done/),
  ])
  await go('/projects')
  expect(cards().filter((c) => c.includes('Health'))).toEqual([])
  expect(cards().filter((c) => c.includes('Travel'))).toHaveLength(1)

  await go('/find')
  await search('9')
  expect(picks()).toEqual([])
  expect(document.querySelector('.side-search')?.textContent).toContain('No match for 9')

  // A search that fails says why, without the last one's matches.
  answer = (data) => {
    if (data === '4') throw new Error('ledger is busy')
    return searchAnswer(data)
  }
  await search('3')
  expect(picks()).toHaveLength(2)
  await search('4')
  expect(picks()).toEqual([])
  expect(banners()).toEqual(['ledger is busy'])
})

test('a search answered after a later one does not take its place', async () => {
  // The first search's answer is held until the second's has shown.
  let release: () => void = () => {}
  answer = (data) =>
    data === '3'
      ? new Promise((done) => {
          release = () => done(found['3'])
        })
      : searchAnswer(data)
  await go('/find')
  await search('3')
  await search('9')
  expect(document.querySelector('.side-search')?.textContent).toContain('No match for 9')
  await act(async () => release())
  await settle()
  expect(picks()).toEqual([])
  expect(document.querySelector('.side-search')?.textContent).toContain('No match for 9')
})

test('a task or todo that is not there, an unknown page and a page that fails show in the layout with a way out', async () => {
  const shown = () => ({
    title: document.querySelector('.layout .page h1')?.textContent,
    out: document.querySelector('.layout .page a')?.getAttribute('href'),
  })
  // As the server functions' validators do, a number that is not a whole one is refused.
  answer = (id) => {
    if (!Number.isInteger(id)) throw new Error('id must be an integer')
    return null
  }
  for (const href of ['/tasks/999999', '/todos/999999', '/nope', '/tasks/abc', '/todos/1.5']) {
    await go(href)
    expect(shown()).toEqual({ title: 'Not found', out: '/focus' })
    expect(document.querySelector('.layout .subtitle')?.textContent).toBe(`Nothing is at ${href}.`)
  }

  answer = () => {
    throw new Error('ledger is busy')
  }
  await go('/tasks/3')
  expect(shown()).toEqual({ title: 'Something went wrong', out: '/focus' })
  expect(banners()).toEqual(['ledger is busy'])
  // The next reload that works shows the page.
  answer = (id) => detail(id as number)
  await reload()
  expect(document.querySelector('.layout .task-title')?.textContent).toBe('task 3')
})

test("the sidebar's data failing to load leaves the layout, without its lists, until a refresh reads it", async () => {
  answer = (id) => detail(id as number)
  rootFails = new Error('ledger is busy')
  await go('/tasks/3')
  expect(document.querySelector('.layout')).toBeNull()
  expect(document.querySelector('.sidebar a[href="/inbox"]')).not.toBeNull()
  expect(document.querySelector('.side-summary')).toBeNull()
  expect(document.querySelector('.main h1')?.textContent).toBe('Something went wrong')
  expect(banners()).toEqual(['ledger is busy'])
  // The layout's 5 second refresh, once the ledger reads.
  rootFails = null
  await reload()
  expect(document.querySelector('.sidebar')).toBeNull()
  expect(document.querySelector('.layout .task-title')?.textContent).toBe('task 3')
})
