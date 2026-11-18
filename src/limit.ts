// When a Claude usage limit that stopped a task resets, as Claude Code prints it: `You've hit your
// weekly limit · resets Nov 21 at 7pm (Asia/Seoul)`, a time alone within a day (`· resets 3:30pm
// (Asia/Seoul)`), a year once it is another (`Jan 3, 2027 at 7pm`). Measured in 2.1.327's binary:
// `You've hit your ${limit} · resets ${time}`, the time formatted in en-US in the zone it names
// (dM), the minutes left out on the hour and the seconds always. The 5-hour limit reads `session
// limit` or `5-hour limit`. Only as Claude Code prints it, starting a line or after the `: ` of what
// nod puts before it (`the review exited with 1: `): one quoted in other words (a diff the review
// shows, say) is no limit of this task's.
const RESET =
  /(?:^|: )You['’]ve hit your [^·\n]+? · resets (?:([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?(?: at|,) )?(\d{1,2})(?::(\d{2}))? ?([ap]m) \(([\w+\-/]+)\)/im
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// How long before `at` Claude Code may have printed the line: a reset it names before then is the
// next one of that day or time.
const PRINTED_WITHIN_MS = 10 * 60_000

// The moment the limit resets, read from `text` that a failure at `at` left; null for text with no
// such line, or one whose time or zone is no moment (13pm, Feb 30, a zone that does not exist). A
// date or time without its year or day is the next one from `at`.
export function limitReset(text: string, at: Date): Date | null {
  const m = RESET.exec(text)
  if (m === null) return null
  const [, mon, day, year, hour, minute = '0', half, timeZone = ''] = m
  const h = Number(hour)
  if (h < 1 || h > 12) return null
  const time = {
    hour: (h % 12) + (half?.toLowerCase() === 'pm' ? 12 : 0),
    minute: Number(minute),
  }
  try {
    const from = Temporal.Instant.fromEpochMilliseconds(
      at.getTime() - PRINTED_WITHIN_MS,
    ).toZonedDateTimeISO(timeZone)
    const on = (y: number, month: number, d: number): Temporal.ZonedDateTime =>
      Temporal.ZonedDateTime.from(
        { timeZone, year: y, month, day: d, ...time },
        { overflow: 'reject' },
      )
    const after = (z: Temporal.ZonedDateTime): boolean =>
      Temporal.ZonedDateTime.compare(z, from) >= 0
    let reset: Temporal.ZonedDateTime
    if (mon === undefined) {
      reset = on(from.year, from.month, from.day)
      if (!after(reset)) reset = reset.add({ days: 1 })
    } else {
      const month = MONTHS.indexOf(mon.toLowerCase()) + 1
      if (month === 0) return null
      reset = on(year === undefined ? from.year : Number(year), month, Number(day))
      if (year === undefined && !after(reset)) reset = on(from.year + 1, month, Number(day))
    }
    return new Date(reset.epochMilliseconds)
  } catch {
    return null
  }
}
