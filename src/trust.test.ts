import { expect, test } from 'bun:test'
import type { Project, Todo } from './todos'
import { nudgeLine, trust } from './trust'

// A moment written as local time, so it falls on the day written in every time zone.
const at = (local: string): string => new Date(local).toISOString()
const todo = (id: number, edit: Partial<Todo>): Todo => ({
  id,
  title: `todo ${id}`,
  notes: null,
  status: 'next',
  projectId: null,
  context: null,
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
  createdAt: at('2026-10-20T10:00'),
  statusAt: at('2026-10-20T10:00'),
  ...edit,
})
const project = (id: number, next: number): Project & { next: number } => ({
  id,
  title: `project ${id}`,
  outcome: null,
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  statusAt: '2026-10-01T00:00:00.000Z',
  next,
})
const none = { overdue: [], scheduled: [], due: [], focus: [] }

test('the numbers that say whether the lists can be trusted', () => {
  const kim = todo(3, { status: 'waiting', waitingOn: 'Kim' })
  const lee = todo(4, { status: 'waiting', waitingOn: 'Lee' })
  const late = todo(5, { due: '2026-10-19' })
  const call = todo(6, { scheduled: '2026-10-28 15:00' })
  // A watch that fails for good waits long too; a todo waiting on its task does not.
  const watched = todo(7, { status: 'waiting', watch: 'test -f pushed' })
  const delegated = todo(8, { status: 'waiting' })
  const t = trust(
    {
      open: [
        todo(1, { status: 'inbox', createdAt: at('2026-10-14T12:00') }),
        todo(2, { status: 'inbox' }),
        kim,
        lee,
        late,
        call,
        watched,
        delegated,
      ],
      projects: [project(1, 1), project(2, 0)],
      lastChange: new Map([
        [3, at('2026-10-20T10:00')],
        [4, at('2026-10-27T10:00')],
        [7, at('2026-10-20T10:00')],
      ]),
      lastReview: at('2026-10-16T17:00'),
      day: { ...none, overdue: [late], scheduled: [call] },
    },
    '2026-10-28',
  )
  expect(t).toMatchObject({
    inbox: 2,
    oldestInbox: '2026-10-14',
    overdue: [late],
    today: [call],
    stuck: [{ id: 2 }],
    stale: [
      { todo: kim, since: '2026-10-20', days: 8 },
      { todo: watched, since: '2026-10-20', days: 8 },
    ],
    sinceReview: 12,
  })
  expect(nudgeLine(t, '2026-10-28')).toBe(
    'nod · overdue 1 · today 1 · inbox 2 since 10-14 · no next action 1 · waiting long 2 · weekly review 12 days ago',
  )
  const calm = trust(
    { open: [], projects: [], lastChange: new Map(), lastReview: null, day: none },
    '2026-10-28',
  )
  expect(calm).toMatchObject({ inbox: 0, oldestInbox: null, sinceReview: null })
  expect(nudgeLine(calm, '2026-10-28')).toBeNull()
})
