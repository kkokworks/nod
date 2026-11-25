import { linksOf } from './done'
import { FINISHED, type Ledger, type Task } from './ledger'
import { message } from './proc'
import { type LinkedPr, type PrReads, prAddress, ServiceDown } from './prs'

// Tells the session that hears of a task (inbox.ts) what happened on its pull request: a review that
// approves, asks for changes or comments, and CI that failed on its head. Not the worker: what of a
// review to do and in what order is for the session and the person to settle first. Of the open pull
// requests linked to a finished task gc has not collected; the fifth-minute tick reads them, one at a
// time. Each thing is told once, by the keys its notice keeps (addPrNotice). A notice says which
// pull request, who, and what, never what they wrote: that is outside text, which a session could
// take for instructions.

// What a review's state says, as GitHub or as Gitea and Forgejo name it. Any other (one not sent yet,
// asked for, dismissed) tells nothing.
const COMMENTED = 'left review comments'
const WHAT: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  REQUEST_CHANGES: 'requested changes',
  COMMENTED,
  COMMENT: COMMENTED,
}

type Happened = { who: string | null; what: string; at: string | null; key: string }

export async function tellPrEvents(
  ledger: Ledger,
  lookup: (url: string) => Promise<LinkedPr | null>,
  reads: PrReads,
): Promise<void> {
  // A pull request several tasks link is the last one's, so each thing on it is told once.
  const linked = new Map<string, Task>()
  for (const task of ledger.list()) {
    if (task.collectedAt !== null || !FINISHED.has(task.status)) continue
    for (const url of linksOf(ledger, task)) {
      const address = prAddress(url)
      if (address !== null) linked.set(address, task)
    }
  }
  const known = ledger.prKeys()
  // A service that fails or turns a read away gets no more of them this time; what one pull request
  // alone fails on holds back only that. Either way the next time tells what this one could not.
  const down = new Set<string>()
  const read = async <T>(url: string, ask: () => Promise<T>): Promise<T | null> => {
    const { host } = new URL(url)
    if (down.has(host)) return null
    try {
      return await ask()
    } catch (error) {
      if (error instanceof ServiceDown) down.add(host)
      console.error(`nod: could not read what happened on ${url}: ${message(error)}`)
      return null
    }
  }
  for (const [url, task] of linked) {
    const pr = await read(url, () => lookup(url))
    if (pr?.state !== 'open') continue
    const happened: Happened[] = []
    // How many comments each review held when nod last read them, told or not.
    const counts: string[] = []
    for (const r of pr.reviews) {
      const what = WHAT[r.state]
      const id = `${url}#${r.id}`
      if (what !== undefined) happened.push({ who: r.login, what, at: r.at, key: id })
      // ponytail: one taken back and another added between two reads go unseen, as many as before.
      const count = `${id}/${r.comments}`
      if ((what === undefined && r.state !== 'DISMISSED') || r.comments === 0 || known.has(count))
        continue
      const comments = await read(url, () => reads.comments(url, r.id))
      if (comments === null) continue
      counts.push(count)
      for (const c of comments)
        happened.push({ who: c.login, what: COMMENTED, at: c.at, key: `${url}#c${c.id}` })
    }
    const since = Date.parse(task.createdAt)
    const news = happened.filter(
      // Not what the account that opened it wrote, nor what was there before the task, which was
      // added with it, to answer it say.
      (h) => h.who !== pr.author && Date.parse(h.at ?? '') >= since && !known.has(h.key),
    )
    // Several of one kind by one person (a comment on each of ten lines) are one line.
    for (const same of Map.groupBy(news, (h) => `${h.what} ${h.who}`).values()) {
      const { who, what } = same[0] as Happened
      const line = `${url}: ${shownLogin(who)} ${what}`
      ledger.addPrNotice(
        task.id,
        line,
        same.map((h) => h.key),
      )
    }
    if (counts.length > 0) ledger.addPrNotice(task.id, null, counts)

    const failed = await read(url, () => reads.failedHead(url, pr.sha))
    if (failed === null) continue
    const line = `${url}: CI failed on its head ${failed.slice(0, 8)}`
    ledger.addPrNotice(task.id, line, [`${url}#ci ${failed}`])
  }
}

// A login is outside text too: no more of it than the services' own rules let one hold.
const shownLogin = (login: string | null): string =>
  login === null ? 'someone' : login.replace(/[^\w.@[\]-]/g, '?').slice(0, 64)
