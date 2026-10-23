import { createFileRoute, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { changeProject, getProjects, newProject } from '../todo-fns'
import { Section, TodoRow, useChange } from '../todo-parts'
import type { ProjectsPage } from '../todos.server'

export const Route = createFileRoute('/projects')({
  loader: () => getProjects(),
  component: ProjectsView,
})

// `nod project`: each project with its open todos. One with no next action says so; an open
// decision on one of its tasks counts as one.
function ProjectsView() {
  const { today, projects } = Route.useLoaderData()
  const active = projects.filter((p) => p.status === 'active')
  const someday = projects.filter((p) => p.status === 'someday')
  return (
    <div className="page">
      <h1 className="title">Projects</h1>
      <p className="subtitle">
        {active.length} active · {active.filter((p) => p.next === 0).length} with no next action
      </p>
      <AddProject />
      {active.map((p) => (
        <ProjectCard key={p.id} p={p} today={today} />
      ))}
      {someday.length > 0 && (
        <Section title="Someday" count={someday.length} bare>
          {someday.map((p) => (
            <ProjectCard key={p.id} p={p} today={today} />
          ))}
        </Section>
      )}
    </div>
  )
}

function ProjectCard({ p, today }: { p: ProjectsPage['projects'][number]; today: string }) {
  const { busy, error, run } = useChange()
  // A link to one project (Focus's "No next action") lands on its card and marks it.
  const picked = useLocation({ select: (l) => l.hash === `p${p.id}` })
  const status = (s: string) =>
    run(() => changeProject({ data: { id: p.id, edit: { status: s } } }))
  const stuck = p.status === 'active' && p.next === 0
  return (
    <div className={picked ? 'card picked' : 'card'} id={`p${p.id}`}>
      <div className="card-head">
        <span className="side-id">p{p.id}</span>
        <strong>{p.title}</strong>
        <span className="muted">
          {p.next} next · {p.waiting} waiting
        </span>
        {stuck && <span className="warn-text">no next action</span>}
        <span className="todo-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void status(p.status === 'active' ? 'someday' : 'active')}
          >
            {p.status === 'active' ? 'Someday' : 'Activate'}
          </button>
          <button type="button" disabled={busy} onClick={() => void status('done')}>
            Done
          </button>
        </span>
      </div>
      {p.outcome !== null && <div className="muted small">{p.outcome}</div>}
      {p.todos.map((t) => (
        <TodoRow key={t.id} t={t} today={today} usual="next" />
      ))}
      {error !== null && <div className="banner">{error}</div>}
    </div>
  )
}

function AddProject() {
  const [title, setTitle] = useState('')
  const [outcome, setOutcome] = useState('')
  const { busy, error, run } = useChange()
  return (
    <form
      className="composer capture"
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim() === '') return
        void run(() => newProject({ data: { title: title.trim(), outcome } })).then((ok) => {
          if (!ok) return
          setTitle('')
          setOutcome('')
        })
      }}
    >
      <input value={title} placeholder="New project…" onChange={(e) => setTitle(e.target.value)} />
      <input
        value={outcome}
        placeholder="What done looks like"
        onChange={(e) => setOutcome(e.target.value)}
      />
      <button type="submit" disabled={busy || title.trim() === ''}>
        Add
      </button>
      {error !== null && <div className="banner">{error}</div>}
    </form>
  )
}
