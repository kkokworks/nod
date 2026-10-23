import { createFileRoute, Link } from '@tanstack/react-router'
import { DONE_LISTS, type DoneShown, SHOWN_MAX, SHOWN_STEP, shown } from '../input'
import type { Shown } from '../nod.server'
import { TaskItem } from '../parts'
import { getDone } from '../todo-fns'
import { Section, TodoRow } from '../todo-parts'

export const Route = createFileRoute('/done')({
  // How many of each list to show, in the address so a reload or Back keeps them
  // (`?done=200&collected=300`). A list left out shows the first hundred; a bad count fails here.
  validateSearch: (s: Record<string, unknown>): Partial<DoneShown> => {
    const out: Partial<DoneShown> = {}
    for (const list of DONE_LISTS) if (s[list] !== undefined) out[list] = shown(s[list], list)
    return out
  },
  loaderDeps: ({ search }): DoneShown => ({
    done: search.done ?? SHOWN_STEP,
    dropped: search.dropped ?? SHOWN_STEP,
    collected: search.collected ?? SHOWN_STEP,
  }),
  loader: ({ deps }) => getDone({ data: deps }),
  component: DoneView,
})

// Mindwtr's Done: the todos finished or dropped, the latest first. Each one's status menu moves it
// back. Below them, the tasks gc collected, which the sidebar shows only the latest of.
function DoneView() {
  const d = Route.useLoaderData()
  const asked = Route.useLoaderDeps()
  return (
    <div className="page">
      <h1 className="title">Done</h1>
      <p className="subtitle">The latest first. Move a todo back with its status menu.</p>
      <Section title="Done" count={count(d.done)} bare={d.done.total === 0}>
        {d.done.total === 0 ? (
          <p className="muted">Nothing done yet.</p>
        ) : (
          d.done.items.map((t) => <TodoRow key={t.id} t={t} today={d.today} usual="done" />)
        )}
      </Section>
      <More list="done" of={d.done} asked={asked.done} />
      <Section title="Dropped" count={count(d.dropped)} bare={d.dropped.total === 0}>
        {d.dropped.total === 0 ? (
          <p className="muted">Nothing dropped.</p>
        ) : (
          d.dropped.items.map((t) => <TodoRow key={t.id} t={t} today={d.today} usual="dropped" />)
        )}
      </Section>
      <More list="dropped" of={d.dropped} asked={asked.dropped} />
      {/* The sidebar's "See all" comes here. */}
      <section id="collected">
        <Section title="Collected tasks" count={count(d.collected)} bare={d.collected.total === 0}>
          {d.collected.total === 0 ? (
            <p className="muted">Nothing collected.</p>
          ) : (
            d.collected.items.map((t) => <TaskItem key={t.id} t={t} />)
          )}
        </Section>
        <More list="collected" of={d.collected} asked={asked.collected} />
      </section>
    </div>
  )
}

// All of a list, or how many of it are shown out of all.
const count = (s: Shown<unknown>): string =>
  s.items.length < s.total ? `${s.items.length} / ${s.total}` : String(s.total)

// Shows a hundred more of a list by asking for them in the address; the other lists stay as they
// are, and so does the scroll.
function More({
  list,
  of,
  asked,
}: {
  list: (typeof DONE_LISTS)[number]
  of: Shown<unknown>
  asked: number
}) {
  if (of.items.length >= of.total || asked >= SHOWN_MAX) return null
  return (
    <Link
      to="/done"
      search={(s) => ({ ...s, [list]: Math.min(asked + SHOWN_STEP, SHOWN_MAX) })}
      replace
      resetScroll={false}
      className="more-rows"
    >
      Show {Math.min(SHOWN_STEP, of.total - of.items.length)} more
    </Link>
  )
}
