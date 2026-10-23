import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
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
})
