import { tinykeys } from 'tinykeys'

const ON_ROW = 'On a todo row'
const ON_ROW_OR_MENU = 'On a todo row or in its status menu'

type Key = {
  bind: string[]
  show: string[]
  does: string
  where: string
  // Keeps going while held, so a held ↓ walks down the list instead of scrolling the page.
  repeat?: boolean
  // For aria-keyshortcuts, on the element that takes the key.
  aria?: string
}

// Every keyboard shortcut, in one place: the handlers bind them and the help lists them. A key is
// matched by where it sits on the keyboard (`event.code`), not by the letter it types, since with a
// Korean input source on `j` arrives as `ㅓ`. A one-letter key works only on a focused todo row
// (WCAG 2.1.4), and the browser's own ⌘/Ctrl keys (W, T, N, F, L, R, digits) are left to it.
// ponytail: labels are the Mac's; `$mod` is Ctrl elsewhere.
export const KEYS = {
  list: {
    bind: ['$mod+Shift+Digit0'],
    show: ['⌘⇧0'],
    does: 'Go to the first todo',
    where: 'Anywhere, in a field too',
  },
  down: {
    bind: ['ArrowDown', 'KeyJ'],
    show: ['↓', 'j'],
    repeat: true,
    does: 'Next todo, or next status',
    where: ON_ROW_OR_MENU,
  },
  up: {
    bind: ['ArrowUp', 'KeyK'],
    show: ['↑', 'k'],
    repeat: true,
    does: 'Previous todo, or previous status',
    where: ON_ROW_OR_MENU,
  },
  done: { bind: ['KeyX'], show: ['x'], aria: 'X', does: 'Finish it', where: ON_ROW },
  status: { bind: ['KeyS'], show: ['s'], aria: 'S', does: 'Open its status menu', where: ON_ROW },
  // A row's focus is on its title, a button, so Enter clicks it: the todo opens where it is.
  open: { bind: [], show: ['↵'], does: 'Open or fold it', where: ON_ROW },
  help: {
    bind: ['Shift+Slash'],
    show: ['?'],
    aria: 'Shift+?',
    does: 'Show these shortcuts',
    where: 'Outside a field',
  },
  // Menus and the help are popovers, which the browser closes on Escape itself.
  close: { bind: [], show: ['Esc'], does: 'Close a menu or this help', where: 'Anywhere' },
} satisfies Record<string, Key>

type Name = keyof typeof KEYS

// What a row's title takes that acts on its todo, for its aria-keyshortcuts. ↑ ↓ j k go to another
// row and Enter is the button's own, so they are not this element's shortcuts.
export const ROW_KEYS = `${KEYS.done.aria} ${KEYS.status.aria}`

// What tinykeys skips by default, less a key held down (`repeat` decides that): a key typed in a
// field, and one pressed mid-composition (Korean input).
const typing = (e: KeyboardEvent): boolean =>
  e.isComposing ||
  (e.target !== e.currentTarget &&
    e.target instanceof Element &&
    e.target.matches('[contenteditable],input,select,textarea'))

// The page's keys skip the same, but a ⌘/Ctrl key comes through from a field too.
export const ignoreOnPage = (e: KeyboardEvent): boolean =>
  e.metaKey || e.ctrlKey ? e.isComposing : typing(e)

// Binds the named shortcuts on `target`, skipping what `ignore` says to; a key handled does nothing
// else. A held key repeats only if its entry says so. Returns the unbinding, for an effect's cleanup.
export function bindKeys(
  target: Window | HTMLElement,
  handlers: Partial<Record<Name, () => void>>,
  ignore = typing,
): () => void {
  const map: Record<string, (e: KeyboardEvent) => void> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    const key: Key = KEYS[name as Name]
    for (const bind of key.bind) {
      map[bind] = (e) => {
        if (e.repeat && key.repeat !== true) return
        e.preventDefault()
        handler()
      }
    }
  }
  return tinykeys(target, map, { ignore })
}
