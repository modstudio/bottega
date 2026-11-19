import { canonFrontmatter } from '../../../shared/canon-frontmatter.ts'
import { composeCanonRows } from './canon-hydrate.ts'
import { type CanonFile, classifyCanonFile } from './canon-lint.ts'

type CanonRowContent = { subject: string | null; slug: string; body: string }
export type PackBudgetTier = { bytes: number; label: string }

type PackCanonPart = { label: string; body: string }

export function joinPackSections(...sections: string[]): string {
  return sections.filter((section) => section.length > 0).join('\n\n')
}

export function renderPackDocSection(doc: { title: string; body: string }): string {
  return `## ${doc.title}\n\n${doc.body}`
}

export function renderPackBudgetBreach(input: {
  header: string
  tiers: readonly PackBudgetTier[]
  remedy: string
}): string {
  const tiers = input.tiers
    .filter((tier) => tier.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label))
  const largest = tiers[0]?.label
  return [
    input.header,
    ...tiers.map((tier) => `  ${tier.bytes}  ${tier.label}`),
    ...(largest ? [`largest packed tier: ${largest}`] : []),
    input.remedy,
  ].join('\n')
}

const CONTEXT_INDEX_HEADING = [
  '## Path-scoped contexts',
  '',
  'Read the context file in your worktree before editing a path it governs.',
].join('\n')

function contextIndexLine(row: Pick<CanonRowContent, 'slug' | 'body'>): string {
  const meta = canonFrontmatter(row.body)
  const description = meta?.description ?? ''
  const globs = (meta?.paths ?? []).map((path) => `\`${path}\``).join(', ')
  return `- \`${row.slug}\` — ${description} — ${globs}`
}

function packedCanonMarkdown(
  alwaysOnBodies: PackCanonPart[],
  contextRows: Pick<CanonRowContent, 'slug' | 'body'>[],
): {
  markdown: string
  alwaysOnBytes: number
  contextIndexBytes: number
  largestFile: { path: string; bytes: number } | null
} {
  const alwaysOn = joinPackSections(...alwaysOnBodies.map(({ body }) => body))
  const contextLines = contextRows.map((row) => ({ row, line: contextIndexLine(row) }))
  const index = contextLines.length
    ? `${CONTEXT_INDEX_HEADING}\n\n${contextLines.map(({ line }) => line).join('\n')}`
    : ''
  const largestFile = [
    ...alwaysOnBodies.map(({ label, body }) => ({ path: label, bytes: Buffer.byteLength(body) })),
    ...contextLines.map(({ row, line }) => ({
      path: row.slug,
      bytes: Buffer.byteLength(line),
    })),
  ].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))[0]
  return {
    markdown: joinPackSections(alwaysOn, index),
    alwaysOnBytes: Buffer.byteLength(alwaysOn),
    contextIndexBytes: Buffer.byteLength(index),
    largestFile: largestFile ?? null,
  }
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
  const alwaysOnFor = (subject: string | null) => [
    ...classified
      .filter(({ row, kind }) => row.subject === subject && kind === 'entry')
      .map(({ row }) => ({ label: row.slug, body: row.body })),
    ...classified
      .filter(({ row, kind }) => row.subject === subject && kind === 'rule')
      .map(({ row }) => ({ label: row.slug, body: row.body })),
  ]
  const packed = packedCanonMarkdown(
    [...alwaysOnFor(null), ...alwaysOnFor(projectName)],
    classified.filter(({ kind }) => kind === 'context').map(({ row }) => row),
  )
  return {
    markdown: packed.markdown,
    alwaysOnBytes: packed.alwaysOnBytes,
    contextIndexBytes: packed.contextIndexBytes,
  }
}

export function packedCanonMarkdownFromTree(files: CanonFile[]): {
  markdown: string
  alwaysOnBytes: number
  contextIndexBytes: number
  largestFile: { path: string; bytes: number } | null
} {
  const classified = files.map((file) => ({ file, kind: classifyCanonFile(file) }))
  return packedCanonMarkdown(
    classified
      .filter(({ kind }) => kind === 'entry' || kind === 'rule')
      .map(({ file }) => ({ label: file.path, body: file.text })),
    classified
      .filter(({ kind }) => kind === 'context')
      .map(({ file }) => ({ slug: file.path, body: file.text })),
  )
}
