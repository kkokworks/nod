import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

// The panes whose width the person sets by dragging the edge beside them, or with ← → on it.
// `grows`: the way the edge moves to widen the pane, right for the sidebar at the left, left for the
// terminal at the right. `min`: the narrowest it gets with its contents still fitting (the terminal's
// is the 360px its column always had). `rest`: the narrowest the page beside it keeps in their `box`.
// `max`: the widest, a stored width too. The sidebar's leaves the task page room for its two columns
// at 1101px, the narrowest window they stand side by side in, less a scrollbar; CSS caps the
// terminal's to what fits.
export const PANES = {
  side: {
    label: 'Sidebar width',
    pane: '.sidebar',
    box: '.app',
    grows: 1,
    min: 200,
    max: 400,
    rest: 0,
  },
  term: {
    label: 'Terminal width',
    pane: '.computer',
    box: '.task-layout',
    grows: -1,
    min: 360,
    max: 4000,
    rest: 320,
  },
} as const
export type Pane = keyof typeof PANES

const KEY = 'nod-pane-width-'
// How far an arrow key moves the edge.
const STEP = 16

// `min` wins over a `max` below it: a pane keeps its contents in a box too small for both.
export const clamp = (width: number, min: number, max: number): number =>
  Math.round(Math.max(min, Math.min(width, max)))

// The width a pane `from` wide takes when its edge moves `by` pixels right, in a box `box` wide.
export function moved(name: Pane, from: number, by: number, box: number): number {
  const p = PANES[name]
  return clamp(from + p.grows * by, p.min, Math.min(p.max, box - p.rest))
}

// The width the person last gave the pane in this browser, or null for the default: none stored,
// storage that cannot be read (a private window, blocked site data), or a value no width of ours is.
export function stored(name: Pane, storage?: Pick<Storage, 'getItem'>): number | null {
  try {
    const raw = (storage ?? localStorage).getItem(KEY + name)
    if (raw === null || !/^\d+$/.test(raw)) return null
    return clamp(Number(raw), PANES[name].min, PANES[name].max)
  } catch {
    return null
  }
}

function save(name: Pane, width: number): void {
  try {
    localStorage.setItem(KEY + name, String(width))
  } catch {
    // Not kept: the width holds until the page loads again.
  }
}

// Where a drag began, and the width it has come to.
type Drag = { x: number; from: number; box: number; width: number | null }

// Ends a drag, if one is on: at its end, one the browser cancels, or the pane going in the middle of
// it (the page moved on), which would leave the page's text not to be selected.
function finish(name: Pane, drag: RefObject<Drag | null>): void {
  if (drag.current === null) return
  document.documentElement.classList.remove('resizing')
  const width = drag.current.width
  drag.current = null
  if (width !== null) save(name, width)
}

// On the root element, which the page's CSS reads (`--side-w`, `--term-w`) and moving to another
// page keeps.
const show = (name: Pane, width: number) =>
  document.documentElement.style.setProperty(`--${name}-w`, `${width}px`)

// The edge of a pane. Each move sets its width at once; the width is stored when the drag ends.
// A terminal in the pane fits itself to the new width (terminal.tsx's ResizeObserver).
// ponytail: a stored width shows once the page has loaded, after a frame or so at the default; an
// inline script in the head would show it from the first frame.
export function Splitter({ name }: { name: Pane }) {
  const p = PANES[name]
  const drag = useRef<Drag | null>(null)
  // Where the edge sits in the box, in percent, for assistive technology: measured when focused, and
  // as it moves.
  const [at, setAt] = useState<number>()
  useLayoutEffect(() => {
    const width = stored(name)
    if (width !== null) show(name, width)
    return () => finish(name, drag)
  }, [name])
  const measure = () => ({
    from: document.querySelector(p.pane)?.getBoundingClientRect().width ?? 0,
    box: document.querySelector(p.box)?.getBoundingClientRect().width ?? 0,
  })
  const percent = (width: number, box: number) =>
    box > 0 ? Math.round(((p.grows > 0 ? width : box - width) / box) * 100) : undefined
  const resize = (from: number, by: number, box: number): number => {
    const width = moved(name, from, by, box)
    show(name, width)
    setAt(percent(width, box))
    return width
  }
  return (
    <hr
      className={`splitter splitter-${name}`}
      aria-orientation="vertical"
      aria-label={p.label}
      aria-valuenow={at}
      tabIndex={0}
      onFocus={() => {
        const m = measure()
        setAt(percent(m.from, m.box))
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        // No text is selected on the way, and the moves come here wherever the pointer goes.
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        document.documentElement.classList.add('resizing')
        drag.current = { x: e.clientX, ...measure(), width: null }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d !== null) d.width = resize(d.from, e.clientX - d.x, d.box)
      }}
      onLostPointerCapture={() => finish(name, drag)}
      onKeyDown={(e) => {
        const by = e.key === 'ArrowRight' ? STEP : e.key === 'ArrowLeft' ? -STEP : 0
        if (by === 0) return
        e.preventDefault()
        const m = measure()
        save(name, resize(m.from, by, m.box))
      }}
    />
  )
}
