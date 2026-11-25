import { z } from 'zod'
import type { PullRequest } from './done'
import { spawn } from './proc'

// Reads a linked pull request through its git service's own CLI, already logged in: gh for GitHub,
// tea for Gitea and Forgejo. This is the one place nod asks a git service anything. It reads, and
// on a repo the person lets nod land (land.ts) it opens and squash merges nod's own pull requests
// (serviceOf). A link to anything else, a chat message say, is not a pull request.
// ponytail: reading, tea uses its default login whatever the host; pick the login by host once
// there are several. Writing picks the login by the repo's remote.

const GITHUB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
const GITEA = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)/
const TIMEOUT_MS = 30_000

// The address of the pull request a link is to, without what follows it (`/files`), if it reads as one
// pullRequests can look up; it is not looked up.
export const prAddress = (url: string): string | null =>
  (url.match(GITHUB) ?? url.match(GITEA))?.[0] ?? null
export const isPullRequest = (url: string): boolean => prAddress(url) !== null

type Review = { login: string | null; state: string; at: string | null }
// A linked pull request with what pr-events.ts tells of it: who opened it (null for an account since
// deleted), its head commit, and its reviews, oldest first, one dismissed as DISMISSED. `id`: what tells
// a review from the others on its pull request; `comments`: how many comments on the code it holds, 0
// on GitHub, where each reply is a review of its own.
export type LinkedPr = PullRequest & {
  author: string | null
  sha: string
  reviews: (Review & { id: string; comments: number })[]
}
const CHANGES = new Set(['CHANGES_REQUESTED', 'REQUEST_CHANGES'])

// When the person approved, if their last review that approved or asked for changes approved; a
// comment changes neither. Reviews come oldest first.
export function approvedAt(reviews: Review[], me: string): string | null {
  const last = reviews.findLast(
    (r) => r.login === me && (r.state === 'APPROVED' || CHANGES.has(r.state)),
  )
  return last?.state === 'APPROVED' ? last.at : null
}

// A read its service failed, or turned away for now (a limit). Any other that fails is of its one pull
// request: gone, or not this login's to read.
export class ServiceDown extends Error {}
// What gh prints of one.
const GH_DOWN = /HTTP (429|5\d\d)|rate limit|error connecting/i
// tea fails only when no answer came, and prints an answer that says no as any other, so nod reads
// the status it prints to stderr with -i (tea 0.12 to 0.14.2).
const TEA_STATUS = /^HTTP\/\S+ (\d{3})/m

function reader(cwd: string) {
  const run = async (cmd: string[]): Promise<string> => {
    const { code, timedOut, stdout, output } = await spawn(cmd, cwd, { timeoutMs: TIMEOUT_MS })
    if (code !== 0) {
      const why = `${cmd.join(' ')} exited ${code}: ${output.trim().slice(-500)}`
      const down = timedOut || cmd[0] === 'tea' || GH_DOWN.test(output)
      throw down ? new ServiceDown(why) : new Error(why)
    }
    const status = Number(TEA_STATUS.exec(output.slice(stdout.length))?.[1] ?? 0)
    if (status < 400) return stdout
    const why = `${cmd.join(' ')} was answered ${status}: ${stdout.trim().slice(0, 200)}`
    // Not the service's JSON: what stands in front of it answered.
    const down = status === 429 || status >= 500 || !stdout.trimStart().startsWith('{')
    throw down ? new ServiceDown(why) : new Error(why)
  }
  const json = async (cmd: string[]): Promise<unknown> => {
    const out = await run(cmd)
    try {
      return JSON.parse(out)
    } catch {
      throw new ServiceDown(`${cmd.join(' ')} printed no JSON: ${out.trim().slice(0, 200)}`)
    }
  }
  return { run, json }
}

// One lookup per sweep: links to the same pull request (several comments on it) ask once.
export function pullRequests(cwd: string): (url: string) => Promise<LinkedPr | null> {
  const { run, json } = reader(cwd)
  const seen = new Map<string, Promise<LinkedPr>>()
  const logins = new Map<string, Promise<string>>()
  const once = <T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) => {
    const known = cache.get(key) ?? read()
    cache.set(key, known)
    return known
  }

  const github = async (repo: string, n: string): Promise<LinkedPr> => {
    const pr = GH_PR.parse(
      await json([
        'gh',
        'pr',
        'view',
        n,
        '--repo',
        repo,
        '--json',
        'state,reviews,headRefName,headRepository,headRepositoryOwner,mergedAt,author,headRefOid',
      ]),
    )
    const owner = pr.headRepositoryOwner?.login
    const name = pr.headRepository?.name
    const me = await once(logins, 'github', async () =>
      (await run(['gh', 'api', 'user', '--jq', '.login'])).trim(),
    )
    // By who and when, which tells it from the others: one person submits one review at a time.
    const reviews = pr.reviews.map((r) => ({
      id: `${r.author?.login ?? ''} ${r.submittedAt}`,
      login: r.author?.login ?? null,
      state: r.state,
      at: r.submittedAt,
      comments: 0,
    }))
    return {
      state: GH_STATE[pr.state],
      head: pr.headRefName,
      headRepo: owner && name ? `https://github.com/${owner}/${name}` : null,
      mergedAt: pr.mergedAt,
      approvedAt: approvedAt(reviews, me),
      // gh writes an app's login as app/<login> here, though not on its reviews.
      author: pr.author?.login.replace(/^app\//, '') ?? null,
      sha: pr.headRefOid,
      reviews,
    }
  }
  const gitea = async (base: string, repo: string, n: string): Promise<LinkedPr> => {
    const api = `${base}/api/v1`
    const pr = GITEA_PR.parse(await json(['tea', 'api', '-i', `${api}/repos/${repo}/pulls/${n}`]))
    // Oldest first, 50 to a page, so the newest are on the last. ponytail: a service whose
    // MAX_RESPONSE_ITEMS is below 50 gives one page; 20 pages at most, so one that ignores the page
    // does not hold the tick.
    const listed: z.infer<typeof GITEA_REVIEWS> = []
    for (let page = 1; page <= 20 && listed.length === (page - 1) * 50; page++) {
      const reviews = `${api}/repos/${repo}/pulls/${n}/reviews?page=${page}&limit=50`
      listed.push(...GITEA_REVIEWS.parse(await json(['tea', 'api', '-i', reviews])))
    }
    const me = await once(
      logins,
      base,
      async () => GITEA_USER.parse(await json(['tea', 'api', '-i', `${api}/user`])).login,
    )
    const reviews = listed.map((r) => ({
      id: String(r.id),
      login: r.user?.login ?? null,
      state: r.dismissed ? 'DISMISSED' : r.state,
      at: r.submitted_at,
      comments: r.comments_count ?? 0,
    }))
    return {
      state: pr.merged ? 'merged' : pr.state,
      head: pr.head.label,
      headRepo: pr.head.repo ? `${base}/${pr.head.repo.full_name}` : null,
      mergedAt: pr.merged_at,
      approvedAt: approvedAt(reviews, me),
      author: pr.user?.login ?? null,
      sha: pr.head.sha,
      reviews,
    }
  }

  return async (url) => {
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

// What pr-events.ts reads of an open pull request beside its lookup: the comments on the code in one of
// its reviews, whoever wrote them (on Gitea and Forgejo a reply goes into the review it answers), and
// its head whose CI failed, null while that has not. `head`: as the lookup read it.
export type PrReads = {
  comments(url: string, review: string): Promise<{ id: string; login: string | null; at: string }[]>
  failedHead(url: string, head: string): Promise<string | null>
}
export function prReads(cwd: string): PrReads {
  const { json } = reader(cwd)
  const repoApi = (url: string): { api: string; n: string } => {
    const [, base, owner, repo, n] = url.match(GITEA) ?? []
    if (n === undefined) throw new Error(`not a pull request of Gitea or Forgejo: ${url}`)
    return { api: `${base}/api/v1/repos/${owner}/${repo}`, n }
  }
  return {
    comments: async (url, review) => {
      const { api, n } = repoApi(url)
      const listed = await json([
        'tea',
        'api',
        '-i',
        `${api}/pulls/${n}/reviews/${review}/comments`,
      ])
      return GITEA_COMMENTS.parse(listed).map((c) => ({
        id: String(c.id),
        login: c.user?.login ?? null,
        at: c.created_at,
      }))
    },
    failedHead: async (url, head) => {
      const gh = url.match(GITHUB)
      if (gh === null) {
        // The commit's statuses put together, as the service's own pages show them. Not its Actions
        // runs, which are heavy for the service to list. Forgejo puts the state together from all the
        // statuses and pages only the list, which is not read.
        const { api } = repoApi(url)
        const status = await json([
          'tea',
          'api',
          '-i',
          `${api}/commits/${head}/status?page=1&limit=50`,
        ])
        const state = GITEA_STATUS.parse(status)?.state
        return state === 'failure' || state === 'error' ? head : null
      }
      const [, owner, name, n] = gh
      const pr = GH_CHECKS.parse(
        await json([
          'gh',
          'pr',
          'view',
          String(n),
          '--repo',
          `${owner}/${name}`,
          '--json',
          'headRefOid,statusCheckRollup',
        ]),
      )
      // The last run of each check: one run again keeps its earlier runs in the list. gh pr checks
      // also tells apart what event ran a workflow, which --json leaves out.
      const runs = (pr.statusCheckRollup ?? []).toSorted((a, b) =>
        (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
      )
      const failed = new Map(
        runs.map((c) => [
          c.context ?? `${c.workflowName}/${c.name}`,
          GH_FAILED.has(c.state || c.conclusion || ''),
        ]),
      )
      return [...failed.values()].includes(true) ? pr.headRefOid : null
    },
  }
}

const GH_STATE = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const
const GH_PR = z.object({
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefName: z.string(),
  // Null once the fork the head is in is deleted.
  headRepository: z.object({ name: z.string() }).nullish(),
  headRepositoryOwner: z.object({ login: z.string() }).nullish(),
  mergedAt: z.string().nullable(),
  author: z.object({ login: z.string() }).nullish(),
  headRefOid: z.string(),
  reviews: z.array(
    z.object({
      author: z.object({ login: z.string() }).nullable(),
      state: z.string(),
      submittedAt: z.string().nullable(), // null while pending
    }),
  ),
})
// One that only waits for a person (ACTION_REQUIRED) or was stopped (CANCELLED) did not fail.
const GH_FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'])
// A check run has a name, workflow and conclusion, a commit status a context and state.
const GH_CHECKS = z.object({
  headRefOid: z.string(),
  statusCheckRollup: z
    .array(
      z.object({
        context: z.string().nullish(),
        name: z.string().nullish(),
        workflowName: z.string().nullish(),
        state: z.string().nullish(),
        conclusion: z.string().nullish(),
        startedAt: z.string().nullish(),
      }),
    )
    .nullish(),
})
const GITEA_PR = z.object({
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  user: z.object({ login: z.string() }).nullish(),
  // The branch's name; `ref` says refs/pull/<n>/head once the branch is deleted. `repo`: the repo
  // the branch is in, a fork's for a pull request from a fork, null once that repo is deleted.
  head: z.object({
    label: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullish(),
  }),
})
const GITEA_REVIEWS = z.array(
  z.object({
    id: z.number(),
    user: z.object({ login: z.string() }).nullable(),
    state: z.string(),
    submitted_at: z.string(),
    dismissed: z.boolean().optional(),
    comments_count: z.number().nullish(),
  }),
)
const GITEA_COMMENTS = z.array(
  z.object({
    id: z.number(),
    user: z.object({ login: z.string() }).nullable(),
    created_at: z.string(),
  }),
)
// Forgejo answers a commit with no status as pending; null or an empty state reads as none too.
const GITEA_STATUS = z.object({ state: z.string() }).nullable()
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

// The address of the repo's `origin`, the remote nod pushes to (land.ts), as its config writes it,
// not as `insteadOf` rewrites it: the address the service knows the repo by. Null without one.
export function originUrl(repo: string): string | null {
  const url = Bun.spawnSync(['git', '-C', repo, 'config', '--get', 'remote.origin.url'])
  return url.exitCode === 0 ? url.stdout.toString() : null
}

// Where `git push origin` goes, as written: each of its pushurls, or else its url. None without.
// An empty pushurl drops those before it, as git 2.46 and later read the list.
export function pushUrls(repo: string): string[] {
  const push = Bun.spawnSync(['git', '-C', repo, 'config', '--get-all', 'remote.origin.pushurl'])
  const all = push.exitCode === 0 ? push.stdout.toString().replace(/\n$/, '').split('\n') : []
  const urls = all.slice(all.lastIndexOf('') + 1)
  const url = originUrl(repo)
  return urls.length > 0 ? urls : url === null ? [] : [url]
}

// Whether two remote addresses name one repo, however each is written: https or ssh, with `.git`
// or without, in any case. An address that is missing or unreadable matches none.
export function sameRepo(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  try {
    const [x, y] = [remoteOf(a), remoteOf(b)]
    return x.host === y.host && x.path.toLowerCase() === y.path.toLowerCase()
  } catch {
    return false // one remoteOf cannot read
  }
}

// The service of the repo's `origin` (originUrl): GitHub's gh for github.com, and tea for any other
// host, as Gitea and Forgejo.
// ponytail: origin only, and gh for github.com only; name the service per repo once another remote
// or a GitHub Enterprise host lands.
export function serviceOf(repo: string): GitService {
  const url = originUrl(repo)
  if (url === null) throw new Error(`${repo} has no remote origin`)
  const { host, path } = remoteOf(url)
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
