import { expect, test } from 'bun:test'
import { doneSearch, doneShown, SHOWN_MAX } from './input'

const BAD = [-100, 0, 1.5, '100', null, SHOWN_MAX + 1]

test('the server takes counts from 1 to the most, and refuses the rest', () => {
  expect(doneShown({ done: 200, dropped: 100, collected: SHOWN_MAX })).toEqual({
    done: 200,
    dropped: 100,
    collected: SHOWN_MAX,
  })
  for (const bad of BAD) {
    expect(() => doneShown({ done: bad, dropped: 100, collected: 100 })).toThrow('done')
  }
  expect(() => doneShown({ done: 100, dropped: 100 })).toThrow('collected')
})

test('the address keeps the good counts and drops the bad ones', () => {
  expect(doneSearch({ done: 200, collected: SHOWN_MAX, other: 1 })).toEqual({
    done: 200,
    collected: SHOWN_MAX,
  })
  for (const bad of BAD) expect(doneSearch({ done: bad, dropped: 300 })).toEqual({ dropped: 300 })
})
