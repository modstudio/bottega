/** Owns document export and import filesystem representation. Must not know stores or transport. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  DOC_KINDS,
  DOC_SCOPES,
  DOC_STATUSES,
  type DocAudiences,
  type DocKind,
  type DocScope,
  type DocStatus,
  normalizeDocAudiences,
} from '../../../shared/docs.ts'
import type { Doc } from './doc-read-store.ts'
import { importedDocDelivery } from './doc-write-allowed.ts'

type ImportedDoc = {
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  status?: DocStatus
  kind?: DocKind
  audiences?: DocAudiences
  replacementSlug?: string | null
  body: string
  delivery?: 'inject' | 'demand'
}

type DocFileAddress = Pick<Doc, 'scope' | 'subject' | 'slug'>
type ExportedDoc = Pick<
  Doc,
  | 'scope'
  | 'subject'
  | 'slug'
  | 'title'
  | 'status'
  | 'kind'
  | 'audiences'
  | 'replacement_slug'
  | 'body'
>

const DOC_FILE_SUFFIX = '.md'
const NULL_SUBJECT_DIRECTORY = '_'

function unsafeDocPathPart(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[\\/]/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]+/).includes('..')
  )
}

export function docFileRelativePath(doc: DocFileAddress): string {
  const subject = doc.subject ?? NULL_SUBJECT_DIRECTORY
  if (unsafeDocPathPart(subject) || unsafeDocPathPart(doc.slug)) {
    throw new Error(
      `refusing doc file path for scope ${JSON.stringify(doc.scope)}, subject ${JSON.stringify(doc.subject)}, slug ${JSON.stringify(doc.slug)}: subject and slug must be relative with no .. segment`,
    )
  }
  return join(doc.scope, subject, `${doc.slug}${DOC_FILE_SUFFIX}`)
}

export function docSlugFromFilePath(subjectDirectory: string, filePath: string): string {
  const relativePath = relative(subjectDirectory, filePath).split(sep).join('/')
  return relativePath.slice(0, relativePath.lastIndexOf(DOC_FILE_SUFFIX))
}

export function exportDocFiles(dir: string, docs: ExportedDoc[]): number {
  for (const doc of docs) {
    const target = join(dir, docFileRelativePath(doc))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(
      target,
      `---\ntitle: ${JSON.stringify(doc.title)}\nstatus: ${JSON.stringify(doc.status)}\nkind: ${JSON.stringify(doc.kind)}\naudiences: ${JSON.stringify(doc.audiences)}\nreplacement: ${JSON.stringify(doc.replacement_slug)}\n---\n\n${doc.body}`,
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
    /^---\r?\ntitle:\s*(.+)\r?\n(?:status:\s*(.+)\r?\n(?:kind:\s*(.+)\r?\n)?(?:audiences:\s*(.+)\r?\n)?replacement:\s*(.+)\r?\n)?---\r?\n(?:\r?\n)?([\s\S]*)$/,
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
  const kind = match[3] === undefined ? undefined : JSON.parse(match[3])
  const audiences = match[4] === undefined ? undefined : normalizeDocAudiences(JSON.parse(match[4]))
  const replacementSlug = match[5] === undefined ? undefined : JSON.parse(match[5])
  if (status !== undefined && !DOC_STATUSES.includes(status)) {
    throw new Error(`${fileName}: status must be ${DOC_STATUSES.join(', ')}`)
  }
  if (kind !== undefined && !DOC_KINDS.includes(kind)) {
    throw new Error(`${fileName}: kind must be ${DOC_KINDS.join(', ')}`)
  }
  if (
    replacementSlug !== undefined &&
    replacementSlug !== null &&
    typeof replacementSlug !== 'string'
  ) {
    throw new Error(`${fileName}: replacement must be a string or null`)
  }
  return { title, status, kind, audiences, replacementSlug, body: match[6]! }
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
  const subject = subjectDirectory === NULL_SUBJECT_DIRECTORY ? null : subjectDirectory
  const documents: ImportedDoc[] = []
  const subjectPath = join(dir, scope, subjectDirectory)
  for (const filePath of docFilesWithin(subjectPath)) {
    const slug = docSlugFromFilePath(subjectPath, filePath)
    documents.push({
      scope,
      subject,
      slug,
      ...importedDoc(filePath, `${slug}${DOC_FILE_SUFFIX}`),
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

function docFilesWithin(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...docFilesWithin(path))
    else if (entry.isFile() && entry.name.endsWith(DOC_FILE_SUFFIX)) files.push(path)
  }
  return files
}
