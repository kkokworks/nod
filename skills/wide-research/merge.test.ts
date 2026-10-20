import { expect, test } from 'bun:test'
import { collect, csvTable, type Plan, table } from './merge'

const plan: Plan = {
  title: 'T',
  conditions: 'c',
  columns: [
    { name: 'a', spec: '' },
    { name: 'b', spec: '' },
  ],
  items: ['X', 'Y'],
}
const line = (item: string, a: unknown, b: unknown, note = '') =>
  JSON.stringify({ item, cells: { a, b }, note })
const ok = { value: '1 | 2', source: 'https://example.com/x' }

test('the last line per item wins, in plan order', () => {
  const text = [line('Y', ok, null), line('X', null, null), line('X', ok, ok)].join('\n')
  const { results, errors } = collect(text, plan)
  expect(errors).toEqual([])
  expect(results.map((r) => [r.item, r.cells.a])).toEqual([
    ['X', ok],
    ['Y', ok],
  ])
})

test('every malformed line and missing item is an error', () => {
  const text = [
    'not json',
    line('X', { value: '1' }, null),
    line('X', ok, null, 'n').replace(',"b":null', ''),
    line('Z', ok, ok),
  ].join('\n')
  const { errors } = collect(text, plan)
  expect(errors).toHaveLength(5)
  expect(errors.at(-1)).toBe('no result for: X, Y')
})

test('an empty marker in any form is an empty cell', () => {
  const text = [
    line('X', { value: 'null', source: ok.source }, { value: null, source: null }),
    line('Y', { value: ' ', source: null }, null),
  ].join('\n')
  const { results, errors } = collect(text, plan)
  expect(errors).toEqual([])
  expect(results.flatMap((r) => [r.cells.a, r.cells.b])).toEqual([null, null, null, null])
})

test('values reach the table exactly, escaped', () => {
  const { results } = collect([line('X', ok, null), line('Y', null, ok, 'p')].join('\n'), plan)
  expect(table(plan, results)).toContain('| X | 1 \\| 2 [↗](https://example.com/x) | — |')
  expect(csvTable(plan, results).split('\n')[1]).toBe(
    '"X","1 | 2","https://example.com/x","","",""',
  )
})
