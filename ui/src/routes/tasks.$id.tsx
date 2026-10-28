import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import type { Decision } from '../../../src/ledger'
import { int } from '../input'
import type { Message } from '../nod.server'
import { detail, send } from '../nod.server'
import { DecisionCard, duration, localTime, Markdown, Status, statusClass, Url } from '../parts'
import { Screen } from '../terminal'

const getDetail = createServerFn({ method: 'GET' })
  .validator((id: number) => int(id, 'task id'))
  .handler(({ data }) => detail(data))

const sendMessage = createServerFn({ method: 'POST' })
  .validator((m: Message): Message => {
    if (!Number.isInteger(m.taskId)) throw new Error('task id must be an integer')
    if (m.decisionId !== null && !Number.isInteger(m.decisionId)) {
      throw new Error('decision id must be an integer or null')
    }
    if (typeof m.text !== 'string' || m.text.trim() === '') throw new Error('empty message')
    return { taskId: m.taskId, decisionId: m.decisionId, text: m.text.trim() }
  })
  .handler(({ data }) => send(data))

export const Route = createFileRoute('/tasks/$id')({
  // An address no task has, its number not one in digits (1e3, 0x10) or no task's, is not found.
  loader: async ({ params }) => {
    const page = /^\d+$/.test(params.id) ? await getDetail({ data: Number(params.id) }) : null
    if (page === null) throw notFound()
    return page
  },
  component: TaskPage,
})

// About what fits in the title's three lines; a longer first line also gets "Full brief".
const TITLE_CHARS = 120

const KIND_ICON = {
  start: '▶',
  retry: '↻',
  answer: '↩',
  resume: '⏵',
  followup: '✎',
  land: '⤴',
} as const

function TaskPage() {
  const { task, status, links, after, attempts, decisions, report, place, retro, screen, root } =
    Route.useLoaderData()
  // The brief's first line is the title; the whole brief folds away, as it can run to pages.
  const nl = task.brief.indexOf('\n')
  const title = nl === -1 ? task.brief : task.brief.slice(0, nl)
  // One that failed before its worker started has a failed start but no conversation to message.
  const canSend = task.collectedAt === null && task.workspace !== null
  // A session that is gone has nothing to show, so the page keeps its width for the turns and the
  // result; the box to message the worker stays while the task can be resumed.
  const aside = screen !== null || canSend
  const open = decisions.find((d) => d.answer === null)
  return (
    <div className={aside ? 'task-layout' : 'task-layout solo'}>
      <div className="page">
        {/* Where the task sits in the person's lists. */}
        {(place.project !== null || place.todo !== null) && (
          <div className="crumbs">
            {place.project !== null && <Link to="/projects">{place.project.title}</Link>}
            {place.todo !== null && (
              <Link to="/todos/$id" params={{ id: String(place.todo.id) }}>
                t{place.todo.id} {place.todo.title}
              </Link>
            )}
          </div>
        )}
        <div className="task-meta">
          <Status status={status} />
          <span className="muted">
            #{task.id} · {localTime(task.createdAt)}
            {task.finishedAt !== null && ` · took ${duration(task.createdAt, task.finishedAt)}`}
          </span>
        </div>
        <h1 className="title task-title">
          <Markdown text={title} inline />
        </h1>
        {(nl !== -1 || title.length > TITLE_CHARS) && (
          <details className="brief">
            <summary>Full brief</summary>
            <Markdown text={task.brief} />
          </details>
        )}

        <div className="tags">
          {task.issue !== null && <span className="tag">{task.issue}</span>}
          {task.repo !== null && (
            <span className="tag">
              <code>{task.repo.split('/').at(-1)}</code> · <code>{task.branch}</code>
            </span>
          )}
          {task.checkCmd !== null && (
            <span className="tag">
              check <code>{task.checkCmd}</code>
            </span>
          )}
          {task.triggerId !== null && <span className="tag">trigger #{task.triggerId}</span>}
          {root !== null ? (
            <span
              className="tag"
              title={`The project session whose task it is, and how to reopen it${root.addedFrom === null ? '' : `; added from session ${root.addedFrom}`}`}
            >
              root{' '}
              <Link to="/projects">
                p{root.project.id} {root.project.title}
              </Link>{' '}
              <code>{root.command}</code>
            </span>
          ) : (
            task.rootSession !== null && (
              <span className="tag" title="The Claude session that added it: claude --resume <id>">
                root <code>{task.rootSession}</code>
              </span>
            )
          )}
          {retro !== null && (
            <span className="tag">
              r{retro.id} of{' '}
              <Link to="/tasks/$id" params={{ id: String(retro.ofTaskId) }}>
                #{retro.ofTaskId}
              </Link>
              {retro.outcome !== null && `, ${retro.outcome}`}
            </span>
          )}
          {retro?.rules.map((r) => (
            <span key={r.id} className="tag" title={r.text}>
              rule {r.id} {r.state}
              {r.edited && ', edited'}
            </span>
          ))}
          {after.map((a) => (
            <span key={a.id} className="tag">
              after{' '}
              <Link to="/tasks/$id" params={{ id: String(a.id) }}>
                #{a.id}
              </Link>{' '}
              {a.status}
            </span>
          ))}
          {task.collectedAt !== null && <span className="tag">collected</span>}
        </div>

        {task.error !== null && <div className="banner">{task.error}</div>}

        <h2 className="section">
          Turns<span className="count">{attempts.length}</span>
        </h2>
        <ol className="timeline">
          {attempts.map((a) => (
            <li key={a.id}>
              <div className="step">
                <span className={`step-icon ${statusClass(a.outcome ?? 'running')}`}>
                  {KIND_ICON[a.kind]}
                </span>
                <div className="step-body">
                  <div className="step-head">
                    <strong>{a.kind}</strong>
                    {/* The icon carries a turn that went well; only the rest get a word. */}
                    {a.outcome !== 'succeeded' && <Status status={a.outcome ?? 'running'} />}
                    {a.checkResult === 'failed' && (
                      <span className="chip failed">check failed</span>
                    )}
                    {a.checkResult === 'passed' && <span className="muted small">✓ check</span>}
                    <span className="muted step-time">
                      {a.finishedAt === null ? 'running' : duration(a.startedAt, a.finishedAt)}
                    </span>
                  </div>
                  {(a.error ?? a.summary) !== null && (
                    <div className="prose">{a.error ?? a.summary}</div>
                  )}
                  {a.checkResult === 'failed' && a.checkOutput !== null && (
                    <details>
                      <summary className="muted">check output</summary>
                      <pre>{a.checkOutput}</pre>
                    </details>
                  )}
                </div>
              </div>
              {decisions
                .filter((d) => d.attemptId === a.id)
                .map((d) => (
                  <DecisionCard key={d.id} d={d} />
                ))}
            </li>
          ))}
        </ol>

        {(report !== null || links.length > 0) && (
          <>
            <h2 className="section">Result</h2>
            <div className="card">
              {links.map((url) => (
                <div key={url} className="link">
                  <Url url={url} />
                </div>
              ))}
              {report !== null && <Markdown text={report} />}
            </div>
          </>
        )}
      </div>

      {aside && (
        <aside className="computer">
          {screen === null ? (
            <div className="idle-note">
              <span className="dot" /> No live session
              {/* A finished task's terminal closes after a while, and a message starts it again,
                  but for a retrospective that ended. FINISHED of the ledger, which the page cannot
                  import without the ledger. */}
              {task.collectedAt === null &&
                (['succeeded', 'cancelled', 'error'].includes(task.status) ? (
                  retro?.outcome == null && ' · a message goes on in the same conversation'
                ) : (
                  <>
                    {' · '}
                    <code>nod resume {task.id}</code> reopens it
                  </>
                ))}
            </div>
          ) : (
            <Screen key={`screen-${task.id}`} id={task.id} screen={screen} />
          )}
          {/* A live session is typed into on its screen, decisions too; with none, this box is the
              way to the worker. Keyed, as moving to another task keeps this page: what was
              written does not go along. */}
          {canSend && screen === null && <Composer key={task.id} taskId={task.id} open={open} />}
        </aside>
      )}
    </div>
  )
}

// These decisions take yes or no; for trust and rule anything but yes ends the task, and for land
// it stops landing the task, so they get buttons instead of a text box.
const YES_OR_NO = new Set(['permission', 'trust', 'rule', 'land'])

function Composer({ taskId, open }: { taskId: number; open: Decision | undefined }) {
  const router = useRouter()
  const [text, setText] = useState('')
  // The decision the text was begun for, or null for a message. The page reloads under the person
  // as they write, so a decision that opens or closes meanwhile must not take the text.
  const [aim, setAim] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = open?.id ?? null

  const submit = async (reply: string, decisionId: number | null, sent = () => {}) => {
    setBusy(true)
    setError(null)
    try {
      await sendMessage({ data: { taskId, decisionId, text: reply } })
      sent()
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const write = (value: string) => {
    if (text === '') setAim(now)
    setText(value)
  }
  // Sends the text to what it was begun for; when that changed, says so, and sends to what is open
  // now only when asked again.
  const sendText = () => {
    // ⌘↵ is not a disabled button: pressed again while the message is on its way, it waits.
    if (busy || text.trim() === '') return
    if (aim !== now) {
      setAim(now)
      setError(
        now === null
          ? `Decision #${aim} closed while you wrote. Send again to message the worker.`
          : `Decision #${now} opened while you wrote. Send again to answer it.`,
      )
      return
    }
    void submit(text, aim, () => setText(''))
  }
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        sendText()
      }}
    >
      {open !== undefined && (
        <div className="composer-label">
          Answering decision #{open.id} · {open.reason.replace('_', ' ')}
        </div>
      )}
      {open !== undefined && YES_OR_NO.has(open.reason) ? (
        <div className="composer-actions">
          <button type="button" disabled={busy} onClick={() => void submit('yes', open.id)}>
            Yes
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void submit('no', open.id)}
          >
            {open.reason === 'permission' ? 'No' : 'No — end the task'}
          </button>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            rows={3}
            placeholder={open === undefined ? 'Message the worker…' : 'Your answer…'}
            onChange={(e) => write(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter sends; plain Enter stays a newline, and is safe mid-IME composition.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault()
                sendText()
              }
            }}
          />
          <div className="composer-actions">
            <span className="muted small">⌘↵ to send</span>
            <button type="submit" disabled={busy || text.trim() === ''}>
              {open === undefined ? 'Send' : 'Answer'}
            </button>
          </div>
        </>
      )}
      {error !== null && <div className="banner">{error}</div>}
    </form>
  )
}
