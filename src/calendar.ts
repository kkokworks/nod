import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { spawn } from './worker'

// nod reads the person's calendar and never writes it: invites, attendees and rooms stay with the
// calendar service. On macOS, CalendarEvents.app (calendar/build.sh) reads Calendar through
// EventKit, so Google, iCloud and Exchange calendars added to Calendar come along.

// What calendar-events.swift prints for an event.
export const CalendarEvent = z.object({
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  title: z.string(),
  calendar: z.string(),
  location: z.string().optional(),
  url: z.string().optional(),
  attendees: z.number().optional(),
  // `pending`: an invite not answered yet.
  myStatus: z.string().optional(),
})
export type CalendarEvent = z.infer<typeof CalendarEvent>

// Reading takes under a second; the first read waits while macOS asks the person for access.
const TIMEOUT_MS = 60_000

export const calendarBuild = join(import.meta.dirname, '..', 'calendar', 'build.sh')
// The Calendar permission belongs to the app, so build.sh puts it in nod's home, once.
const calendarApp = (home: string): string => join(home, 'CalendarEvents.app')

// The events of `days` days from `from`, or null when there is no calendar app.
export async function readEvents(
  home: string,
  from: string,
  days: number,
): Promise<CalendarEvent[] | null> {
  const app = calendarApp(home)
  if (!existsSync(app)) return null
  // `open` starts it as an app, so macOS asks for the permission on the app; its output comes back
  // through files.
  const dir = mkdtempSync(join(tmpdir(), 'nod-calendar-'))
  try {
    const out = join(dir, 'out')
    const err = join(dir, 'err')
    writeFileSync(out, '')
    writeFileSync(err, '')
    const started = Date.now()
    const opened = await spawn(
      [
        'open',
        '-W',
        '-n',
        '-g',
        '--stdout',
        out,
        '--stderr',
        err,
        '-a',
        app,
        '--args',
        from,
        String(days),
      ],
      undefined,
      { timeoutMs: TIMEOUT_MS },
    )
    if (Date.now() - started >= TIMEOUT_MS) {
      throw new Error(
        `the calendar did not answer in ${TIMEOUT_MS / 1000}s. If macOS is asking whether nod calendar may access Calendar, allow it and run again`,
      )
    }
    if (opened.code !== 0) throw new Error(`could not open ${app}: ${opened.output.trim()}`)
    const failed = readFileSync(err, 'utf8').trim()
    if (failed !== '') throw new Error(failed)
    return parseEvents(readFileSync(out, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const parseEvents = (text: string): CalendarEvent[] =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => CalendarEvent.parse(JSON.parse(line)))
