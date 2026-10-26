import { Link, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useRef, useState } from 'react'
import type { Found } from '../../src/todos'
import { text } from './input'
import { find } from './nod.server'

const findRef = createServerFn({ method: 'GET' })
  .validator((ref: string) => text(ref, 'ref'))
  .handler(({ data }) => find(data))

// The page that shows what was found: a todo's own, a project's card on Projects, else the page of
// the task it is or is on.
const to = (f: Found) =>
  f.kind === 'todo'
    ? ({ to: '/todos/$id', params: { id: String(f.id) } } as const)
    : f.kind === 'project'
      ? ({ to: '/projects', hash: f.ref } as const)
      : ({ to: '/tasks/$id', params: { id: String(f.taskId) } } as const)

// `nod search` in the sidebar: Enter goes to the one match, or lists them all to pick from.
export function Search() {
  const navigate = useNavigate()
  const [ref, setRef] = useState('')
  // The last search and what it found; null before one, and once one was followed.
  const [shown, setShown] = useState<{ ref: string; found: Found[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Only the latest search shows, should an earlier one come back after it.
  const latest = useRef(0)
  const followed = () => {
    setRef('')
    setShown(null)
  }
  return (
    <form
      className="side-search"
      onSubmit={(e) => {
        e.preventDefault()
        const asked = ref.trim()
        if (asked === '') return
        latest.current += 1
        const n = latest.current
        setError(null)
        setShown(null)
        findRef({ data: asked }).then(
          (found) => {
            if (n !== latest.current) return
            const [one, ...more] = found
            if (one === undefined || more.length > 0) {
              setShown({ ref: asked, found })
              return
            }
            followed()
            void navigate(to(one))
          },
          (err: unknown) => {
            if (n === latest.current) setError(err instanceof Error ? err.message : String(err))
          },
        )
      }}
    >
      <input
        type="search"
        value={ref}
        placeholder="t12, #34, r5, p3, 7…"
        aria-label="Find by number"
        onChange={(e) => setRef(e.target.value)}
      />
      {shown?.found.length === 0 && <div className="side-more">No match for {shown.ref}</div>}
      {shown?.found.map((f) => (
        <Link key={`${f.kind}${f.id}`} {...to(f)} className="side-item" onClick={followed}>
          <span className="side-text">
            <span className="side-id">{f.ref}</span> {f.kind} · {f.status} · {f.title}
          </span>
        </Link>
      ))}
      {error !== null && <div className="banner">{error}</div>}
    </form>
  )
}
