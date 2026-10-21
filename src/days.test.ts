import { expect, test } from 'bun:test'
import { nextDates, parseWhen } from './days'

test('a day is YYYY-MM-DD, today or tomorrow, with a time only where one is allowed', () => {
  expect(parseWhen('today', '2026-10-31', false)).toBe('2026-10-31')
  expect(parseWhen('tomorrow 09:05', '2026-10-31', true)).toBe('2026-11-01 09:05')
  expect(parseWhen('2026-10-23T17:00', '2026-10-20', true)).toBe('2026-10-23 17:00')
  expect(() => parseWhen('2026-02-30', '2026-10-20', true)).toThrow('no such day: 2026-02-30')
  expect(() => parseWhen('2026-10-23 24:00', '2026-10-20', true)).toThrow('no such time: 24:00')
  expect(() => parseWhen('today 09:00', '2026-10-20', false)).toThrow('a day only')
  expect(() => parseWhen('next friday', '2026-10-20', true)).toThrow('not a day: next friday')
})

test('a repeating todo moves on whole periods from its schedule, past today', () => {
  const none = { due: null, scheduled: null, start: null }
  // The weekly review due on Friday at 17:00, done the next Monday: the next one is this Friday.
  expect(nextDates({ ...none, due: '2026-10-16 17:00' }, 'weekly', '2026-10-19')).toEqual({
    ...none,
    due: '2026-10-23 17:00',
  })
  // Done early, on Thursday: a week after its own Friday.
  expect(nextDates({ ...none, due: '2026-10-23 17:00' }, 'weekly', '2026-10-22').due).toBe(
    '2026-10-30 17:00',
  )
  // Left for weeks: the first Friday after today, not one already overdue.
  expect(nextDates({ ...none, due: '2026-09-25' }, 'weekly', '2026-10-20').due).toBe('2026-10-23')
  // The dates move together, the periods counted from the earliest; the 31st becomes the 30th.
  expect(
    nextDates({ due: '2026-10-31', scheduled: null, start: '2026-10-25' }, 'monthly', '2026-10-26'),
  ).toEqual({ due: '2026-11-30', scheduled: null, start: '2026-11-25' })
  expect(nextDates({ ...none, start: '2026-10-20' }, 'daily', '2026-10-20').start).toBe(
    '2026-10-21',
  )
  expect(() => nextDates(none, 'daily', '2026-10-20')).toThrow('needs a date')
})
