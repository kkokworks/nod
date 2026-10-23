import { expect, test } from 'bun:test'
import { doneShown, SHOWN_MAX } from './input'

test('doneShown takes counts from 1 to the most, and refuses the rest', () => {
  expect(doneShown({ done: 200, dropped: 100, collected: SHOWN_MAX })).toEqual({
    done: 200,
    dropped: 100,
    collected: SHOWN_MAX,
  })
  for (const bad of [-100, 0, 1.5, '100', null, SHOWN_MAX + 1]) {
    expect(() => doneShown({ done: bad, dropped: 100, collected: 100 })).toThrow('done')
  }
  expect(() => doneShown({ done: 100, dropped: 100 })).toThrow('collected')
})
