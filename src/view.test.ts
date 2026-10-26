import { expect, test } from 'bun:test'
import { ago, type LsTask, lsGroups, lsLine, lsMode, lsTable } from './view'

const now = new Date('2026-10-26T12:00:00Z')
const minsAgo = (mins: number): string => new Date(now.getTime() - mins * 60_000).toISOString()
const task = (o: Partial<LsTask> & { id: number }): LsTask => ({
  todoId: null,
  retroId: null,
  status: 'succeeded',
  sessionEnded: false,
  turns: 1,
  createdAt: minsAgo(600),
  startedAt: null,
  finishedAt: null,
  note: '',
  issue: null,
  links: [],
  pushed: [],
  ...o,
})

// One task in each group, with Hangul and emoji in the notes.
const tasks: LsTask[] = [
  task({
    id: 3,
    todoId: 12,
    status: 'error',
    turns: 4,
    finishedAt: minsAgo(50),
    note: 'the build failed: a module is missing\nTraceback on the second line',
    issue: 'PROJ-1',
    links: ['https://example.com/acme/shop/pull/27'],
  }),
  task({
    id: 9,
    todoId: 20,
    status: 'running',
    startedAt: minsAgo(1),
    note: '로그인 화면의 문구를 다듬고 시험을 고칩니다 🚀',
    issue: 'PROJ-2',
  }),
  task({ id: 11, retroId: 4, status: 'queued', note: 'waits for #9: 다음 일 👩‍💻' }),
  task({ id: 6, todoId: 15, turns: 3, finishedAt: minsAgo(60 * 26), note: '보고서 초안 쓰기' }),
  task({
    id: 8,
    todoId: 18,
    finishedAt: minsAgo(18),
    note: '리뷰 완료 — 고칠 것 1건',
    links: ['https://example.com/acme/web/pull/41'],
  }),
]

const rowOf = (table: string, id: number): string =>
  table.split('\n').find((l) => l.startsWith(`│ #${id} `)) ?? ''
const cellsOf = (line: string): string[] =>
  line
    .split('│')
    .map((c) => c.trim())
    .filter((c) => c !== '')

test('ls draws every line of the table exactly as wide as the terminal', () => {
  for (const width of [60, 80, 110, 160]) {
    const lines = lsTable(tasks, width, false, now).split('\n')
    expect(lines.map((l) => [width, Bun.stringWidth(l)])).toEqual(lines.map(() => [width, width]))
    // A row per task, whatever the width.
    expect(lines.filter((l) => /^│ #\d/.test(l))).toHaveLength(tasks.length)
  }
  // Colors take no room.
  for (const line of lsTable(tasks, 80, true, now).split('\n')) {
    expect(Bun.stringWidth(line)).toBe(80)
  }
})

test('ls drops the turns column, then the todo column, as the terminal narrows', () => {
  const head = (width: number): string[] =>
    cellsOf(lsTable(tasks, width, false, now).split('\n')[1] ?? '')

  expect(head(110)).toEqual(['#', '할 일', '상태', '차례', '지남', '요약', '이슈 · 결과'])
  expect(head(80)).toEqual(['#', '할 일', '상태', '지남', '요약', '이슈 · 결과'])
  expect(head(60)).toEqual(['#', '상태', '지남', '요약', '이슈 · 결과'])
})

test('ls groups what needs you, running, queued, unsent, then ended, the latest first in each', () => {
  const sessionEnded = task({
    id: 21,
    status: 'running',
    sessionEnded: true,
    startedAt: minsAgo(3),
  })
  const asked = task({ id: 22, status: 'needs_decision', startedAt: minsAgo(30) })
  const cancelled = task({ id: 23, status: 'cancelled', finishedAt: minsAgo(5) })
  const pushed = task({ id: 24, finishedAt: minsAgo(2), pushed: ['origin/feat/x'] })
  const groups = lsGroups([...tasks, sessionEnded, asked, cancelled, pushed])

  expect(groups.map((g) => [g.name, g.tasks.map((t) => t.id)])).toEqual([
    ['결정 대기 · 오류', [21, 22, 3]],
    ['진행 중', [9]],
    ['차례 기다림', [11]],
    ['끝남 · 내보내기 전', [6]],
    ['끝남', [24, 23, 8]],
  ])
  // No task queued or running: those groups are not drawn.
  const ended = lsTable([pushed, cancelled], 80, false, now)
  expect(ended).toContain('│ 끝남 (2) ')
  for (const name of ['결정 대기', '진행 중', '차례 기다림', '내보내기 전']) {
    expect(ended).not.toContain(name)
  }
  // Equal times: the later task first.
  const twins = [task({ id: 1, finishedAt: minsAgo(5) }), task({ id: 2, finishedAt: minsAgo(5) })]
  expect(lsGroups(twins)[0]?.tasks.map((t) => t.id)).toEqual([2, 1])
})

test("ls shows only an error's first line, cut with … when it is too long", () => {
  const table = lsTable(tasks, 80, false, now)
  const row = rowOf(table, 3)

  expect(row).toContain('│ ✕ 오류 ')
  expect(row).toMatch(/│ the build failed[^│]*… │/)
  expect(row).not.toContain('is missing')
  expect(table).not.toContain('Traceback')
  // The whole first line where there is room.
  expect(lsTable(tasks, 160, false, now)).toContain('the build failed: a module is missing ')
})

test('ls shortens pull request links and counts the age from the end, else the last turn', () => {
  const table = lsTable(tasks, 110, false, now)
  const row = (id: number): string[] => cellsOf(rowOf(table, id))

  expect(row(3)).toEqual(['#3', 't12', '✕ 오류', '4', '50분', expect.any(String), 'PROJ-1 shop#27'])
  expect(row(9).slice(2, 5)).toEqual(['▶ 진행', '1', '1분'])
  expect(row(11).slice(1, 5)).toEqual(['r4', '○ 기다림', '1', '10시간'])
  expect(row(6)[4]).toBe('1일')
  expect(row(8)[6]).toBe('web#41')
  expect([ago(minsAgo(0), now), ago(minsAgo(59), now), ago(minsAgo(60 * 24 - 1), now)]).toEqual([
    '0분',
    '59분',
    '23시간',
  ])
})

test('ls colors only the status, dims the age and results, and has no color in a pipe or with NO_COLOR', () => {
  const plain = lsTable(tasks, 110, false, now)
  const colored = lsTable(tasks, 110, true, now)

  expect(plain).not.toContain('\x1b')
  expect(rowOf(colored, 3)).toContain('\x1b[31m✕ 오류')
  expect(rowOf(colored, 9)).toContain('\x1b[34m▶ 진행')
  expect(rowOf(colored, 8)).toContain('\x1b[32m✓ 성공')
  expect(rowOf(colored, 11)).toContain('\x1b[2m○ 기다림')
  expect(rowOf(colored, 3)).toContain('\x1b[2m50분')
  expect(rowOf(colored, 3)).toContain('\x1b[2mPROJ-1 shop#27')
  expect(rowOf(colored, 3)).toContain('│ #3  │ t12   │')
  // The header and group rows have none.
  expect(colored.split('\n').filter((l) => l.includes('\x1b'))).toHaveLength(tasks.length)

  expect(lsMode({}, true, undefined)).toBe('color')
  expect(lsMode({}, true, '1')).toBe('table')
  expect(lsMode({}, false, undefined)).toBe('plain')
  expect(lsMode({ plain: true }, true, undefined)).toBe('plain')
  expect(lsMode({ json: true, plain: true }, true, undefined)).toBe('json')
})

test('ls --plain gives a tab-separated line a task, with whole values', () => {
  const [error, , queued] = tasks
  if (error === undefined || queued === undefined) throw new Error('no tasks')
  const tabbed = task({ id: 5, note: 'a\ttab and \x1b[31man escape' })

  expect(lsLine(error).split('\t')).toEqual([
    '3',
    't12',
    'error',
    '4',
    minsAgo(50),
    'the build failed: a module is missing',
    'PROJ-1 https://example.com/acme/shop/pull/27',
  ])
  expect(lsLine(queued).split('\t')).toEqual([
    '11',
    'r4',
    'queued',
    '1',
    minsAgo(600),
    'waits for #9: 다음 일 👩‍💻',
    '',
  ])
  expect(lsLine(task({ id: 7, status: 'running', sessionEnded: true })).split('\t')[2]).toBe(
    'session ended',
  )
  expect(lsLine(tabbed).split('\t')).toHaveLength(7)
  expect(lsLine(tabbed)).not.toContain('\x1b')
})
