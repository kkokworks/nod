import { expect, test } from 'bun:test'
import { limitReset } from './limit'

const reset = (text: string, at: string): string | null =>
  limitReset(text, new Date(at))?.toISOString() ?? null

test('a weekly limit resets on the day and at the time it names, in its zone', () => {
  const review =
    "the review exited with 1: You've hit your weekly limit · resets Nov 21 at 7pm (Asia/Seoul)"
  expect(reset(review, '2026-11-18T03:00:00Z')).toBe('2026-11-21T10:00:00.000Z')
  expect(
    reset(
      "You've hit your Opus limit · resets Nov 21 at 7:30pm (Asia/Seoul)",
      '2026-11-18T03:00:00Z',
    ),
  ).toBe('2026-11-21T10:30:00.000Z')
  // After the Error: of an API error, and on a line of its own.
  expect(
    reset("API Error: You've hit your session limit · resets 3pm (UTC)", '2026-11-18T10:00:00Z'),
  ).toBe('2026-11-18T15:00:00.000Z')
  expect(
    reset("Working…\nYou've hit your session limit · resets 3pm (UTC)", '2026-11-18T10:00:00Z'),
  ).toBe('2026-11-18T15:00:00.000Z')
  // As an older ICU joins the day and the time.
  expect(
    reset("You've hit your weekly limit · resets Nov 21, 7pm (Asia/Seoul)", '2026-11-18T03:00:00Z'),
  ).toBe('2026-11-21T10:00:00.000Z')
  // A zone with summer time, the day after it starts.
  expect(
    reset(
      "You've hit your weekly limit · resets Mar 9 at 10am (America/Los_Angeles)",
      '2026-03-05T00:00:00Z',
    ),
  ).toBe('2026-03-09T17:00:00.000Z')
})

test('a 5-hour limit names a time alone: the next one from the failure', () => {
  expect(
    reset("You've hit your session limit · resets 3:30pm (Asia/Seoul)", '2026-11-18T05:00:00Z'),
  ).toBe('2026-11-18T06:30:00.000Z')
  expect(
    reset("You've hit your 5-hour limit · resets 1am (America/New_York)", '2026-11-19T04:00:00Z'),
  ).toBe('2026-11-19T06:00:00.000Z')
  expect(reset("You've hit your session limit · resets 12am (UTC)", '2026-11-18T20:00:00Z')).toBe(
    '2026-11-19T00:00:00.000Z',
  )
  // Recorded just after the time it names, which the line was printed before: that time, not a day on.
  expect(
    reset("You've hit your session limit · resets 7pm (Asia/Seoul)", '2026-11-18T10:00:30Z'),
  ).toBe('2026-11-18T10:00:00.000Z')
  // A weekly limit within a day reads as a time alone too: 23 h 55 min on is that time tomorrow, not
  // one five minutes ago.
  expect(
    reset("You've hit your weekly limit · resets 7pm (Asia/Seoul)", '2026-11-18T10:05:00Z'),
  ).toBe('2026-11-19T10:00:00.000Z')
  // The night summer time ends, 1:30 comes twice: the later one.
  expect(
    reset(
      "You've hit your session limit · resets 1:30am (America/New_York)",
      '2026-11-01T04:00:00Z',
    ),
  ).toBe('2026-11-01T06:30:00.000Z')
})

test('a day without its year is the next such day; one with its year is that day', () => {
  expect(
    reset(
      "You've hit your weekly limit · resets Jan 3 at 7pm (Asia/Seoul)",
      '2026-12-30T00:00:00Z',
    ),
  ).toBe('2027-01-03T10:00:00.000Z')
  expect(
    reset(
      "You've hit your weekly limit · resets Jan 3, 2027 at 7pm (Asia/Seoul)",
      '2026-12-30T00:00:00Z',
    ),
  ).toBe('2027-01-03T10:00:00.000Z')
})

test('text with no reset that reads as a moment gives none', () => {
  const at = '2026-11-18T03:00:00Z'
  for (const text of [
    'the review exited with 1: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare',
    "You've hit your weekly limit",
    "You've hit your monthly spend limit · raise it at https://example.com",
    // A day without a time: when on it is a guess.
    "You've hit your usage credit limit · resets Nov 21 (Asia/Seoul)",
    "You've hit your weekly limit · resets Nov 21 at 7pm",
    "You've hit your weekly limit · resets 13pm (Asia/Seoul)",
    "You've hit your weekly limit · resets 7:75pm (Asia/Seoul)",
    "You've hit your weekly limit · resets Feb 30 at 7pm (Asia/Seoul)",
    "You've hit your weekly limit · resets Foo 3 at 7pm (Asia/Seoul)",
    "You've hit your weekly limit · resets 7pm (Mars/Olympus)",
    // Quoted, not printed: a diff or a report that has the line in it.
    "the review gave no verdict: it prints `You've hit your weekly limit · resets 7pm (Asia/Seoul)` then",
    '+const LIMITED = "You\'ve hit your weekly limit · resets Jan 3, 2099 at 7pm (Asia/Seoul)"',
  ]) {
    expect(reset(text, at)).toBeNull()
  }
})
