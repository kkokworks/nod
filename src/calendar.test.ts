import { afterAll, expect, test } from 'bun:test'
import { tempDirs } from '../test/tmp'
import { dayEvents, parseEvents } from './calendar'

const tmp = tempDirs()
afterAll(tmp.removeAll)

test('the calendar app prints one event per line, and a home without it has no calendar', async () => {
  const event = {
    allDay: false,
    attendees: 3,
    calendar: 'Work',
    end: '2026-10-20T10:00:00+09:00',
    myStatus: 'pending',
    start: '2026-10-20T09:30:00+09:00',
    title: 'Standup',
  }
  expect(parseEvents(`${JSON.stringify(event)}\n\n`)).toEqual([event])
  expect(() => parseEvents('{"title":"no times"}')).toThrow()
  expect(await dayEvents(tmp.make('nod-calendar-'), '2026-10-20')).toBeNull()
})
