#!/usr/bin/env bun
// Merges one wide-research run: <dir>/plan.json and <dir>/results.jsonl become <dir>/table.md and
// <dir>/table.csv, and a summary goes to stdout. Any malformed line or missing item fails the whole
// merge with the reasons, so a gap never reaches the table looking like data.
// Usage: bun merge.ts <dir>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Cell = { value: string; source: string } | null
export type Result = { item: string; cells: Record<string, Cell>; note: string }
export type Plan = {
  title: string
  conditions: string
  columns: { name: string; spec: string }[]
  items: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// One line of results.jsonl, checked against the plan. Throws with the reason.
export function parse(line: string, plan: Plan): Result {
  const r: unknown = JSON.parse(line)
  if (
    !isObject(r) ||
    typeof r.item !== 'string' ||
    !isObject(r.cells) ||
    typeof r.note !== 'string'
  ) {
    throw new Error('not {"item", "cells", "note"}')
  }
  const { item, note } = r
  const raw = r.cells
  if (!plan.items.includes(item)) throw new Error(`item not in the plan: ${item}`)
  const names = plan.columns.map((c) => c.name)
  const extra = Object.keys(raw).filter((k) => !names.includes(k))
  if (extra.length > 0) throw new Error(`${item}: columns not in the plan: ${extra.join(', ')}`)
  const cells: Record<string, Cell> = {}
  for (const name of names) {
    if (!(name in raw)) throw new Error(`${item}: no "${name}"`)
    const c = raw[name]
    // Agents that found nothing write null, or an object whose value is null, "" or the word
    // "null". All of them mean the same empty cell; re-running the item for it would cost a whole
    // search to land on the same gap.
    const empty =
      c === null ||
      (isObject(c) &&
        (c.value === null ||
          (typeof c.value === 'string' && ['', 'null'].includes(c.value.trim().toLowerCase()))))
    if (empty) {
      cells[name] = null
      continue
    }
    if (
      !isObject(c) ||
      typeof c.value !== 'string' ||
      typeof c.source !== 'string' ||
      !/^https?:\/\//.test(c.source)
    ) {
      throw new Error(`${item}: "${name}" needs a value and an http(s) source, or null`)
    }
    cells[name] = { value: c.value, source: c.source }
  }
  return { item, cells, note }
}

// Every line, last one per item winning: re-running an item appends a line that replaces it.
export function collect(text: string, plan: Plan): { results: Result[]; errors: string[] } {
  const byItem = new Map<string, Result>()
  const errors: string[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    try {
      const r = parse(line, plan)
      byItem.set(r.item, r)
    } catch (error) {
      errors.push(`line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const missing = plan.items.filter((item) => !byItem.has(item))
  if (missing.length > 0) errors.push(`no result for: ${missing.join(', ')}`)
  const results = plan.items.flatMap((item) => byItem.get(item) ?? [])
  return { results, errors }
}

const md = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ')
const csv = (s: string) => `"${s.replaceAll('"', '""')}"`

export function table(plan: Plan, results: Result[]): string {
  const names = plan.columns.map((c) => c.name)
  const rows = results.map((r) => {
    const cells = names.map((n) => {
      const c = r.cells[n]
      return c === null || c === undefined ? '—' : `${md(c.value)} [↗](${c.source})`
    })
    return `| ${md(r.item)} | ${cells.join(' | ')} |`
  })
  const notes = results
    .filter((r) => r.note.trim() !== '')
    .map((r) => `- **${md(r.item)}**: ${md(r.note)}`)
  return [
    `# ${plan.title}`,
    '',
    `조건: ${plan.conditions}`,
    '',
    `| 항목 | ${names.map(md).join(' | ')} |`,
    `|${' --- |'.repeat(names.length + 1)}`,
    ...rows,
    ...(notes.length > 0 ? ['', '## 메모', '', ...notes] : []),
    '',
  ].join('\n')
}

export function csvTable(plan: Plan, results: Result[]): string {
  const names = plan.columns.map((c) => c.name)
  const header = ['항목', ...names.flatMap((n) => [n, `${n} 출처`]), '메모']
  const rows = results.map((r) => [
    r.item,
    ...names.flatMap((n) => {
      const c = r.cells[n]
      return c === null || c === undefined ? ['', ''] : [c.value, c.source]
    }),
    r.note,
  ])
  return `${[header, ...rows].map((row) => row.map(csv).join(',')).join('\n')}\n`
}

// `bun merge.ts add <dir>` appends the result lines on stdin to <dir>/results.jsonl, refusing all of
// them if any is not JSON: a broken line cannot be told apart from the item it was for, so a re-run
// could never replace it.
function add(dir: string, text: string): void {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const broken = lines.flatMap((l, i) => {
    try {
      JSON.parse(l)
      return []
    } catch {
      return [`line ${i + 1}: ${l.slice(0, 60)}`]
    }
  })
  if (broken.length > 0) {
    console.error(
      `not JSON, nothing added; give these items to the agents again:\n${broken.join('\n')}`,
    )
    process.exit(1)
  }
  appendFileSync(join(dir, 'results.jsonl'), `${lines.join('\n')}\n`)
  console.log(`added ${lines.length}`)
}

if (import.meta.main && Bun.argv[2] === 'add') {
  const dir = Bun.argv[3]
  if (dir === undefined) throw new Error('usage: bun merge.ts add <dir> < lines')
  add(dir, await Bun.stdin.text())
} else if (import.meta.main) {
  const dir = Bun.argv[2]
  if (dir === undefined) throw new Error('usage: bun merge.ts <dir>')
  const plan: Plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))
  const { results, errors } = collect(readFileSync(join(dir, 'results.jsonl'), 'utf8'), plan)
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  writeFileSync(join(dir, 'table.md'), table(plan, results))
  writeFileSync(join(dir, 'table.csv'), csvTable(plan, results))
  const names = plan.columns.map((c) => c.name)
  const empty = results
    .map((r) => ({ item: r.item, cols: names.filter((n) => r.cells[n] === null) }))
    .filter((e) => e.cols.length > 0)
  const filled = results.length * names.length - empty.reduce((n, e) => n + e.cols.length, 0)
  console.log(
    `항목 ${results.length}/${plan.items.length} · 채운 칸 ${filled}/${results.length * names.length}`,
  )
  for (const e of empty) console.log(`빈칸: ${e.item} — ${e.cols.join(', ')}`)
  console.log(`표: ${join(dir, 'table.md')}\nCSV: ${join(dir, 'table.csv')}`)
}
