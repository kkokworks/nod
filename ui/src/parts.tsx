import { Link } from '@tanstack/react-router'
import { type ComponentProps, createContext, type ReactNode, useContext } from 'react'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Decision } from '../../src/ledger'
import type { TaskRow } from './nod.server'

// Briefs, reports and questions are Markdown that workers and people wrote. react-markdown leaves
// raw HTML out and drops unsafe link protocols by default, so this text cannot run in the page.
// An image would load as the page opens, its address carrying whatever a worker put there past
// its sandbox, so it shows as a link to follow by hand; in a link, as a badge is, it is that link's
// text, since an anchor in an anchor would split the link.
const InLink = createContext(false)
const a = ({ node: _, ...props }: ComponentProps<'a'> & ExtraProps) => (
  <InLink.Provider value>
    <a {...props} />
  </InLink.Provider>
)
function Img({ src, alt }: { src?: string; alt?: string }) {
  const text = alt || src
  return useContext(InLink) ? (
    text
  ) : (
    <a href={src} target="_blank" rel="noreferrer">
      {text}
    </a>
  )
}

export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const md = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={
        inline
          ? { a, img: Img, p: ({ children }: { children?: ReactNode }) => children }
          : { a, img: Img }
      }
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

// A task's number after the name the person knows it by, as `nod ls` shows it: its
// retrospective's, else its todo's.
export function TaskId({
  id,
  todoId,
  retroId,
}: {
  id: number
  todoId: number | null
  retroId: number | null
}) {
  const name = retroId !== null ? `r${retroId}` : todoId !== null ? `t${todoId}` : null
  return (
    <span className="side-id">
      {name ?? `#${id}`}
      {name !== null && <small className="task-no">#{id}</small>}
    </span>
  )
}

// A CSS class per status: 'session ended' → 'session_ended'.
export const statusClass = (status: string): string => status.replaceAll(' ', '_')

// A task on one line, to its page: in the sidebar, and on the Done page for the collected ones.
export function TaskItem({ t }: { t: TaskRow }) {
  return (
    <Link
      to="/tasks/$id"
      params={{ id: String(t.id) }}
      className="side-item"
      activeProps={{ className: 'active' }}
    >
      <span className={`dot ${statusClass(t.status)}`} title={t.status} />
      <span className="side-text">
        <TaskId id={t.id} todoId={t.todoId} retroId={t.retroId} /> {t.title}
      </span>
    </Link>
  )
}

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
