import { canonFrontmatter } from '../../../shared/canon-frontmatter.ts'
import { composeCanonRows } from './canon-hydrate.ts'
import { type CanonFile, classifyCanonFile } from './canon-lint.ts'

type CanonRowContent = { subject: string | null; slug: string; body: string }

export function joinPackSections(...sections: string[]): string {
  return sections.filter((section) => section.length > 0).join('\n\n')
}

export function renderPackDocSection(doc: { title: string; body: string }): string {
  return `## ${doc.title}\n\n${doc.body}`
}

const CONTEXT_INDEX_HEADING = [
  '## Path-scoped contexts',
  '',
  'Read the context file in your worktree before editing a path it governs.',
].join('\n')

function contextIndexMarkdown(rows: Pick<CanonRowContent, 'slug' | 'body'>[]): string {
  if (!rows.length) return ''
  const lines = rows.map((row) => {
    const meta = canonFrontmatter(row.body)
    const description = meta?.description ?? ''
    const globs = (meta?.paths ?? []).map((path) => `\`${path}\``).join(', ')
    return `- \`${row.slug}\` — ${description} — ${globs}`
  })
  return `${CONTEXT_INDEX_HEADING}\n\n${lines.join('\n')}`
}

export function packedCanonMarkdownFromRows(
  projectName: string | null,
  globalRows: CanonRowContent[],
  projectRows: CanonRowContent[],
): { markdown: string; alwaysOnBytes: number; contextIndexBytes: number } {
  if (!projectName) return { markdown: '', alwaysOnBytes: 0, contextIndexBytes: 0 }
  const rows = composeCanonRows(globalRows, [], projectRows)
  if (!rows.length) return { markdown: '', alwaysOnBytes: 0, contextIndexBytes: 0 }
  const classified = rows.map((row) => ({
    row,
    kind: classifyCanonFile({ path: row.slug, text: row.body }),
  }))
  const alwaysOnFor = (subject: string | null) =>
    joinPackSections(
      ...classified
        .filter(({ row, kind }) => row.subject === subject && kind === 'entry')
        .map(({ row }) => row.body),
      ...classified
        .filter(({ row, kind }) => row.subject === subject && kind === 'rule')
        .map(({ row }) => row.body),
    )
  const alwaysOn = joinPackSections(alwaysOnFor(null), alwaysOnFor(projectName))
  const index = contextIndexMarkdown(
    classified.filter(({ kind }) => kind === 'context').map(({ row }) => row),
  )
  return {
    markdown: joinPackSections(alwaysOn, index),
    alwaysOnBytes: Buffer.byteLength(alwaysOn),
    contextIndexBytes: Buffer.byteLength(index),
  }
}

export function packedCanonMarkdownFromTree(files: CanonFile[]): {
  markdown: string
  alwaysOnBytes: number
  contextIndexBytes: number
  largestFile: { path: string; bytes: number } | null
} {
  const classified = files.map((file) => ({ file, kind: classifyCanonFile(file) }))
  const alwaysOn = joinPackSections(
    ...classified
      .filter(({ kind }) => kind === 'entry' || kind === 'rule')
      .map(({ file }) => file.text),
  )
  const index = contextIndexMarkdown(
    classified
      .filter(({ kind }) => kind === 'context')
      .map(({ file }) => ({ slug: file.path, body: file.text })),
  )
  return {
    markdown: joinPackSections(alwaysOn, index),
    alwaysOnBytes: Buffer.byteLength(alwaysOn),
    contextIndexBytes: Buffer.byteLength(index),
    largestFile:
      files
        .map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.text) }))
        .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))[0] ?? null,
  }
}
