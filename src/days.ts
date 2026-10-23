// Days and times as the person writes them: local, `YYYY-MM-DD`, with ` HH:MM` where a time is
// allowed. Kept as text, so they sort and compare as strings and a time set for 17:00 stays 17:00
// wherever the clock is.

export const REPEATS = ['daily', 'weekly', 'monthly'] as const
export type Repeat = (typeof REPEATS)[number]
// The dates a repeating todo's next one moves on.
export type Dates = { due: string | null; scheduled: string | null; start: string | null }

export const localDay = (d: Date): string => d.toLocaleDateString('sv-SE')
// To the minute, as the lists and notes show a moment.
export const localTime = (d: Date): string => d.toLocaleString('sv-SE').slice(0, 16)
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
// stays as it was. `before`: the dates of the series' earlier todos, latest first, so a monthly one
// keeps its day (seriesDay).
export function nextDates(
  dates: Dates,
  repeat: Repeat,
  today: string,
  before: Dates[] = [],
): Dates {
  const from = (k: keyof Dates): string | null => {
    const when = dates[k]
    if (when === null || repeat !== 'monthly') return when
    return seriesDay(
      when,
      before.map((b) => b[k]),
    )
  }
  const kept: Dates = { due: from('due'), scheduled: from('scheduled'), start: from('start') }
  const first = [kept.due, kept.scheduled, kept.start]
    .filter((d) => d !== null)
    .map(dayOf)
    .sort()[0]
  if (first === undefined) throw new Error('a repeating todo needs a date to move on')
  let periods = 1
  while (step(first, repeat, periods) <= today) periods += 1
  const move = (when: string | null) =>
    when === null ? null : `${step(dayOf(when), repeat, periods)}${when.slice(10)}`
  return { due: move(kept.due), scheduled: move(kept.scheduled), start: move(kept.start) }
}

// A monthly date on the last day of a short month may stand for a later day the series was set on,
// moved there because the month has no such day: the same date of the todo before tells, latest
// first, and may stand for one in turn. The day comes back as the series has it, so `2026-02-28`
// after `2026-01-31` is `2026-02-31`, which step reads as the last day of whatever month it moves to.
function seriesDay(when: string, before: (string | null)[]): string {
  let day = Number(when.slice(8, 10))
  let at = when
  for (const earlier of before) {
    // On a day before its month's last, or on the 31st, nothing was moved.
    if (earlier === null || !addDays(dayOf(at), 1).endsWith('-01') || at.slice(8, 10) === '31') {
      break
    }
    day = Math.max(day, Number(earlier.slice(8, 10)))
    at = earlier
  }
  return `${when.slice(0, 8)}${String(day).padStart(2, '0')}${when.slice(10)}`
}

function step(day: string, repeat: Repeat, periods: number): string {
  if (repeat === 'daily') return addDays(day, periods)
  if (repeat === 'weekly') return addDays(day, 7 * periods)
  // The 31st moves to the last day of a shorter month; so does a day that only the series has
  // (seriesDay).
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

// Friday and the weekend lead to Monday.
export function nextWorkday(day: string): string {
  const weekday = new Date(`${day}T00:00Z`).getUTCDay()
  return addDays(day, weekday === 5 ? 3 : weekday === 6 ? 2 : 1)
}
