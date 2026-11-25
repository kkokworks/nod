import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { reportStart } from '../../src/report'
import { Markdown } from './parts'

// A worker writes its questions and reports. An image there would load as the page opens, past
// the worker's sandbox, with whatever the worker put in its address.
test('an image in Markdown shows as a link, and the page loads nothing', () => {
  for (const inline of [false, true]) {
    const html = renderToString(
      <Markdown text="see ![chart](https://example.com/p.png?d=secret) here" inline={inline} />,
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('preload')
    expect(html).toContain('<a href="https://example.com/p.png?d=secret"')
    expect(html).toContain('>chart</a>')
  }
  // With no words for it, the address is the link's text.
  expect(renderToString(<Markdown text="![](https://example.com/p.png)" />)).toContain(
    '>https://example.com/p.png</a>',
  )
  // In a link, as a badge is, it is the link's text: an anchor in an anchor would split the link.
  const badge = renderToString(
    <Markdown text="[![CI](https://example.com/b.svg)](https://example.com/ci)" />,
  )
  expect(badge).toContain('<a href="https://example.com/ci">CI</a>')
  expect(badge.match(/<a /g)).toHaveLength(1)
})

// A long question is cut to its start, which may be in a code block.
test('a question cut in a code block keeps its report line a paragraph, with a link to all of it', () => {
  const at = 'http://127.0.0.1:4800/tasks/7'
  // On its own, and in a list, as indented as the item's words.
  for (const [before, indent] of [
    ['', ''],
    ['1. A:\n', '   '],
  ] as const) {
    const code = `${indent}echo hi\n`.repeat(500)
    const report = `Which?\n\n${before}${indent}\`\`\`sh\n${code}${indent}\`\`\`\nNOD: question | A or B?`
    const html = renderToString(<Markdown text={reportStart(report, 2000, `nod show n7, ${at}`)} />)
    expect(html).toStartWith('<div class="md"><p>Which?</p>')
    expect(html).toContain(`<a href="${at}">${at}</a></p>`)
    expect(html).toContain('<p>NOD: question | A or B?</p>')
  }
})
