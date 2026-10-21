import { afterAll, expect, test } from 'bun:test'
import { Ledger } from '../src/ledger'
import { Todos } from '../src/todos'
import { tempDirs } from '../test/tmp'
import { apply, mapMindwtr } from './import-mindwtr'

const tmp = tempDirs()
afterAll(tmp.removeAll)

const tools = { planeUrl: 'https://plane.example.com', forgejoOrg: 'team' }
const at = (day: string) => `${day}T01:00:00.000Z`
const task = (id: string, edit: Record<string, unknown>) => ({
  id,
  title: `todo ${id}`,
  status: 'next',
  createdAt: at('2026-10-01'),
  updatedAt: at('2026-10-10'),
  ...edit,
})
const issue = (key: string) => ({
  kind: 'link',
  uri: `https://plane.example.com/ws/browse/${key}/`,
  title: key,
})
const tasks = [
  task('a', { status: 'done', completedAt: at('2026-10-05'), attachments: [issue('ENG-1')] }),
  // The open todo on the same issue holds its key; the done one keeps its Mindwtr id.
  task('b', {
    attachments: [
      { kind: 'link', uri: 'https://team.slack.com/archives/C1/p1', title: 'thread' },
      issue('ENG-1'),
    ],
    contexts: ['desk'],
    dueDate: '2026-10-23T08:00:00.000Z',
    startTime: '2026-10-20',
    isFocusedToday: true,
  }),
  task('c', {
    status: 'archived',
    cancelledAt: at('2026-10-06'),
    archivedAt: at('2026-10-07'),
    projectId: 'p-old',
  }),
  task('d', {
    status: 'waiting',
    assignedTo: 'Kim',
    description: 'Asked for the report',
    checklist: [
      { title: '결정 #4 (question): which?', isCompleted: true },
      { title: 'Send the draft', isCompleted: false },
    ],
    tags: ['money'],
  }),
  task('e', { status: 'waiting', assignedTo: 'nod', description: 'nod #7\nfix the build' }),
  // Task #7 did two issues; the done one does not get it.
  task('e2', { status: 'done', description: 'nod #7\nthe other', completedAt: at('2026-10-09') }),
  task('f', { title: '주간 리뷰하기', recurrence: { rule: 'weekly' }, dueDate: '2026-10-23' }),
  task('g', { status: 'archived', deletedAt: at('2026-10-08') }),
  task('h', { status: 'archived', completedAt: at('2026-10-09'), projectId: 'p-done' }),
]
const projects = [
  {
    id: 'p-old',
    title: 'Old',
    status: 'archived',
    createdAt: at('2026-09-01'),
    updatedAt: at('2026-10-07'),
    archivedAt: at('2026-10-07'),
  },
  {
    id: 'p-done',
    title: 'Done one',
    status: 'archived',
    createdAt: at('2026-09-01'),
    updatedAt: at('2026-10-09'),
    archivedAt: at('2026-10-09'),
  },
  {
    id: 'p-live',
    title: 'Live',
    status: 'active',
    createdAt: at('2026-09-01'),
    updatedAt: at('2026-10-02'),
  },
]

test('Mindwtr todos come in with nod statuses, their times, channel keys and links', () => {
  const data = mapMindwtr(tasks, projects, tools)
  expect(data.expected).toEqual({
    inbox: 0,
    next: 2,
    waiting: 2,
    someday: 0,
    reference: 0,
    done: 3,
    dropped: 1,
  })
  const byTitle = Object.fromEntries(data.todos.map((t) => [t.row.title, t]))
  expect(byTitle['todo a']?.row).toMatchObject({
    status: 'done',
    source: 'mindwtr',
    sourceKey: 'a',
    statusAt: at('2026-10-05'),
  })
  expect(byTitle['todo b']?.row).toMatchObject({
    source: 'plane',
    sourceKey: 'ENG-1',
    context: '@desk',
    due: new Date('2026-10-23T08:00:00.000Z').toLocaleString('sv-SE').slice(0, 16),
    start: '2026-10-20',
    focus: new Date(at('2026-10-10')).toLocaleDateString('sv-SE'),
  })
  expect(byTitle['todo b']?.links).toEqual([
    { url: 'https://team.slack.com/archives/C1/p1', title: 'thread' },
    { url: 'https://plane.example.com/ws/browse/ENG-1/', title: 'ENG-1' },
  ])
  expect(byTitle['todo c']?.row).toMatchObject({ status: 'dropped', statusAt: at('2026-10-06') })
  expect(byTitle['todo d']?.row).toMatchObject({
    waitingOn: 'Kim',
    notes: 'Asked for the report\n\n체크리스트:\n- [ ] Send the draft\n\n태그: money',
  })
  expect(byTitle['todo e']).toMatchObject({ row: { waitingOn: null }, nodTask: 7 })
  expect(byTitle['주간 리뷰하기']?.row).toMatchObject({
    source: 'review',
    repeat: 'weekly',
    due: '2026-10-23',
  })
  expect(byTitle['todo g']).toBeUndefined()
  // Everything in it was cancelled, so the project was dropped; the other was done.
  expect(data.projects.map((p) => [p.row.title, p.row.status])).toEqual([
    ['Old', 'dropped'],
    ['Done one', 'done'],
    ['Live', 'active'],
  ])
})

test('the import is all or nothing, links the nod tasks it names, and refuses to run twice', () => {
  const ledger = new Ledger(tmp.make('nod-import-'))
  const seven = Array.from({ length: 7 }, () =>
    ledger.add({
      brief: 'b',
      repo: null,
      branch: null,
      checkCmd: null,
      model: null,
      after: [],
      triggerId: null,
      issue: null,
    }),
  ).at(-1)
  const data = mapMindwtr(tasks, projects, tools)
  // Todos are numbered in Mindwtr's order (a b c d e e2 f h), so e2 is t6.
  expect(apply(ledger, data)).toEqual({ missing: [], shared: [{ task: 7, todos: [6] }] })
  const todos = new Todos(ledger)
  const every = { context: null, projectId: null, hideSomedayProjects: false, day: null }
  const all = todos.list({
    statuses: ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'dropped'],
    ...every,
  })
  expect(all).toHaveLength(8)
  const e = all.find((t) => t.title === 'todo e')
  expect(seven === undefined ? null : ledger.get(seven).todoId).toBe(e?.id ?? -1)
  // The one change of each is the import's, at when it last moved in Mindwtr.
  expect(todos.changes(all[0]?.id ?? -1).map((c) => [c.actor, c.at])).toEqual([
    ['import', at('2026-10-10')],
  ])
  expect(todos.trust('2026-10-21').stale.map((s) => s.todo.title)).toEqual(['todo d'])
  expect(() => apply(ledger, data)).toThrow('already has todos or projects')
})

test('a todo brought into a closed project while open is refused, and nothing comes in', () => {
  const ledger = new Ledger(tmp.make('nod-import-'))
  const bad = mapMindwtr([task('x', { projectId: 'p-done' }), task('y', {})], projects, tools)
  expect(() => apply(ledger, bad)).toThrow('an open todo cannot be in it')
  expect(new Todos(ledger).projects(['active', 'someday', 'done', 'dropped'])).toEqual([])
})
