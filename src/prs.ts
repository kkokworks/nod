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
const CHANGES = new Set(['CHANGES_REQUESTED', 'REQUEST_CHANGES'])

// When the person approved, if their last review that approved or asked for changes approved; a
// comment changes neither. Reviews come oldest first.
export function approvedAt(reviews: Review[], me: string): string | null {
  const last = reviews.findLast(
    (r) => r.login === me && (r.state === 'APPROVED' || CHANGES.has(r.state)),
  )
  return last?.state === 'APPROVED' ? last.at : null
}

// One lookup per sweep: links to the same pull request (several comments on it) ask once.
export function pullRequests(cwd: string): PrLookup {
  const seen = new Map<string, Promise<PullRequest>>()
  const logins = new Map<string, Promise<string>>()
  const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
    const known = cache.get(key) ?? read()
    cache.set(key, known)
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
    const me = await once(logins, 'github', async () =>
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
    const me = await once(
      logins,
      base,
      async () => GITEA_USER.parse(await json(['tea', 'api', `${api}/user`])).login,
    )
    const standing = reviews
      .filter((r) => !r.dismissed)
      .map((r) => ({ login: r.user?.login ?? null, state: r.state, at: r.submitted_at }))
    return { state: pr.merged ? 'merged' : pr.state, approvedAt: approvedAt(standing, me) }
  }

  return async (url) => {
    // The whole match is the pull request's address, without what follows it (`/files`).
    const gh = url.match(GITHUB)
    if (gh !== null) {
      const [key, owner, repo, n] = gh
      return once(seen, key, () => github(`${owner}/${repo}`, String(n)))
    }
    const ge = url.match(GITEA)
    if (ge !== null) {
      const [key, base, owner, repo, n] = ge
      return once(seen, key, () => gitea(String(base), `${owner}/${repo}`, String(n)))
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
