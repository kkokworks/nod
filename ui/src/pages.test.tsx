import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  jest,
  mock,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AnyRoute } from '@tanstack/react-router'
import { tempDirs } from '../../test/tmp'

// The real pages and rows, in a DOM, under a router; the server functions are answered here.
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// The sockets a worker's live screen opens (terminal.tsx), connected to nothing: the server's side
// has tests of its own (terminal.server.test.ts).
class Socket {
  static readonly OPEN = 1
  static made: Socket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(readonly url: string) {
    Socket.made.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
  }
}
Object.assign(globalThis, { WebSocket: Socket })
// Loaded once here, so the screen's own import of them is done by the time a page settles.
await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])

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
const { RETRY_MS } = await import('./terminal')
const shell = await import('./routes/__root')
if (before === undefined) delete process.env.NOD_HOME
else process.env.NOD_HOME = before

// The pages in a layout, as the real root puts them beside the sidebar.
const root = R.createRootRoute({
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
  screen: null as string | null,
  root: null,
})
// The same with its session alive.
const live = (id: number) => ({ ...detail(id), screen: 'working' })

test('a live session is typed into on its screen, with the box below only to answer a decision; a task with none keeps the box to message it', async () => {
  answer = (id) => live(id as number)
  await go('/tasks/23')
  expect(document.querySelector('.term')).not.toBeNull()
  expect(document.querySelector('.composer')).toBeNull()
  expect(document.querySelector('.computer')?.textContent).not.toContain('nod attach')
  // What is typed on the screen does not answer a decision, so the box comes back for one.
  open[23] = { id: 30, reason: 'question' }
  await reload()
  expect(field<HTMLTextAreaElement>('.composer textarea').placeholder).toBe('Your answer…')
  open[23] = undefined
  // With the session gone, the box is the way to the worker.
  answer = (id) => detail(id as number)
  await reload()
  expect(document.querySelector('.term')).toBeNull()
  expect(field<HTMLTextAreaElement>('.composer textarea').placeholder).toBe('Message the worker…')
})

test("a live worker's screen attaches to its session, takes keys, and lets go when the page moves on or the session ends", async () => {
  answer = (id) => live(id as number)
  Socket.made.length = 0
  await go('/tasks/20')
  const [socket] = Socket.made
  expect(socket?.url).toMatch(/^ws:\/\/[^/]*\/terminal\/20\?cols=\d+&rows=\d+$/)
  if (socket === undefined) return
  // The screen as it was shows until the first bytes come.
  const shown = () => !field('.term-box .screen').hidden
  expect(shown()).toBe(true)
  socket.readyState = Socket.OPEN
  act(() => socket.onmessage?.({ data: new TextEncoder().encode('live').buffer }))
  expect(shown()).toBe(false)
  // As a key typed into xterm.js's field comes.
  act(() => {
    field('.xterm-helper-textarea').dispatchEvent(
      new InputEvent('input', { data: 'y', inputType: 'insertText', bubbles: true }),
    )
  })
  expect(socket.sent).toContainEqual(['in', 'y'])
  // The page's reload keeps it attached.
  await reload()
  expect(Socket.made).toEqual([socket])

  await go('/tasks/21')
  expect(socket.readyState).toBe(3)
  const next = Socket.made[1]
  expect(next?.url).toContain('/terminal/21?')
  answer = (id) => detail(id as number)
  await reload()
  expect(next?.readyState).toBe(3)
  expect(document.querySelector('.term')).toBeNull()
})

test("a live worker's screen lets go while the page is out of sight, and attaches again when it shows or a while after its connection closed", async () => {
  answer = (id) => live(id as number)
  Socket.made.length = 0
  await go('/tasks/22')
  // As a hidden app window or a tab behind others is.
  const sight = (state: 'hidden' | 'visible') =>
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
  try {
    sight('hidden')
    await settle()
    expect(Socket.made.map((s) => s.readyState)).toEqual([3])
    sight('visible')
    await settle()
    expect(Socket.made.map((s) => s.readyState)).toEqual([3, 0])
  } finally {
    Reflect.deleteProperty(document, 'visibilityState')
  }
  // The UI server went away: it attaches again once the page would have reloaded.
  jest.useFakeTimers()
  try {
    act(() => Socket.made[1]?.onclose?.())
    act(() => jest.advanceTimersByTime(RETRY_MS - 1))
    expect(Socket.made).toHaveLength(2)
    act(() => jest.advanceTimersByTime(1))
  } finally {
    jest.useRealTimers()
  }
  await settle()
  expect(Socket.made).toHaveLength(3)
  expect(Socket.made[2]?.url).toContain('/terminal/22?')
})

test('what is written to one task does not go to another', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/3')
  type(field('.composer textarea'), 'for three')
  await go('/tasks/4')
  expect(field<HTMLTextAreaElement>('.composer textarea').value).toBe('')
  type(field('.composer textarea'), 'for four')
  await submit('.composer textarea')
  expect(posted.splice(0)).toEqual([{ taskId: 4, decisionId: null, text: 'for four' }])
})

test('a message does not answer a decision that opened while it was written', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/4')
  type(field('.composer textarea'), 'carry on')
  open[4] = { id: 7, reason: 'question' }
  await reload()
  await submit('.composer textarea')
  expect(posted).toEqual([])
  expect(banners().join()).toContain('#7')
  expect(field<HTMLTextAreaElement>('.composer textarea').value).toBe('carry on')
  // Sent again, having seen it, it answers the decision.
  await submit('.composer textarea')
  expect(posted.splice(0)).toEqual([{ taskId: 4, decisionId: 7, text: 'carry on' }])

  // And an answer to a decision that closed meanwhile does not become a message.
  type(field('.composer textarea'), 'use the first')
  open[4] = undefined
  await reload()
  await submit('.composer textarea')
  expect(posted).toEqual([])
  expect(banners().join()).toContain('#7')
})

test('answering with a button keeps what was being written', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/5')
  type(field('.composer textarea'), 'half a thought')
  open[5] = { id: 8, reason: 'permission' }
  onPost = () => {
    open[5] = undefined
  }
  await reload()
  setSystemTime(new Date(Date.now() + 1500))
  await click('Yes')
  expect(posted.splice(0)).toEqual([{ taskId: 5, decisionId: 8, text: 'yes' }])
  expect(field<HTMLTextAreaElement>('.composer textarea').value).toBe('half a thought')
})

test('⌘↵ pressed again before the message is through sends it once', async () => {
  answer = (id) => detail(id as number)
  await go('/tasks/7')
  type(field('.composer textarea'), 'hi')
  const send = () =>
    act(() => {
      field('.composer textarea').dispatchEvent(
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
  // As the server functions' validators do, a number that is not a whole one is refused. Task 1000
  // is there, which /tasks/1e3 does not name.
  answer = (id) => {
    if (!Number.isInteger(id)) throw new Error('id must be an integer')
    return id === 1000 ? detail(1000) : null
  }
  const hrefs = [
    '/tasks/999999',
    '/todos/999999',
    '/nope',
    '/tasks/abc',
    '/todos/1.5',
    '/tasks/1e3',
  ]
  for (const href of hrefs) {
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

// The real root, in a router of its own, without the document shell around it.
const realRoot = () =>
  R.createRouter({
    routeTree: R.createRootRoute({
      loader: shell.Route.options.loader,
      component: shell.Route.options.component,
    } as never) as unknown as AnyRoute,
    history: R.createMemoryHistory({ initialEntries: ['/'] }),
    defaultNotFoundComponent: () => <p className="here">page</p>,
  })
// What the sidebar gets with nothing in the ledger, from a server of `build`; '' is this page's.
const overview = (build: string) => ({
  decisions: [],
  groups: [],
  collected: { items: [], total: 0 },
  inbox: 0,
  build,
})

test("a page from another build than the server's loads itself again, once for that build", async () => {
  const reloads = spyOn(location, 'reload').mockImplementation(() => {})
  const box = document.body.appendChild(document.createElement('div'))
  let own = createRoot(box)
  const load = async (app: ReturnType<typeof realRoot>) => {
    await act(async () => own.render(<R.RouterProvider router={app as never} />))
    await settle()
  }
  sessionStorage.clear()
  try {
    answer = () => overview('')
    const app = realRoot()
    await load(app)
    expect(reloads).not.toHaveBeenCalled()
    // The server was built again (ui.sh install) while the page was open.
    answer = () => overview('newer')
    await act(() => app.invalidate())
    await settle()
    expect(reloads).toHaveBeenCalledTimes(1)
    // Loaded anew and still told of another build: not again, or it would reload for good.
    act(() => own.unmount())
    own = createRoot(box)
    await load(realRoot())
    expect(reloads).toHaveBeenCalledTimes(1)
  } finally {
    reloads.mockRestore()
    sessionStorage.clear()
    act(() => own.unmount())
    box.remove()
  }
})

test("the sidebar's data failing to load leaves the layout without its lists, and a refresh that reads brings them", async () => {
  const app = realRoot()
  const box = document.body.appendChild(document.createElement('div'))
  const own = createRoot(box)
  // The layout's 5 second refresh.
  const refresh = async () => {
    await act(() => app.invalidate())
    await settle()
  }
  try {
    answer = () => {
      throw new Error('ledger is busy')
    }
    await act(async () => own.render(<R.RouterProvider router={app as never} />))
    await settle()
    expect(box.querySelector('.sidebar a[href="/inbox"]')).not.toBeNull()
    expect(box.querySelector('.side-summary')).toBeNull()
    expect(box.querySelector('.main h1')?.textContent).toBe('Something went wrong')
    expect(box.querySelector('.main .banner')?.textContent).toBe('ledger is busy')
    // A refresh that fails again keeps what is being typed in the sidebar.
    const search = box.querySelector<HTMLInputElement>('.side-search input')
    if (search === null) throw new Error('no search box')
    type(search, 'r2')
    await refresh()
    expect(box.querySelector<HTMLInputElement>('.side-search input')?.value).toBe('r2')

    answer = () => ({ ...overview(''), inbox: 2 })
    await refresh()
    expect(box.querySelector('.side-summary')?.textContent).toContain('0 tasks')
    expect(box.querySelector('.main .here')).not.toBeNull()
  } finally {
    act(() => own.unmount())
    box.remove()
  }
})
