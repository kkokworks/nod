// The dialog as Claude Code draws it (2.1.331), under what the terminal showed before: `says`, why
// it shows; for auto mode's, the last call it blocked. `title`: with who asks and its place in the queue.
export const UNCHECKED =
  'A call in this response changed (or may have changed) after auto mode reviewed it, so auto mode could not check what would run'
export const blocked = (why = UNCHECKED, times = '3 consecutive actions were blocked.'): string =>
  `Auto mode needs your confirmation for this command.\n${times} Please review the transcript before continuing.\n\nLatest blocked action: ${why}`
export function dialog(
  command: string,
  says = blocked(),
  width = 60,
  title = 'Bash command',
): string {
  const boxed = (body: string): string[] =>
    body
      .split('\n')
      .flatMap((l) => l.match(new RegExp(`.{1,${width}}`, 'g')) ?? [''])
      .map((l) => ` │ ${l}`)
  return [
    `  Bash(${command})`,
    '  ⎿  Waiting…',
    '─'.repeat(width),
    ` ${title}`,
    ' Show it',
    '╌'.repeat(width),
    ...boxed(command),
    '╌'.repeat(width),
    ...boxed(says),
    ' ⚠ Claude Code will automatically block this request in 1:53, to avoid holding up an unattended session',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n')
}
