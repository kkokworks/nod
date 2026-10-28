import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { int } from '../input'
import { detail } from '../nod.server'
import { Screen } from '../parts'

const getDetail = createServerFn({ method: 'GET' })
  .validator((id: number) => int(id, 'task id'))
  .handler(({ data }) => detail(data))

// The worker's terminal. The desktop app opens this address in a window of its own, a live
// terminal to type into (desktop/src/terminal.html), so its main window never shows this page. A
// browser, which cannot, gets what the terminal shows now, as the task's page has it.
export const Route = createFileRoute('/terminal/$id')({
  // As the task's page: a number in digits that a task has, else not found.
  loader: async ({ params }) => {
    const page = /^\d+$/.test(params.id) ? await getDetail({ data: Number(params.id) }) : null
    if (page === null) throw notFound()
    return page
  },
  component: TerminalPage,
})

function TerminalPage() {
  const { task, screen } = Route.useLoaderData()
  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/tasks/$id" params={{ id: String(task.id) }}>
          #{task.id} {task.brief.split('\n')[0]}
        </Link>
      </div>
      <h1 className="title">Terminal</h1>
      <p className="subtitle">
        A browser shows the worker's screen as it was a moment ago. To type into it, open it from
        the desktop app, or run <code>nod attach {task.id}</code> in a shell.
      </p>
      {screen === null ? (
        <div className="idle-note">
          <span className="dot" /> No live session
        </div>
      ) : (
        <Screen id={task.id} screen={screen} />
      )}
    </div>
  )
}
