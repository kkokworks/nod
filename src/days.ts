// Days and times as the person writes them: local, `YYYY-MM-DD`, with ` HH:MM` where a time is
// allowed. Kept as text, so they sort and compare as strings and a time set for 17:00 stays 17:00
// wherever the clock is.

export const REPEATS = ['daily', 'weekly', 'monthly'] as const
export type Repeat = (typeof REPEATS)[number]
// The dates a repeating todo's next one moves on.
export type Dates = { due: string | null; scheduled: string | null; start: string | null }

export const localDay = (d: Date): string => d.toLocaleDateString('sv-SE')
export const dayOf = (when: string): string => when.slice(0, 10)

// `today`, `tomorrow` or `YYYY-MM-DD`, then ` HH:MM` when `time` allows one.
export function parseWhen(text: string, today: string, time: boolean): string {
  const m = /^(today|tomorrow|\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text.trim())
  const word = m?.[1]
  if (m === null || word === undefined) {
    const withTime = time ? ', then HH:MM if it has a time' : ''
    throw new Error(`not a day: ${text} (write YYYY-MM-DD, today or tomorrow${withTime})`)
  }
  const day = word === 'today' ? today : word === 'tomorrow' ? addDays(today, 1) : word
  if (addDays(day, 0) !== day) throw new Error(`no such day: ${day}`)
  const [, , hh, mm] = m
  if (hh === undefined || mm === undefined) return day
  if (!time) throw new Error(`${text.trim()}: a day only, without a time`)
  if (Number(hh) > 23 || Number(mm) > 59) throw new Error(`no such time: ${hh}:${mm}`)
  return `${day} ${hh}:${mm}`
}

// Moves the dates on by the same whole periods from the schedule, not from when it was done, until
// the earliest is after today: one done late does not leave its next one overdue already. A time
// stays as it was.
export function nextDates(dates: Dates, repeat: Repeat, today: string): Dates {
  const first = [dates.due, dates.scheduled, dates.start]
    .filter((d) => d !== null)
    .map(dayOf)
    .sort()[0]
  if (first === undefined) throw new Error('a repeating todo needs a date to move on')
  let periods = 1
  while (step(first, repeat, periods) <= today) periods += 1
  const move = (when: string | null) =>
    when === null ? null : `${step(dayOf(when), repeat, periods)}${when.slice(10)}`
  return { due: move(dates.due), scheduled: move(dates.scheduled), start: move(dates.start) }
}

function step(day: string, repeat: Repeat, periods: number): string {
  if (repeat === 'daily') return addDays(day, periods)
  if (repeat === 'weekly') return addDays(day, 7 * periods)
  // The 31st moves to the last day of a shorter month.
  const [y, m, d] = day.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) throw new Error(`not a day: ${day}`)
  const last = new Date(Date.UTC(y, m + periods, 0)).getUTCDate()
  return utcDay(new Date(Date.UTC(y, m - 1 + periods, Math.min(d, last))))
}

// In UTC, where every day is 24 hours long.
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) throw new Error(`not a day: ${day}`)
  return utcDay(new Date(Date.UTC(y, m - 1, d + n)))
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00Z`) - Date.parse(`${from}T00:00Z`)) / 86_400_000)

const utcDay = (d: Date): string => d.toISOString().slice(0, 10)
