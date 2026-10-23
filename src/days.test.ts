import { expect, test } from 'bun:test'
import { nextDates, nextWorkday, parseWhen } from './days'

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

test('a monthly series keeps its day through short months, asking the ones before', () => {
  const none = { due: null, scheduled: null, start: null }
  const next = (due: string, before: string[], today: string) =>
    nextDates(
      { ...none, due },
      'monthly',
      today,
      before.map((d) => ({ ...none, due: d })),
    ).due
  // February's 28th stands for the 31st, or the 30th, the series was set on.
  expect(next('2026-02-28', ['2026-01-31'], '2026-02-28')).toBe('2026-03-31')
  expect(next('2026-02-28', ['2026-01-30'], '2026-02-28')).toBe('2026-03-30')
  expect(next('2026-04-30 09:00', ['2026-03-31', '2026-02-28'], '2026-04-30')).toBe(
    '2026-05-31 09:00',
  )
  // Done on March 29th, February's one still has March 31st to come.
  expect(next('2026-02-28', ['2026-01-31'], '2026-03-29')).toBe('2026-03-31')
  // A day the person moved it to is the series' day from then on.
  expect(next('2026-02-15', ['2026-01-31'], '2026-02-15')).toBe('2026-03-15')
  expect(next('2026-03-28', ['2026-02-28', '2026-01-31'], '2026-03-28')).toBe('2026-04-28')
  // A date the one before did not have is its own.
  const start = { ...none, start: '2026-02-28' }
  expect(nextDates(start, 'monthly', '2026-02-28', [{ ...none, due: '2026-01-31' }]).start).toBe(
    '2026-03-28',
  )
})

test('the next workday after a Friday or a weekend day is Monday', () => {
  // 2026-10-23 is a Friday.
  const after = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map(nextWorkday)
  expect(after).toEqual(['2026-10-23', '2026-10-26', '2026-10-26', '2026-10-26'])
})
