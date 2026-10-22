import { expect, test } from 'bun:test'
import { lastComment, toHtml } from './plane'

test('lastComment shows the newest comment with its author name and plain text', () => {
  const names = new Map([['u1', 'Alice']])
  const comments = [
    { actor: 'u2', created_at: '2026-01-02T09:00:00Z', comment_html: '<p>old</p>' },
    { actor: 'u1', created_at: '2026-01-03T09:00:00Z', comment_html: '<p>a &amp; b</p><p>c</p>' },
  ]
  expect(lastComment(comments, names)).toMatch(
    /^ {2}↳ last comment Alice \d\d-\d\d \d\d:\d\d: a & b c$/,
  )
  expect(lastComment([], names)).toBeNull()
})

test('toHtml turns blank-line paragraphs into <p>, line breaks into <br>, and escapes tags', () => {
  expect(toHtml('첫 줄\n둘째 줄\n\n<b>a & b</b>\n')).toBe(
    '<p>첫 줄<br>둘째 줄</p><p>&lt;b&gt;a &amp; b&lt;/b&gt;</p>',
  )
})
