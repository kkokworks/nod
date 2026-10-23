import { defaultKeybindingsHandlerIgnore, tinykeys } from 'tinykeys'

const ON_ROW = 'On a todo row'

// Every keyboard shortcut, in one place: the handlers bind them and the help lists them. A key is
// matched by where it sits on the keyboard (`event.code`), not by the letter it types, since with a
// Korean input source on `j` arrives as `ㅓ`. A one-letter key works only on a focused todo row
// (WCAG 2.1.4), and the browser's own ⌘/Ctrl keys (W, T, N, F, L, R, digits) are left to it.
// ponytail: labels are the Mac's; `$mod` is Ctrl elsewhere.
export const KEYS = {
  list: {
    bind: ['$mod+Shift+Digit0'],
    show: ['⌘⇧0'],
    aria: 'Meta+Shift+0',
    does: 'Go to the first todo',
    where: 'Anywhere, in a field too',
  },
  down: {
    bind: ['ArrowDown', 'KeyJ'],
    show: ['↓', 'j'],
    aria: 'ArrowDown J',
    does: 'Next todo',
    where: ON_ROW,
  },
  up: {
    bind: ['ArrowUp', 'KeyK'],
    show: ['↑', 'k'],
    aria: 'ArrowUp K',
    does: 'Previous todo',
    where: ON_ROW,
  },
  done: { bind: ['KeyX'], show: ['x'], aria: 'X', does: 'Finish it', where: ON_ROW },
  status: { bind: ['KeyS'], show: ['s'], aria: 'S', does: 'Open its status menu', where: ON_ROW },
  // A row's focus is on its title, a button, so Enter clicks it: the todo opens where it is.
  open: { bind: [], show: ['↵'], aria: 'Enter', does: 'Open or fold it', where: ON_ROW },
  help: {
    bind: ['Shift+Slash'],
    show: ['?'],
    aria: 'Shift+?',
    does: 'Show these shortcuts',
    where: 'Outside a field',
  },
  // Menus and the help are popovers, which the browser closes on Escape itself.
  close: {
    bind: [],
    show: ['Esc'],
    aria: 'Escape',
    does: 'Close a menu or this help',
    where: 'Anywhere',
  },
}

type Name = keyof typeof KEYS

// What a todo row answers to, for its aria-keyshortcuts.
export const ROW_KEYS = Object.values(KEYS)
  .filter((k) => k.where === ON_ROW)
  .map((k) => k.aria)
  .join(' ')

// What the page's keys skip: as tinykeys does, a key typed in a field, one held down, and one
// pressed mid-composition (Korean input), but a ⌘/Ctrl key comes through from a field too.
export const ignoreOnPage = (e: KeyboardEvent): boolean =>
  e.metaKey || e.ctrlKey ? e.repeat || e.isComposing : defaultKeybindingsHandlerIgnore(e)

// Binds the named shortcuts on `target`, skipping what `ignore` says to (tinykeys's own by
// default); a key handled does nothing else. Returns the unbinding, for an effect's cleanup.
export function bindKeys(
  target: Window | HTMLElement,
  handlers: Partial<Record<Name, () => void>>,
  ignore = defaultKeybindingsHandlerIgnore,
): () => void {
  const map: Record<string, (e: KeyboardEvent) => void> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    for (const bind of KEYS[name as Name].bind) {
      map[bind] = (e) => {
        e.preventDefault()
        handler()
      }
    }
  }
  return tinykeys(target, map, { ignore })
}
