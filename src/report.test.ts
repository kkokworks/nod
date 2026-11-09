import { expect, it } from 'bun:test'
import { parseCaptures, parseReport, parseTells, prText } from './report'

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

it('the pull request title is its # heading, and a status line above it goes, out of the body too', () => {
  for (const heading of ['# ', '  # ']) {
    const report = [
      'The diff and the numbers are the same after the rebase.',
      `${heading}Keep the cache warm across restarts`,
      '',
      '## What changed',
      'The cache is saved on exit.',
      'NOD: done | wrote it',
    ].join('\n')
    expect(prText(report)).toEqual({
      title: 'Keep the cache warm across restarts',
      body: '## What changed\nThe cache is saved on exit.',
    })
  }
  // An empty heading is no title, above the title or with none.
  expect(prText('Same after the rebase.\n# \n# Keep it warm\nBody\nNOD: done | ok')).toEqual({
    title: 'Keep it warm',
    body: 'Body',
  })
  expect(prText('Keep it warm\n#\nBody\nNOD: done | ok')).toEqual({
    title: 'Keep it warm',
    body: '#\nBody',
  })
})

it('a pull request title on the first line stays the title, whatever headings its body has', () => {
  const body = [
    '## What changed',
    'Counts from one.',
    '```sh',
    '# run the tests',
    'bun test',
    '```',
    '# Notes',
    'None.',
  ].join('\n')
  for (const title of ['Fix the off-by-one in a.ts', '# Fix the off-by-one in a.ts']) {
    expect(prText(`${title}\n\n${body}\nNOD: done | wrote it`)).toEqual({
      title: 'Fix the off-by-one in a.ts',
      body,
    })
  }
  // Nor is a shell comment in its code the title, with no section before it.
  const code = '```sh\n# run the tests\nbun test\n```'
  expect(prText(`Fix it\n${code}\nNOD: done | ok`)).toEqual({ title: 'Fix it', body: code })
  // A fence line with more after its marks is code in a fence, as Markdown has it, not its end.
  const nested = '````md\n```sh\n# run the tests\n```\n````'
  expect(prText(`Fix it\n${nested}\nNOD: done | ok`)).toEqual({ title: 'Fix it', body: nested })
  const tagged = '```\ncode\n```sh\n# a comment\n```'
  expect(prText(`Fix it\n${tagged}\nNOD: done | ok`)).toEqual({ title: 'Fix it', body: tagged })
  for (const fenced of ['~~~\n# a comment\n~~~\n## Notes', '```sh\n# never closed\n# Notes']) {
    expect(prText(`Fix it\n${fenced}\nNOD: done | ok`)).toEqual({ title: 'Fix it', body: fenced })
  }
  expect(prText('\n**NOD: done | nothing**')).toBeNull()
})

it('a pull request loses only the lines nod reads: its code and its plain nod: lines stay', () => {
  const code = [
    '```sh',
    'nod: no session hears of the decisions and ends of n1, in no project',
    'NOD: done | an example',
    '**NOD: question | an example**',
    'NOD: in {"title": "an example"}',
    'nod: in not even JSON',
    'NOD: tell n5 an example',
    '```',
  ].join('\n')
  const body = [
    '## What changed',
    code,
    code.replaceAll('```sh', '~~~').replaceAll('```', '~~~'),
    `\`\`\`\`md\n${code}\n\`\`\`\``,
    'nod: no session hears of these any more',
    '`nod: could not run it`',
    '**nod:** a word on the tool',
    'NOD: done, with no bar',
    'NOD: nothing nod reads',
  ].join('\n')
  expect(prText(`# Fix it\n\n${body}\nNOD: done | wrote it`)).toEqual({ title: 'Fix it', body })
  // A plain first line is still a title, as a line nod reads is not.
  expect(prText('nod: count from one\nBody\nNOD: done | ok')).toEqual({
    title: 'nod: count from one',
    body: 'Body',
  })
  const reportLines = [
    'NOD: done | ok',
    'nod: done | ok',
    'NoD: Question | ok',
    'NOD: failed |',
    '**NOD: failed | ok**',
    '**NOD:** done | ok',
    '**NOD: Done** | `ok`',
    '`NOD: done | ok`',
    '  NOD: done | ok',
    'NOD: in {"title": "x"}',
    'nod: in {"title": "x"}',
    '`NOD: in {"title": "x"}`',
    '**NOD:** in {"title": "x"}',
    'NOD: tell n5 hi',
    'nod: tell n5 hi',
    'NOD: tell #5 hi',
    '`NOD:` tell n5 hi',
    '**NOD: tell n5 hi**',
    '```NOD: tell n5 hi```',
  ]
  for (const line of reportLines) {
    expect(prText(`# Fix it\nBody\n${line}\nMore`)).toEqual({ title: 'Fix it', body: 'Body\nMore' })
    expect(prText(`# Fix it\n${code}\n${line}\n${code}\nNOD: done | ok`)).toEqual({
      title: 'Fix it',
      body: `${code}\n${code}`,
    })
  }
  // Markdown runs a fence never closed to the end, over the report: it keeps nothing back.
  const reals = 'NOD: in {"title": "real"}\nNOD: tell n6 real\nNOD: done | real'
  const closedThenOpen = '```\nNOD: tell n5 example\n```\nwords\n~~~\n'
  for (const open of ['```sh\nbun test\n', '```\ncode\n```\nwords\n~~~\n', closedThenOpen]) {
    expect(prText(`Fix it\n${open}${reals}`)?.body).toBe(open.trim())
  }
  // With the last status in code, the report is wrapped, and its lines do not go out, even under an
  // older status out of code.
  for (const status of ['done', 'question', 'failed']) {
    const wrapped = `Words\n\`\`\`\nNOD: in {"title": "real"}\nNOD: ${status} | wrapped\n\`\`\``
    expect(prText(`# Fix it\n${wrapped}`)?.body).toBe('Words\n```\n```')
    expect(prText(`# Fix it\nNOD: question | older\n${wrapped}`)?.body).toBe('Words\n```\n```')
  }
  // A long line reads at once: parseReport's pattern takes seconds over these spaces.
  const spaced = `NOD: done |${' '.repeat(100_000)}a\rb`
  expect(prText(`# Fix it\nBody\n${spaced}`)).toEqual({ title: 'Fix it', body: 'Body' })
})
