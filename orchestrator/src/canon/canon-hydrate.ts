// concern: canon-hydrate
/** Knows the pure mirror plan for stored canon. Must not know filesystems, stores, commands, runs, routing, or transports. */
import { posix } from 'node:path'
import { type CanonFile, classifyCanonFile } from './canon-lint.ts'
import { mapUserCanonPath } from './user-canon-home.ts'

export type CanonRow = { slug: string; body: string }
export type AddressedCanonRow = CanonRow & { subject: string | null; owner?: string | null }
export type HydrationPlan = {
  writes: { path: string; body: string }[]
  links: { path: string; target: string }[]
  deletes: string[]
}

/** Repository rows share a tree namespace; user rows occupy their separate Claude-home namespace. */
export function composeCanonRows<
  G extends AddressedCanonRow,
  U extends AddressedCanonRow,
  P extends AddressedCanonRow,
>(globalRows: G[], userRows: U[], projectRows: P[]): (G | U | P)[] {
  const levels = [globalRows, userRows, projectRows] as AddressedCanonRow[][]
  const address = (row: AddressedCanonRow) =>
    row.owner ? `canon/@${row.owner}/${row.slug}` : `canon/${row.subject ?? '_'}/${row.slug}`
  const renderKey = (row: AddressedCanonRow) => {
    if (!row.owner) return `repo:${row.slug}`
    const homePath = mapUserCanonPath({ kind: 'canon', path: row.slug })
    if (!homePath)
      throw new Error(`refusing user canon slug with no Claude home mapping: ${row.slug}`)
    return `home:${homePath}`
  }
  const seen = new Map<string, AddressedCanonRow>()
  for (const rows of levels) {
    for (const row of rows) {
      const key = renderKey(row)
      const prior = seen.get(key)
      if (prior) {
        throw new Error(
          `refusing canon path collision: ${address(prior)} and ${address(row)} render to the same path`,
        )
      }
      seen.set(key, row)
    }
  }
  return [...globalRows, ...userRows, ...projectRows]
}

function generatedLinks(rows: CanonRow[]): { path: string; target: string }[] {
  const links = rows
    .filter(({ slug }) => posix.basename(slug) === 'AGENTS.md')
    .map(({ slug }) => ({
      path: posix.join(posix.dirname(slug), 'CLAUDE.md'),
      target: 'AGENTS.md',
    }))
  if (rows.some(({ slug }) => /^\.agents\/rules\/[^/]+\.md$/.test(slug))) {
    links.push({ path: '.claude/rules', target: '../.agents/rules' })
  }
  if (rows.some(({ slug }) => /^\.agents\/contexts\/[^/]+\.md$/.test(slug))) {
    links.push({ path: '.agents/rules/contexts', target: '../contexts' })
  }
  return links.sort((a, b) => a.path.localeCompare(b.path))
}

export function planHydration(input: { rows: CanonRow[]; tree: CanonFile[] }): HydrationPlan {
  for (const row of input.rows) {
    if (!classifyCanonFile({ path: row.slug, text: row.body })) {
      throw new Error(`refusing non-canon slug ${JSON.stringify(row.slug)}`)
    }
  }
  const tree = new Map(input.tree.map((file) => [file.path, file]))
  const links = generatedLinks(input.rows)
  const linkPaths = new Set(links.map(({ path }) => path))
  const rowPaths = new Set(input.rows.map(({ slug }) => slug))
  return {
    writes: input.rows
      .filter(({ slug, body }) => {
        const file = tree.get(slug)
        return !file || file.symlinkTarget !== undefined || file.text !== body
      })
      .map(({ slug, body }) => ({ path: slug, body }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    links: links.filter(({ path, target }) => tree.get(path)?.symlinkTarget !== target),
    deletes: input.tree
      .filter(
        (file) =>
          classifyCanonFile(file) !== null && !rowPaths.has(file.path) && !linkPaths.has(file.path),
      )
      .map(({ path }) => path)
      .sort(),
  }
}
