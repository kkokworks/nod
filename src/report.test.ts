import { expect, it } from 'bun:test'
import { parseCaptures, parseReport, parseTells } from './report'

it('the report line is read from the end, through Markdown emphasis', () => {
  expect(parseReport('NOD: question | old\nmore\n**NOD: Done** | `shipped`')).toEqual({
    status: 'done',
    text: 'shipped',
  })
  expect(parseReport('no report here')).toBeNull()
})

it('a report may ask for at most 50 captures, each with JSON nod can read', () => {
  const line = (n: number) => `NOD: in {"title": "t${n}"}`
  const many = Array.from({ length: 51 }, (_, n) => line(n)).join('\n')
  expect(parseCaptures(many)).toEqual({ error: '51 `NOD: in` lines; report at most 50' })
  expect(parseCaptures('NOD: in {"key": "k", "title": "x"}\nNOD: done | ok')).toMatchObject({
    error: expect.stringContaining('a key needs its source'),
  })
  expect(parseCaptures('NOD: in title only')).toMatchObject({
    error: expect.stringContaining('NOD: in title only'),
  })
  expect(parseCaptures('**NOD: done | nothing to capture**')).toEqual({ captures: [] })
})

it('a report says what to tell other tasks in NOD: tell lines, which nod reads or sends back', () => {
  const report = [
    'Found two.',
    'NOD: tell n85 1) a.ts:3 is off by one 2) no test for it',
    '`NOD: tell #9 look again`',
    'NOD: done | reviewed',
  ].join('\n')
  expect(parseTells(report)).toEqual({
    tells: [
      { to: 85, text: '1) a.ts:3 is off by one 2) no test for it' },
      { to: 9, text: 'look again' },
    ],
  })
  expect(parseTells('Telling nobody.\nNOD: done | nothing to tell')).toEqual({ tells: [] })
  // Workers often bold their report lines, or their `NOD:`; what is said keeps its own marks.
  const said = (line: string) => parseTells(`${line}\nNOD: done | ok`)
  expect(said('**NOD: tell n5 look again**')).toEqual({ tells: [{ to: 5, text: 'look again' }] })
  expect(said('**NOD:** tell n5 look again')).toEqual({ tells: [{ to: 5, text: 'look again' }] })
  // `#<task>`, as workers wrote it before `n`, still reads.
  expect(said('**NOD:** tell #5 look again')).toEqual({ tells: [{ to: 5, text: 'look again' }] })
  expect(said('NOD: tell n5 the glob should be src/**')).toEqual({
    tells: [{ to: 5, text: 'the glob should be src/**' }],
  })
  expect(said('`NOD: tell n5 rename it to `foo``')).toEqual({
    tells: [{ to: 5, text: 'rename it to `foo`' }],
  })
  const kept = (line: string, text: string) =>
    expect(said(line)).toEqual({ tells: [{ to: 5, text }] })
  kept('**NOD:** tell n5 this is **important**', 'this is **important**')
  kept('*NOD:* tell n5 look at *this*', 'look at *this*')
  kept('`NOD:` tell n5 hi', 'hi')
  kept('**NOD: tell n5 look at *this***', 'look at *this*')
  // A capture with unmatched ticks around it still goes in, as it did before tells.
  expect(parseCaptures('``NOD: in {"title": "x"}`\nNOD: done | ok')).toEqual({
    captures: [{ title: 'x' }],
  })
  // A long line of marks reads at once: a pattern that backtracks took minutes on it.
  expect(said(`${'`'.repeat(100_000)}x`)).toEqual({ tells: [] })
  kept(`${'`'.repeat(50_000)}NOD: tell n5 hi${'`'.repeat(50_000)}`, 'hi')
  const bads = ['NOD: tell 85 no letter', 'NOD: tell n85', 'NOD: tell #85', 'NOD: tell nx hi']
  for (const bad of [...bads, 'NOD: tell #x hi', 'NOD: tell t5 hi']) {
    expect(parseTells(`${bad}\nNOD: done | ok`)).toMatchObject({
      error: expect.stringContaining(bad),
    })
  }
})
