// Reads where things stand on Forgejo (or Gitea), read only, through the tea login.
// Usage: bun <skill folder>/sources/forgejo/forgejo.ts
// Prints the PRs that name me as a reviewer, my open PRs, and for the repos I maintain the default
// branch's CI and open PRs. Settings (config.json's forgejo): org to scan; maintainerFile and
// maintainerKey say which repos are mine (that file has a `<maintainerKey>: <my login>` line).
// Without those two, the repos part is skipped.
import { loadConfig } from '../config'

// The Forgejo API responses, with only the fields read here.
type User = { login: string }
type Pr = {
  number: number
  title: string
  html_url: string
  updated_at: string
  user: User
  repository?: { full_name: string }
  requested_reviewers?: User[] | null
}
type Repo = { name: string; archived: boolean; default_branch: string; open_issues_count: number }

const forgejo = (await loadConfig()).forgejo
if (!forgejo) {
  throw new Error('config.json has no forgejo.org; follow sources/forgejo/SOURCE.md to set it up')
}

function api<T>(path: string): T {
  const result = Bun.spawnSync(['tea', 'api', path])
  if (result.exitCode !== 0) {
    throw new Error(`tea api ${path} failed: ${result.stderr.toString().trim()}`)
  }
  return JSON.parse(result.stdout.toString())
}
const day = (iso: string | undefined) => iso?.slice(0, 10) ?? '-'
const repoOf = (pr: Pr) => pr.repository?.full_name ?? '?'

const me = api<User>('user').login
// review_requested also catches PRs that name only a team, so keep those that name me.
const reviewMe = api<Pr[]>(
  'repos/issues/search?type=pulls&state=open&review_requested=true&page=1&limit=50',
).filter((pr) =>
  (api<Pr>(`repos/${repoOf(pr)}/pulls/${pr.number}`).requested_reviewers ?? []).some(
    (u) => u.login === me,
  ),
)
console.log(`## ${reviewMe.length} PR(s) that name me as a reviewer`)
for (const pr of reviewMe) {
  console.log(
    `- ${repoOf(pr)}#${pr.number} ${pr.title} (by ${pr.user.login}, ${day(pr.updated_at)}) ${pr.html_url}`,
  )
}
const myPrs = api<Pr[]>('repos/issues/search?type=pulls&state=open&created=true&page=1&limit=50')
console.log(`## ${myPrs.length} open PR(s) I opened`)
for (const pr of myPrs) {
  console.log(`- ${repoOf(pr)}#${pr.number} ${pr.title} (${day(pr.updated_at)}) ${pr.html_url}`)
}

const { org, maintainerFile, maintainerKey } = forgejo
if (maintainerFile && maintainerKey) {
  console.log('## Repos I maintain')
  const owner = new RegExp(`^${maintainerKey}:\\s*(\\S+)`, 'm')
  for (const repo of api<Repo[]>(`orgs/${org}/repos?page=1&limit=100`).filter((r) => !r.archived)) {
    const raw = Bun.spawnSync(['tea', 'api', `repos/${org}/${repo.name}/raw/${maintainerFile}`])
    const maintainer = owner.exec(raw.stdout.toString())?.[1]?.replace(/["']/g, '')
    if (maintainer?.split('@')[0] !== me) continue
    const branch = repo.default_branch
    const status = api<{ state: string }>(`repos/${org}/${repo.name}/commits/${branch}/status`)
    const prs = api<Pr[]>(`repos/${org}/${repo.name}/pulls?state=open&page=1&limit=50`)
    console.log(
      `### ${repo.name}: ${branch} CI ${status.state || 'none'}, ${repo.open_issues_count} open issue(s), ${prs.length} open PR(s)`,
    )
    for (const pr of prs) {
      const reviewers = (pr.requested_reviewers ?? []).map((u) => u.login).join(',')
      console.log(
        `- #${pr.number} ${pr.title} (by ${pr.user.login}, ${day(pr.updated_at)}${reviewers ? `, review requested ${reviewers}` : ''})`,
      )
    }
  }
}
