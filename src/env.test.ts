import { expect, it, test } from 'bun:test'
import { join } from 'node:path'
import { workerEnv } from './env'

it('a worker learns its task through NOD_TASK, so the todos it changes name it', () => {
  expect(workerEnv('/h', 5)).toMatchObject({ NOD_HOME: '/h', NOD_TASK: '5' })
  expect(workerEnv('/h', null)).not.toHaveProperty('NOD_TASK')
})

// Runs `body` with no CLAUDE_AUTOCOMPACT_PCT_OVERRIDE in nod's environment, whatever the shell
// running the tests has.
async function withoutAutocompact(body: () => unknown): Promise<void> {
  const ambient = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  try {
    await body()
  } finally {
    if (ambient === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = ambient
  }
}

test('a worker compacts at 60% of its window, unless the environment nod starts from says how early', () =>
  withoutAutocompact(() => {
    expect(workerEnv('/h', 5).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('60')
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
    expect(workerEnv('/h', 5).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50')
  }))

it('a worker keeps only what it needs of the environment it starts from, and the account it is given', () => {
  const outer = {
    // What a terminal, an agent host and a person's shell put there for themselves.
    TERM_SESSION_ID: 'w0t0p0:example',
    CLAUDE_CODE_SSE_PORT: '12345',
    NOD_ACTOR: 'human',
    // What the worker needs.
    HTTPS_PROXY: 'http://proxy.example.com:3128',
    NODE_EXTRA_CA_CERTS: '/certs/example.pem',
    LC_ALL: 'ko_KR.UTF-8',
    ANTHROPIC_BASE_URL: 'https://llm.example.com',
  }
  // In a process started with them, as nod is: Bun leaves proxy variables set at run time out of
  // process.env's keys (measured on 1.3.14).
  const workerEnvIn = (config: string | null): Record<string, string> => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `import { workerEnv } from ${JSON.stringify(join(import.meta.dir, 'env.ts'))}
console.log(JSON.stringify(workerEnv('/h', 5, ${JSON.stringify(config)})))`,
      ],
      { env: { ...process.env, ...outer } },
    )
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    return JSON.parse(run.stdout.toString())
  }
  const env = workerEnvIn('/accounts/a')
  expect(env).toMatchObject({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    HTTPS_PROXY: outer.HTTPS_PROXY,
    NODE_EXTRA_CA_CERTS: outer.NODE_EXTRA_CA_CERTS,
    LC_ALL: outer.LC_ALL,
    ANTHROPIC_BASE_URL: outer.ANTHROPIC_BASE_URL,
    NOD_HOME: '/h',
    NOD_TASK: '5',
    CLAUDE_CONFIG_DIR: '/accounts/a',
  })
  for (const marker of ['TERM_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'NOD_ACTOR']) {
    expect(env).not.toHaveProperty(marker)
  }
  expect(workerEnvIn(null)).not.toHaveProperty('CLAUDE_CONFIG_DIR')
})

it('a saved environment leaves out secrets, by name or in a URL, and the SSH agent, which moves at each boot', () => {
  const outer = {
    HTTPS_PROXY: 'http://user:pass@proxy.example.com:8080',
    https_proxy: 'http://user:pass@proxy.example.com:8080',
    ALL_PROXY: 'user:pass@proxy.example.com:8080', // curl and git take a proxy without a scheme
    ANTHROPIC_BASE_URL: 'https://u:pw@llm.example.com',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer example',
    ANTHROPIC_API_KEY: 'example',
    SSH_AUTH_SOCK: '/private/tmp/ssh-example/agent.1',
    // Kept.
    HTTP_PROXY: 'http://proxy.example.com:3128',
    NO_PROXY: 'localhost,.example.com',
    LC_ALL: 'ko_KR.UTF-8',
    ANTHROPIC_MODEL: 'claude-example@20250101', // an @ that is no user
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50', // how early the person has Claude Code compact
  }
  // In a process started with them, as in the workerEnv test above.
  const run = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import { savedEnv, workerEnv } from ${JSON.stringify(join(import.meta.dir, 'env.ts'))}
console.log(JSON.stringify([savedEnv(), workerEnv('/h', 5, null)]))`,
    ],
    { env: { ...process.env, ...outer } },
  )
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  const [saved, worker] = JSON.parse(run.stdout.toString())
  expect(saved).toMatchObject({
    HTTP_PROXY: outer.HTTP_PROXY,
    NO_PROXY: outer.NO_PROXY,
    LC_ALL: outer.LC_ALL,
    ANTHROPIC_MODEL: outer.ANTHROPIC_MODEL,
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: outer.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  })
  for (const name of [
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'ANTHROPIC_API_KEY',
    'SSH_AUTH_SOCK',
  ]) {
    expect(saved).not.toHaveProperty(name)
  }
  // A worker nod starts gets them all.
  expect(worker).toMatchObject(outer)
})
