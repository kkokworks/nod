// A run of `files` by bun's test runner, the bun running these tests, without the color a
// FORCE_COLOR around these tests would bring (NO_COLOR would not end it).
export const bunTest = (files: string): string =>
  `unset FORCE_COLOR; ${JSON.stringify(process.execPath)} test ${files}`

// Two runs of bun's test runner, as a check of a repo and its UI can be: two files that fail to load
// (a module that is not there, an export that is not), then one whose tests fail after a passing
// test that logs an Error it caught and before one that prints more warnings than the end of a
// check's output that nod keeps (OUTPUT_LIMIT in src/proc.ts). `files` go in the check's folder;
// `check` runs them, and fails.
export const NOISY_FAILURE = {
  files: {
    'missing.test.ts': `import { test } from 'bun:test'
import { gone } from './gone'
test('never runs', () => gone())
`,
    'helper.ts': 'export const here = 1\n',
    'unexported.test.ts': `import { test } from 'bun:test'
import { gone } from './helper'
test('never runs', () => gone())
`,
    'noisy.test.ts': `import { expect, test } from 'bun:test'
test('a passing one that logs', () => {
  console.error(new Error('caught and logged'))
})
test('the one that fails', () => {
  expect(1).toBe(2)
})
test('the one that throws', () => {
  throw new TypeError('the cause of it')
})
test('the one that times out', () => new Promise(() => {}), 1)
test('a noisy one', () => {
  for (let i = 1; i <= 300; i++) console.error(\`Warning: a noisy render \${i}\`)
})
`,
  },
  check: `${bunTest('./missing.test.ts ./unexported.test.ts')}; ${bunTest('./noisy.test.ts')}`,
}
