// Stands in for gh and tea in tests, as `fake-git-service.ts <gh|tea> <args...>`: the calls nod
// makes to open, read and squash merge pull requests (serviceOf in prs.ts), against a local bare
// repo standing in for the remote. It keeps its state in $FAKE_SERVICE: the bare repo's path in
// `origin`, the pull requests in `prs.json`, and each call in `calls.jsonl`. A file `merge-state`
// overrides what gh reports a pull request's mergeStateStatus is (tea's `mergeable` is false for
// anything but CLEAN), and a file `refuse` makes creating and merging fail with its text.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Pr = {
  number: number
  url: string
  head: string
  base: string
  title: string
  body: string
  state: 'open' | 'merged' | 'closed'
}

const dir = process.env.FAKE_SERVICE
if (!dir) throw new Error('FAKE_SERVICE is not set')
const [tool, ...args] = process.argv.slice(2)
const stdin = args.includes('-') || args.includes('@-') ? await Bun.stdin.text() : ''
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool, args, stdin })}\n`)

const prsFile = join(dir, 'prs.json')
const prs: Pr[] = existsSync(prsFile) ? JSON.parse(readFileSync(prsFile, 'utf8')) : []
const save = (): void => writeFileSync(prsFile, JSON.stringify(prs))
const origin = readFileSync(join(dir, 'origin'), 'utf8').trim()
const git = (...a: string[]): string => {
  const r = Bun.spawnSync(
    ['git', '-c', 'user.name=service', '-c', 'user.email=service@example.invalid', ...a],
    { cwd: origin },
  )
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const headOf = (pr: Pr): string => git('rev-parse', `refs/heads/${pr.head}`)
const mergeState = (): string =>
  existsSync(join(dir, 'merge-state'))
    ? readFileSync(join(dir, 'merge-state'), 'utf8').trim()
    : 'CLEAN'
const refuse = (): void => {
  if (!existsSync(join(dir, 'refuse'))) return
  console.error(readFileSync(join(dir, 'refuse'), 'utf8').trim())
  process.exit(1)
}
const opt = (name: string): string => {
  const i = args.indexOf(name)
  const value = i === -1 ? undefined : args[i + 1]
  if (value === undefined) throw new Error(`no ${name} in ${args.join(' ')}`)
  return value
}
const byUrl = (url: string): Pr => {
  const pr = prs.find((p) => p.url === url)
  if (pr === undefined) {
    console.error(`no pull request ${url}`)
    process.exit(1)
  }
  return pr
}
const create = (
  repo: string,
  host: string,
  path: string,
  p: Omit<Pr, 'number' | 'url' | 'state'>,
) => {
  refuse()
  const number = prs.length + 1
  const pr: Pr = { ...p, number, url: `https://${host}/${repo}/${path}/${number}`, state: 'open' }
  prs.push(pr)
  save()
  return pr
}
// As a squash merge does: one commit with the head's tree on top of the base, which the head must
// already sit on for the tree to be right.
const squash = (pr: Pr, head: string, title: string): void => {
  refuse()
  if (head !== headOf(pr)) {
    console.error('head commit does not match')
    process.exit(1)
  }
  const parent = git('rev-parse', `refs/heads/${pr.base}`)
  const commit = git('commit-tree', `${head}^{tree}`, '-p', parent, '-m', title)
  git('update-ref', `refs/heads/${pr.base}`, commit)
  pr.state = 'merged'
  save()
}

if (tool === 'gh') {
  const [, sub] = args
  if (sub === 'list') {
    const head = opt('--head')
    const shown = prs
      .filter((p) => p.head === head)
      .map((p) => ({ url: p.url, state: p.state.toUpperCase() }))
    console.log(JSON.stringify(shown))
  } else if (sub === 'create') {
    const pr = create(opt('--repo'), 'github.com', 'pull', {
      head: opt('--head'),
      base: opt('--base'),
      title: opt('--title'),
      body: stdin,
    })
    console.log(`Creating pull request\n${pr.url}`)
  } else if (sub === 'view') {
    const pr = byUrl(args[2] ?? '')
    const status = mergeState()
    console.log(
      JSON.stringify({
        state: pr.state.toUpperCase(),
        mergeable: status === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE',
        mergeStateStatus: status,
        headRefOid: headOf(pr),
      }),
    )
  } else if (sub === 'merge') {
    if (!args.includes('--squash')) throw new Error('only squash merges')
    squash(byUrl(args[2] ?? ''), opt('--match-head-commit'), opt('--subject'))
  } else {
    throw new Error(`fake gh does not know ${args.join(' ')}`)
  }
} else if (tool === 'tea') {
  const endpoint = args.at(-1) ?? ''
  const post = args.includes('POST')
  const body = post ? JSON.parse(stdin) : null
  const list = /^repos\/([^/]+\/[^/]+)\/pulls\?/.exec(endpoint)
  const one = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/merge)?$/.exec(endpoint)
  const toApi = (p: Pr) => ({
    html_url: p.url,
    state: p.state === 'open' ? 'open' : 'closed',
    merged: p.state === 'merged',
    mergeable: mergeState() === 'CLEAN',
    head: { ref: p.head, sha: headOf(p) },
  })
  if (list !== null) {
    console.log(JSON.stringify(prs.map(toApi)))
  } else if (post && /^repos\/[^/]+\/[^/]+\/pulls$/.test(endpoint)) {
    const repo = endpoint.split('/').slice(1, 3).join('/')
    const pr = create(repo, 'git.example.com', 'pulls', body)
    console.log(JSON.stringify(toApi(pr)))
  } else if (one !== null) {
    const pr = byUrl(`https://git.example.com/${one[1]}/pulls/${one[2]}`)
    if (one[3] === undefined) console.log(JSON.stringify(toApi(pr)))
    else {
      if (body.Do !== 'squash') throw new Error('only squash merges')
      squash(pr, body.head_commit_id, body.MergeTitleField)
    }
  } else {
    throw new Error(`fake tea does not know ${args.join(' ')}`)
  }
} else {
  throw new Error(`fake git service: no ${tool}`)
}
