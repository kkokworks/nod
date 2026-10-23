import { z } from 'zod'
import type { PrLookup, PullRequest } from './done'
import { spawn } from './worker'

// Reads a linked pull request through its git service's own CLI, already logged in: gh for GitHub,
// tea for Gitea and Forgejo. This is the one place nod asks a git service anything, and it only
// reads. A link to anything else, a chat message say, is not a pull request.
// ponytail: tea uses its default login whatever the host; pick the login by host once there are
// several.

const GITHUB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const GITEA = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)/
const TIMEOUT_MS = 30_000

type Review = { login: string | null; state: string; at: string | null }
const APPROVED = new Set(['APPROVED'])
const CHANGES = new Set(['CHANGES_REQUESTED', 'REQUEST_CHANGES'])

// When the person approved, if their last review that approved or asked for changes approved; a
// comment changes neither. Reviews come oldest first.
export function approvedAt(reviews: Review[], me: string): string | null {
  const last = reviews
    .filter((r) => r.login === me && (APPROVED.has(r.state) || CHANGES.has(r.state)))
    .at(-1)
  return last !== undefined && APPROVED.has(last.state) ? last.at : null
}

// One lookup per sweep: links to the same pull request (several comments on it) ask once.
export function pullRequests(cwd: string): PrLookup {
  const seen = new Map<string, Promise<PullRequest>>()
  const logins = new Map<string, Promise<string>>()
  const login = (key: string, read: () => Promise<string>): Promise<string> => {
    const known = logins.get(key) ?? read()
    logins.set(key, known)
    return known
  }
  const run = async (cmd: string[]): Promise<string> => {
    const { code, stdout, output } = await spawn(cmd, cwd, { timeoutMs: TIMEOUT_MS })
    if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}: ${output.trim().slice(-500)}`)
    return stdout
  }
  const json = async (cmd: string[]): Promise<unknown> => JSON.parse(await run(cmd))

  const github = async (repo: string, n: string): Promise<PullRequest> => {
    const pr = GH_PR.parse(
      await json(['gh', 'pr', 'view', n, '--repo', repo, '--json', 'state,reviews']),
    )
    const me = await login('github', async () =>
      (await run(['gh', 'api', 'user', '--jq', '.login'])).trim(),
    )
    const reviews = pr.reviews.map((r) => ({
      login: r.author?.login ?? null,
      state: r.state,
      at: r.submittedAt,
    }))
    return { state: GH_STATE[pr.state], approvedAt: approvedAt(reviews, me) }
  }
  const gitea = async (base: string, repo: string, n: string): Promise<PullRequest> => {
    const api = `${base}/api/v1`
    const pr = GITEA_PR.parse(await json(['tea', 'api', `${api}/repos/${repo}/pulls/${n}`]))
    // ponytail: one page of 50 reviews; follow the pages if a pull request gets more.
    const reviews = GITEA_REVIEWS.parse(
      await json(['tea', 'api', `${api}/repos/${repo}/pulls/${n}/reviews?page=1&limit=50`]),
    )
    const me = await login(
      base,
      async () => GITEA_USER.parse(await json(['tea', 'api', `${api}/user`])).login,
    )
    const standing = reviews
      .filter((r) => !r.dismissed)
      .map((r) => ({ login: r.user?.login ?? null, state: r.state, at: r.submitted_at }))
    return { state: pr.merged ? 'merged' : pr.state, approvedAt: approvedAt(standing, me) }
  }

  return async (url) => {
    const gh = url.match(GITHUB)
    const ge = gh === null ? url.match(GITEA) : null
    if (gh !== null) {
      const [, owner, repo, n] = gh
      const key = `https://github.com/${owner}/${repo}/pull/${n}`
      const read = seen.get(key) ?? github(`${owner}/${repo}`, String(n))
      seen.set(key, read)
      return read
    }
    if (ge !== null) {
      const [, base, owner, repo, n] = ge
      const key = `${base}/${owner}/${repo}/pulls/${n}`
      const read = seen.get(key) ?? gitea(String(base), `${owner}/${repo}`, String(n))
      seen.set(key, read)
      return read
    }
    return null
  }
}

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const
const GH_PR = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  reviews: z.array(
    z.object({
      author: z.object({ login: z.string() }).nullable(),
      state: z.string(),
      submittedAt: z.string().nullable(), // null while pending
    }),
  ),
})
const GITEA_PR = z.object({ state: z.enum(['open', 'closed']), merged: z.boolean() })
const GITEA_REVIEWS = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable(),
    state: z.string(),
    submitted_at: z.string(),
    dismissed: z.boolean().optional(),
  }),
)
const GITEA_USER = z.object({ login: z.string() })
