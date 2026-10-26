import { z } from 'zod'
import type { PrLookup, PullRequest } from './done'
import { spawn } from './worker'

// Reads a linked pull request through its git service's own CLI, already logged in: gh for GitHub,
// tea for Gitea and Forgejo. This is the one place nod asks a git service anything. It reads, and
// on a repo the person lets nod land (land.ts) it opens and squash merges nod's own pull requests
// (serviceOf). A link to anything else, a chat message say, is not a pull request.
// ponytail: reading, tea uses its default login whatever the host; pick the login by host once
// there are several. Writing picks the login by the repo's remote.

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

// The pull request nod opened for a task, as its git service has it now. `merge`: whether the
// service would squash it now: clean; in conflict with its base; behind it where the repo wants it
// up to date; blocked by what nod cannot clear (a review, a check, a draft); or unknown while the
// service works it out. `why`: the service's own word for it, for the person.
export type OwnPr = {
  state: 'open' | 'merged' | 'closed'
  head: string
  merge: 'clean' | 'conflict' | 'behind' | 'blocked' | 'unknown'
  why: string
}
export type NewPr = { base: string; head: string; title: string; body: string }
// What nod does with pull requests on a repo it lands. Only squash merges, and only of the head it
// checked: the service refuses one whose head moved since.
export type GitService = {
  name: 'gh' | 'tea'
  // The open pull request whose head is this branch. Not a merged or closed one: a branch name the
  // person gives may have been used before, and that pull request is someone else's work.
  find(branch: string): Promise<string | null>
  open(pr: NewPr): Promise<string>
  view(url: string): Promise<OwnPr>
  merge(url: string, m: { head: string; title: string; body: string }): Promise<void>
}

// The host and `owner/repo` of a remote's URL, written any of the ways git takes it: https, ssh://,
// or scp-like `user@host:owner/repo`.
export function remoteOf(url: string): { host: string; path: string } {
  const m =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:]([^/].*?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    )
  const [, host, path] = m ?? []
  if (host === undefined || path === undefined || !path.includes('/')) {
    throw new Error(`a remote nod cannot read: ${url}`)
  }
  return { host: host.toLowerCase(), path }
}

// The service of the repo's `origin`, as its config names it: GitHub's gh for github.com, and tea
// for any other host, as Gitea and Forgejo. The URL is read as written, not as `insteadOf` rewrites
// it, since that is the address the service knows the repo by.
// ponytail: origin only, and gh for github.com only; name the service per repo once another remote
// or a GitHub Enterprise host lands.
export function serviceOf(repo: string): GitService {
  const url = Bun.spawnSync(['git', '-C', repo, 'config', '--get', 'remote.origin.url'])
  if (url.exitCode !== 0) throw new Error(`${repo} has no remote origin`)
  const { host, path } = remoteOf(url.stdout.toString())
  const run = async (cmd: string[], stdin?: string): Promise<string> => {
    const { code, stdout, output } = await spawn(cmd, repo, { stdin, timeoutMs: TIMEOUT_MS })
    if (code !== 0)
      throw new Error(`${cmd.slice(0, 3).join(' ')} exited ${code}: ${output.trim().slice(-500)}`)
    return stdout
  }
  const json = async (cmd: string[], stdin?: string): Promise<unknown> =>
    JSON.parse(await run(cmd, stdin))
  if (host === 'github.com') {
    return {
      name: 'gh',
      find: async (branch) => {
        const prs = GH_LIST.parse(
          await json([
            'gh',
            'pr',
            'list',
            '--repo',
            path,
            '--head',
            branch,
            '--state',
            'all',
            '--json',
            'url,state',
          ]),
        )
        return prs.find((p) => p.state === 'OPEN')?.url ?? null
      },
      open: async (pr) => {
        const out = await run(
          [
            'gh',
            'pr',
            'create',
            '--repo',
            path,
            '--base',
            pr.base,
            '--head',
            pr.head,
            '--title',
            pr.title,
            '--body-file',
            '-',
          ],
          pr.body,
        )
        const created = out.trim().split('\n').at(-1) ?? ''
        if (!GITHUB.test(created))
          throw new Error(`gh pr create printed no pull request: ${out.trim()}`)
        return created
      },
      view: async (url) => {
        const pr = GH_OWN.parse(
          await json([
            'gh',
            'pr',
            'view',
            url,
            '--json',
            'state,mergeable,mergeStateStatus,headRefOid',
          ]),
        )
        const status = pr.mergeStateStatus
        const merge =
          pr.mergeable === 'CONFLICTING' || status === 'DIRTY'
            ? 'conflict'
            : status === 'BEHIND'
              ? 'behind'
              : status === 'CLEAN'
                ? 'clean'
                : status === 'UNKNOWN'
                  ? 'unknown'
                  : 'blocked'
        return { state: GH_STATE[pr.state], head: pr.headRefOid, merge, why: status.toLowerCase() }
      },
      merge: async (url, m) => {
        // Not --auto, which leaves the merge to a queue for later, nor --delete-branch, which also
        // deletes and switches local branches, one of them checked out in the task's worktree.
        await run(
          [
            'gh',
            'pr',
            'merge',
            url,
            '--squash',
            '--match-head-commit',
            m.head,
            '--subject',
            m.title,
            '--body-file',
            '-',
          ],
          m.body,
        )
      },
    }
  }
  // tea finds the login for the host by the repo's remote (-R) and runs in the repo.
  const api = (endpoint: string, body?: object): Promise<string> =>
    run(
      [
        'tea',
        'api',
        '-R',
        'origin',
        ...(body === undefined ? [] : ['-X', 'POST', '-d', '@-']),
        endpoint,
      ],
      body === undefined ? undefined : JSON.stringify(body),
    )
  const pulls = `repos/${path}/pulls`
  const endpointOf = (url: string): string => {
    const m = url.match(GITEA)
    if (m === null) throw new Error(`not a pull request of ${host}: ${url}`)
    const [, , owner, name, n] = m
    return `repos/${owner}/${name}/pulls/${n}`
  }
  return {
    name: 'tea',
    // ponytail: the first 50, newest first, where nod's own recent ones are; page on if one hides.
    find: async (branch) => {
      const listed = JSON.parse(await api(`${pulls}?state=all&limit=50`))
      const prs = GITEA_LIST.parse(listed).filter((p) => p.head.ref === branch)
      return prs.find((p) => p.state === 'open')?.html_url ?? null
    },
    open: async (pr) => GITEA_CREATED.parse(JSON.parse(await api(pulls, pr))).html_url,
    view: async (url) => {
      const pr = GITEA_OWN.parse(JSON.parse(await api(endpointOf(url))))
      return {
        state: pr.merged ? 'merged' : pr.state,
        head: pr.head.sha,
        merge: pr.mergeable ? 'clean' : 'conflict',
        why: pr.mergeable ? 'mergeable' : 'not mergeable',
      }
    },
    // The service refuses it unless the head is still `m.head` (head_commit_id). A merge answers
    // with an empty body; anything else is the service saying why not, should tea exit 0 on it.
    merge: async (url, m) => {
      const said = await api(`${endpointOf(url)}/merge`, {
        Do: 'squash',
        head_commit_id: m.head,
        MergeTitleField: m.title,
        MergeMessageField: m.body,
      })
      if (said.trim() !== '') throw new Error(`the merge was refused: ${said.trim().slice(-500)}`)
    },
  }
}

const GH_LIST = z.array(z.object({ url: z.string(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']) }))
const GH_OWN = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  headRefOid: z.string(),
})
const GITEA_LIST = z.array(
  z.object({
    html_url: z.string(),
    state: z.enum(['open', 'closed']),
    merged: z.boolean(),
    head: z.object({ ref: z.string() }),
  }),
)
const GITEA_CREATED = z.object({ html_url: z.string() })
const GITEA_OWN = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  mergeable: z.boolean(),
  head: z.object({ sha: z.string() }),
})
