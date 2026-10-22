// Reads Plane work items and comments on them. The token comes from the keychain item plane-api.
// Usage: bun <skill folder>/sources/plane/plane.ts              open items assigned to me, and open
//                                                                 items I created for others
//        bun <skill folder>/sources/plane/plane.ts get <key>...   the state and last comment of items
//        bun <skill folder>/sources/plane/plane.ts comment <key>  stdin's text as a comment
// Settings (config.json's plane): url, workspace, projects (the identifiers to scan).
import { loadConfig } from '../config'

// The Plane API (v1) responses, with only the fields read here.
type Project = { id: string; identifier: string }
type State = { id: string; name: string; group: string }
type Item = {
  id: string
  name: string
  sequence_id: number
  project: string
  state: string
  assignees: string[]
  target_date: string | null
  updated_at: string
}
type Comment = { actor: string; created_at: string; comment_html: string }
type Member = { id: string; display_name: string }
type Page<T> = T[] | { results: T[]; next_page_results?: boolean; next_cursor?: string }

const DONE = new Set(['completed', 'cancelled'])
const MAX_TRIES = 5
// Items I created for others get their last comment read only if they moved this recently: one
// call each, and the server blocks a burst of calls for about 15 minutes.
const RECENT_DAYS = 7

// The newest comment as one line: who, when (local time), and the start of the text. A reply
// to something I asked shows here even when no state changed.
export function lastComment(comments: Comment[], names: Map<string, string>): string | null {
  const last = comments.toSorted((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  if (!last) return null
  const text = last.comment_html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  const when = new Date(last.created_at).toLocaleString('sv-SE').slice(5, 16)
  const who = names.get(last.actor) ?? last.actor
  return `  ↳ last comment ${who} ${when}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`
}

// Blank-line paragraphs become <p>, line breaks <br>: Plane takes comments as HTML.
export const toHtml = (text: string) =>
  text
    .trim()
    .split(/\n\s*\n/)
    .map(
      (p) =>
        `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`,
    )
    .join('')

async function connect() {
  const plane = (await loadConfig()).plane
  if (!plane)
    throw new Error('config.json has no plane; follow sources/plane/SOURCE.md to set it up')
  const token = Bun.spawnSync([
    'security',
    'find-generic-password',
    '-s',
    'plane-api',
    '-a',
    `${process.env.USER}`,
    '-w',
  ])
  if (token.exitCode !== 0) {
    throw new Error('no plane-api token in the keychain; follow sources/plane/SOURCE.md to add it')
  }
  const headers = {
    'X-API-Key': token.stdout.toString().trim(),
    'Content-Type': 'application/json',
  }
  const api = `${plane.url}/api/v1`
  const ws = `${api}/workspaces/${plane.workspace}`

  async function call<T>(url: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (res.status === 429 && attempt < MAX_TRIES) {
        await Bun.sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000)
        continue
      }
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`Plane ${url.slice(api.length)} → ${res.status} ${text.slice(0, 200)}`)
      }
      return JSON.parse(text)
    }
  }
  async function all<T>(url: string): Promise<T[]> {
    const sep = url.includes('?') ? '&' : '?'
    let found: T[] = []
    let cursor = ''
    for (;;) {
      const page = await call<Page<T>>(`${url}${sep}per_page=100${cursor && `&cursor=${cursor}`}`)
      if (Array.isArray(page)) return page
      found = found.concat(page.results)
      if (!page.next_page_results || !page.next_cursor) return found
      cursor = page.next_cursor
    }
  }
  const stateCache = new Map<string, Map<string, State>>()
  async function states(projectId: string) {
    const cached = stateCache.get(projectId)
    if (cached) return cached
    const fetched = new Map(
      (await all<State>(`${ws}/projects/${projectId}/states/`)).map((s) => [s.id, s]),
    )
    stateCache.set(projectId, fetched)
    return fetched
  }
  const browse = (key: string) => `${plane.url}/${plane.workspace}/browse/${key}/`
  let memberNames: Map<string, string> | undefined
  async function commentLine(item: Item) {
    memberNames ??= new Map(
      (await all<Member>(`${ws}/members/`)).map((m) => [m.id, m.display_name]),
    )
    const url = `${ws}/projects/${item.project}/work-items/${item.id}/comments/`
    return lastComment(await all<Comment>(url), memberNames)
  }
  return { plane, api, ws, call, all, states, browse, commentLine }
}

if (import.meta.main) {
  const [command = 'mine', ...keys] = Bun.argv.slice(2)
  const { plane, api, ws, call, all, states, browse, commentLine } = await connect()

  if (command === 'mine') {
    const me = await call<{ id: string }>(`${api}/users/me/`)
    const projects = await all<Project>(`${ws}/projects/`)
    for (const identifier of plane.projects) {
      const project = projects.find((p) => p.identifier === identifier)
      if (!project)
        throw new Error(`Plane has no project ${identifier} (config.json plane.projects)`)
      const projectStates = await states(project.id)
      // The server filters by assignee; a Plane that does not know the filter ignores it, so filter
      // again here. All items took 2m41s (114 pages of 10,000-odd items); filtered, 2.5s.
      const url = `${ws}/projects/${project.id}/work-items/?assignees=${me.id}`
      const mine = (await all<Item>(url)).filter(
        (i) => i.assignees.includes(me.id) && !DONE.has(projectStates.get(i.state)?.group ?? ''),
      )
      console.log(`## ${identifier}: ${mine.length} open item(s) assigned to me`)
      for (const i of mine.sort((a, b) => a.sequence_id - b.sequence_id)) {
        const key = `${identifier}-${i.sequence_id}`
        const state = projectStates.get(i.state)?.name ?? '?'
        const due = i.target_date ? `, due ${i.target_date}` : ''
        console.log(`- ${key} ${i.name} (${state}${due}) ${browse(key)}`)
      }
    }

    // What I asked of others: answers come as comments on these, in any project, while the
    // state often stays where it was.
    const pql = encodeURIComponent('createdBy = currentUser() AND stateGroup IN openStates()')
    const asked = (await all<Item>(`${ws}/work-items/?pql=${pql}`)).filter(
      (i) => !i.assignees.includes(me.id),
    )
    const recent = Date.now() - RECENT_DAYS * 86_400_000
    console.log(`## ${asked.length} open item(s) I created for others`)
    for (const i of asked.toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))) {
      const project = projects.find((p) => p.id === i.project)
      if (!project) throw new Error(`Plane item ${i.id} is in a project not listed for me`)
      const key = `${project.identifier}-${i.sequence_id}`
      const state = (await states(i.project)).get(i.state)?.name ?? '?'
      console.log(
        `- ${key} ${i.name} (${state}, updated ${i.updated_at.slice(0, 10)}) ${browse(key)}`,
      )
      if (Date.parse(i.updated_at) >= recent) {
        const line = await commentLine(i)
        if (line) console.log(line)
      }
    }
  } else if (command === 'get') {
    for (const key of keys) {
      const item = await call<Item>(`${ws}/work-items/${key}/`)
      const state = (await states(item.project)).get(item.state)
      console.log(
        `- ${key} ${state?.group ?? '?'} ${state?.name ?? '?'} ${item.name} ${browse(key)}`,
      )
      const line = await commentLine(item)
      if (line) console.log(line)
    }
  } else if (command === 'comment') {
    const [key] = keys
    const text = await Bun.stdin.text()
    if (!key || !text.trim()) throw new Error('usage: echo "<text>" | plane.ts comment <key>')
    const item = await call<Item>(`${ws}/work-items/${key}/`)
    await call(`${ws}/projects/${item.project}/work-items/${item.id}/comments/`, {
      comment_html: toHtml(text),
    })
    console.log(`commented: ${browse(key)}`)
  } else {
    throw new Error(`unknown command ${command}: mine, get <key>..., comment <key>`)
  }
}
