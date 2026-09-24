// concern: retrieval-corpus
/** Builds bounded, overlapping retrieval units from the repository source corpus. */
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'

export type Chunk = {
  id: string
  path: string
  identity: CorpusIdentity
  startLine: number
  endLine: number
  text: string
}

export type DocIdentity = { kind: 'doc'; scope: string; subject: string | null; slug: string }
type CorpusIdentity = { kind: 'code'; path: string } | DocIdentity

export type DocRow = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
}

const SOURCE_GLOBS = [
  'orchestrator/src/**/*.ts',
  'hub/src/**/*.ts',
  'shared/**/*.ts',
  'scripts/**/*.ts',
  '.agents/**/*.md',
] as const

export function chunkText(path: string, text: string, size = 60, overlap = 10): Chunk[] {
  if (size <= overlap || overlap < 0)
    throw new Error('chunk size must exceed a non-negative overlap')
  const lines = text.split('\n')
  const chunks: Chunk[] = []
  for (let start = 0; start < lines.length; start += size - overlap) {
    const end = Math.min(start + size, lines.length)
    const body = lines.slice(start, end).join('\n').trim()
    if (body) {
      const startLine = start + 1
      chunks.push({
        id: `${path}:${startLine}-${end}`,
        path,
        identity: { kind: 'code', path },
        startLine,
        endLine: end,
        text: body,
      })
    }
    if (end === lines.length) break
  }
  return chunks
}

export function docIdentity(identity: Omit<DocIdentity, 'kind'>): string {
  return `doc:${identity.scope}/${identity.subject ?? '_'}/${identity.slug}`
}

const DOC_CHUNK_OVERLAP_CHARACTERS = 512
const DOC_CHUNK_PREFIX_RESERVE = 32

export function chunkDoc(doc: DocRow, maxCharacters: number): Chunk[] {
  const identity: DocIdentity = {
    kind: 'doc',
    scope: doc.scope,
    subject: doc.subject,
    slug: doc.slug,
  }
  const path = docIdentity(identity)
  const text = `# ${doc.title}\n\n${doc.body}`
  const textLimit = maxCharacters - path.length - DOC_CHUNK_PREFIX_RESERVE
  if (textLimit <= DOC_CHUNK_OVERLAP_CHARACTERS) {
    throw new Error('doc character limit must leave room for chunk identity and overlap')
  }
  const chunks: Chunk[] = []
  for (let start = 0; start < text.length; start += textLimit - DOC_CHUNK_OVERLAP_CHARACTERS) {
    const end = Math.min(start + textLimit, text.length)
    const body = text.slice(start, end).trim()
    if (body) {
      const startLine = text.slice(0, start).split('\n').length
      const endLine = startLine + text.slice(start, end).split('\n').length - 1
      chunks.push({
        id: `${path}:chars-${start}-${end}`,
        path,
        identity,
        startLine,
        endLine,
        text: body,
      })
    }
    if (end === text.length) break
  }
  return chunks
}

function isDocRow(value: unknown): value is DocRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.scope === 'string' &&
    (typeof row.subject === 'string' || row.subject === null) &&
    typeof row.slug === 'string' &&
    typeof row.title === 'string' &&
    typeof row.body === 'string'
  )
}

async function loadDocCorpus(repositoryRoot: string, docMaxCharacters: number): Promise<Chunk[]> {
  const child = Bun.spawn([resolve(repositoryRoot, 'bin/orch'), 'doc', 'list', '--json'], {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `doc corpus export failed: ${stderr.trim() || `exit ${exitCode}`}. ` +
        'Run `bin/orch doc list --json` from the repository root.',
    )
  }
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `doc corpus export was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(rows) || !rows.every(isDocRow)) {
    throw new Error('doc corpus export did not contain valid document rows')
  }
  return rows
    .filter((doc) => doc.scope !== 'resume')
    .flatMap((doc) => chunkDoc(doc, docMaxCharacters))
}

export async function loadCorpus(
  repositoryRoot: string,
  docMaxCharacters: number,
): Promise<Chunk[]> {
  const root = resolve(repositoryRoot)
  const files = new Set<string>()
  for (const pattern of SOURCE_GLOBS) {
    for await (const file of new Glob(pattern).scan({ cwd: root, onlyFiles: true })) files.add(file)
  }
  const chunks: Chunk[] = []
  for (const path of [...files].sort()) {
    const absolute = resolve(root, path)
    if (relative(root, absolute).startsWith('..'))
      throw new Error(`corpus path escaped root: ${path}`)
    chunks.push(...chunkText(path, await readFile(absolute, 'utf8')))
  }
  chunks.push(...(await loadDocCorpus(repositoryRoot, docMaxCharacters)))
  return chunks
}

export function chunkDocument(chunk: Chunk): string {
  return `${chunk.path}:${chunk.startLine}\n${chunk.text}`
}
