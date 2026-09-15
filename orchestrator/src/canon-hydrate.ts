// concern: canon-hydrate
/** Knows the pure mirror plan for stored canon. Must not know filesystems, stores, commands, runs, routing, or transports. */
import { posix } from 'node:path'
import { type CanonFile, classifyCanonFile } from './canon-lint.ts'

export type CanonRow = { slug: string; body: string }
export type HydrationPlan = {
  writes: { path: string; body: string }[]
  links: { path: string; target: string }[]
  deletes: string[]
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
