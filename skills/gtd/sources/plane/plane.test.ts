import { expect, test } from 'bun:test'
import { toHtml } from './plane'

test('toHtml turns blank-line paragraphs into <p>, line breaks into <br>, and escapes tags', () => {
  expect(toHtml('첫 줄\n둘째 줄\n\n<b>a & b</b>\n')).toBe(
    '<p>첫 줄<br>둘째 줄</p><p>&lt;b&gt;a &amp; b&lt;/b&gt;</p>',
  )
})
