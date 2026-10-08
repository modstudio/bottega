/** Owns document export and import filesystem representation. Must not know stores or transport. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_SCOPES, DOC_STATUSES, type DocScope, type DocStatus } from '../../../shared/docs.ts'
import type { Doc } from './doc-read-store.ts'
import { importedDocDelivery } from './doc-write-allowed.ts'

type ImportedDoc = {
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  status?: DocStatus
  replacementSlug?: string | null
  body: string
  delivery?: 'inject' | 'demand'
}

export function exportDocFiles(dir: string, docs: Doc[]): number {
  for (const doc of docs) {
    const target = join(dir, doc.scope, doc.subject ?? '_')
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, `${doc.slug}.md`),
      `---\ntitle: ${JSON.stringify(doc.title)}\nstatus: ${JSON.stringify(doc.status)}\nreplacement: ${JSON.stringify(doc.replacement_slug)}\n---\n\n${doc.body}`,
    )
  }
  return docs.length
}

function importedDoc(
  path: string,
  fileName: string,
): Omit<ImportedDoc, 'scope' | 'subject' | 'slug' | 'delivery'> {
  const raw = readFileSync(path, 'utf8')
  const match = raw.match(
    /^---\r?\ntitle:\s*(.+)\r?\n(?:status:\s*(.+)\r?\nreplacement:\s*(.+)\r?\n)?---\r?\n(?:\r?\n)?([\s\S]*)$/,
  )
  if (!match) throw new Error(`${fileName}: expected YAML frontmatter with a title`)
  let title: unknown
  try {
    title = JSON.parse(match[1]!)
  } catch {
    throw new Error(`${fileName}: title must be a YAML double-quoted string`)
  }
  if (typeof title !== 'string') throw new Error(`${fileName}: title must be a string`)
  const status = match[2] === undefined ? undefined : JSON.parse(match[2])
  const replacementSlug = match[3] === undefined ? undefined : JSON.parse(match[3])
  if (status !== undefined && !DOC_STATUSES.includes(status)) {
    throw new Error(`${fileName}: status must be ${DOC_STATUSES.join(', ')}`)
  }
  if (
    replacementSlug !== undefined &&
    replacementSlug !== null &&
    typeof replacementSlug !== 'string'
  ) {
    throw new Error(`${fileName}: replacement must be a string or null`)
  }
  return { title, status, replacementSlug, body: match[4]! }
}

export async function importDocFiles(
  dir: string,
  write: (doc: ImportedDoc) => Promise<void>,
): Promise<number> {
  let count = 0
  for (const scopeEntry of readdirSync(dir, { withFileTypes: true })) {
    if (!scopeEntry.isDirectory()) continue
    if (!DOC_SCOPES.includes(scopeEntry.name as DocScope)) {
      throw new Error(
        `unknown doc scope "${scopeEntry.name}"; valid scopes: ${DOC_SCOPES.join(', ')}`,
      )
    }
    const scope = scopeEntry.name as DocScope
    for (const subjectEntry of readdirSync(join(dir, scope), { withFileTypes: true })) {
      if (!subjectEntry.isDirectory()) continue
      count += await importSubjectFiles(dir, scope, subjectEntry.name, write)
    }
  }
  return count
}

async function importSubjectFiles(
  dir: string,
  scope: DocScope,
  subjectDirectory: string,
  write: (doc: ImportedDoc) => Promise<void>,
): Promise<number> {
  const subject = subjectDirectory === '_' ? null : subjectDirectory
  const documents: ImportedDoc[] = []
  for (const file of readdirSync(join(dir, scope, subjectDirectory), { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.md')) continue
    documents.push({
      scope,
      subject,
      slug: file.name.slice(0, -3),
      ...importedDoc(join(dir, scope, subjectDirectory, file.name), file.name),
      delivery: importedDocDelivery(scope),
    })
  }
  const bySlug = new Map(documents.map((document) => [document.slug, document]))
  const ordered: ImportedDoc[] = []
  const visited = new Set<string>()
  const visit = (document: ImportedDoc): void => {
    if (visited.has(document.slug)) return
    visited.add(document.slug)
    if (document.status === 'superseded' && document.replacementSlug) {
      const replacement = bySlug.get(document.replacementSlug)
      if (replacement) visit(replacement)
    }
    ordered.push(document)
  }
  for (const document of documents) visit(document)
  for (const document of ordered) {
    await write(document)
  }
  return documents.length
}
