import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Decision } from '../../src/ledger'

// Briefs, reports and questions are Markdown that workers and people wrote. react-markdown leaves
// raw HTML out and drops unsafe link protocols by default, so this text cannot run in the page.
export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const md = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={inline ? { p: ({ children }: { children?: ReactNode }) => children } : {}}
    >
      {text}
    </ReactMarkdown>
  )
  // A span inline, since a div cannot sit inside a heading.
  return inline ? <span className="md-inline">{md}</span> : <div className="md">{md}</div>
}

// Links come from the ledger, so only web addresses become anchors.
export function Url({ url }: { url: string }) {
  return /^https?:\/\//.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer">
      {url.replace(/^https?:\/\//, '')}
    </a>
  ) : (
    <span>{url}</span>
  )
}

// A task's number after its todo's, when it does one: the person names their work by the todo.
export function TaskId({ id, todoId }: { id: number; todoId: number | null }) {
  return todoId === null ? (
    <span className="side-id">#{id}</span>
  ) : (
    <span className="side-id">
      t{todoId}
      <small className="task-no">#{id}</small>
    </span>
  )
}

// A CSS class per status: 'session ended' → 'session_ended'.
export const statusClass = (status: string): string => status.replaceAll(' ', '_')

export function Status({ status }: { status: string }) {
  return (
    <span className={`chip ${statusClass(status)}`}>
      <span className="dot" />
      {status.replace('_', ' ')}
    </span>
  )
}

// A decision on one card; `head` puts its task above it, where the card stands alone.
export function DecisionCard({ d, head }: { d: Decision; head?: ReactNode }) {
  return (
    <div className={`decision ${d.answer === null ? 'open' : 'answered'}`}>
      {head}
      <div className="decision-head">
        <span className="decision-reason">{d.reason.replace('_', ' ')}</span>
        <span className="muted">decision #{d.id}</span>
        {d.answeredAt !== null && (
          <span className="muted">· answered after {duration(d.createdAt, d.answeredAt)}</span>
        )}
      </div>
      <Markdown text={d.question} />
      {d.answer === null ? (
        <div className="hint">
          <code>nod {d.id} &lt;answer&gt;</code> or <code>nod drop {d.id}</code>
        </div>
      ) : (
        <div className="answer">{d.answer}</div>
      )}
    </div>
  )
}

export function duration(from: string, to: string): string {
  const secs = Math.round((Date.parse(to) - Date.parse(from)) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

// A fixed format, not toLocaleString or "3m ago": the server and the browser must render the same
// text, or hydration fails.
export function localTime(at: string): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
