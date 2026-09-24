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
  docTitle?: string
  headingPath?: string[]
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

const CODE_SOURCE_GLOBS = [
  'orchestrator/src/**/*.ts',
  'hub/src/**/*.ts',
  'retrieval/src/**/*.ts',
  'shared/**/*.ts',
  'scripts/**/*.ts',
  '.agents/**/*.md',
] as const

/** The benchmark's own labeled questions quote every answer verbatim, so indexing them would let the benchmark find itself. */
const CODE_EXCLUDED_PREFIXES = ['retrieval/src/benchmark/'] as const

function isCodeCorpusPath(path: string): boolean {
  return (
    CODE_SOURCE_GLOBS.some((pattern) => new Glob(pattern).match(path)) &&
    !CODE_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))
  )
}

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

const DOC_CHUNK_TARGET_CHARACTERS = 2_000

type DocSection = {
  headings: string[]
  body: string
  startLine: number
}

function docSections(body: string): DocSection[] {
  const lines = body.split('\n')
  const sections: DocSection[] = []
  const headings: Array<{ level: number; text: string }> = []
  let sectionLines: string[] = []
  let startLine = 1

  const flush = () => {
    const sectionBody = sectionLines.join('\n').trim()
    if (sectionBody) {
      sections.push({ headings: headings.map(({ text }) => text), body: sectionBody, startLine })
    }
    sectionLines = []
  }

  for (const [index, line] of lines.entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!heading) {
      if (sectionLines.length === 0) startLine = index + 1
      sectionLines.push(line)
      continue
    }
    flush()
    const level = heading[1]?.length ?? 1
    while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop()
    headings.push({ level, text: `${'#'.repeat(level)} ${heading[2]}` })
    startLine = index + 2
  }
  flush()
  return sections
}

function splitLongParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph]
  const lines = paragraph.split('\n')
  const pieces: string[] = []
  let current = ''
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line
    if (current && candidate.length > limit) {
      pieces.push(current)
      current = line
    } else {
      current = candidate
    }
  }
  if (current) pieces.push(current)
  return pieces
}

function splitSection(
  section: DocSection,
  prefix: string,
): Array<{ text: string; startLine: number }> {
  const bodyLimit = Math.max(1, DOC_CHUNK_TARGET_CHARACTERS - prefix.length - 2)
  const paragraphs = section.body
    .split(/\n\s*\n/)
    .flatMap((paragraph) => splitLongParagraph(paragraph.trim(), bodyLimit))
    .filter(Boolean)
  const chunks: Array<{ text: string; startLine: number }> = []
  let current: string[] = []
  let offset = 0
  let chunkStart = section.startLine

  const flush = () => {
    if (!current.length) return
    chunks.push({ text: `${prefix}\n\n${current.join('\n\n')}`, startLine: chunkStart })
    offset += current.join('\n\n').split('\n').length
    current = []
  }

  for (const paragraph of paragraphs) {
    const candidate = [...current, paragraph].join('\n\n')
    if (current.length && candidate.length > bodyLimit) {
      flush()
      chunkStart = section.startLine + offset
    }
    current.push(paragraph)
  }
  flush()
  return chunks
}

export function chunkDoc(doc: DocRow): Chunk[] {
  const identity: DocIdentity = {
    kind: 'doc',
    scope: doc.scope,
    subject: doc.subject,
    slug: doc.slug,
  }
  const path = docIdentity(identity)
  const sections = docSections(doc.body)
  if (!sections.length) sections.push({ headings: [], body: '', startLine: 1 })
  return sections.flatMap((section, sectionIndex) => {
    const prefix = [`# ${doc.title}`, ...section.headings].join('\n\n')
    const pieces = section.body
      ? splitSection(section, prefix)
      : [{ text: prefix, startLine: section.startLine }]
    return pieces.map(({ text, startLine }, pieceIndex) => ({
      id: `${path}:section-${sectionIndex + 1}-${pieceIndex + 1}`,
      path,
      identity,
      startLine,
      endLine: startLine + text.split('\n').length - 1,
      text,
      docTitle: doc.title,
      headingPath: section.headings.map((heading) => heading.replace(/^#{1,6}\s+/, '')),
    }))
  })
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

export async function loadDocCorpus(repositoryRoot: string): Promise<Chunk[]> {
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
  return rows.filter((doc) => doc.scope !== 'resume').flatMap((doc) => chunkDoc(doc))
}

export async function loadCodeCorpus(repositoryRoot: string): Promise<Chunk[]> {
  const root = resolve(repositoryRoot)
  const child = Bun.spawn(['git', '-C', root, 'ls-files', '-z'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`tracked code corpus listing failed: ${stderr.trim() || `exit ${exitCode}`}`)
  }
  const files = stdout.split('\0').filter(Boolean).filter(isCodeCorpusPath).sort()
  const chunks: Chunk[] = []
  for (const path of files) {
    const absolute = resolve(root, path)
    if (relative(root, absolute).startsWith('..'))
      throw new Error(`corpus path escaped root: ${path}`)
    chunks.push(...chunkText(path, await readFile(absolute, 'utf8')))
  }
  return chunks
}

export async function loadCorpus(repositoryRoot: string): Promise<Chunk[]> {
  const chunks = await loadCodeCorpus(repositoryRoot)
  chunks.push(...(await loadDocCorpus(repositoryRoot)))
  return chunks
}

export function chunkDocument(chunk: Chunk): string {
  return `${chunk.path}:${chunk.startLine}\n${chunk.text}`
}

export type TokenCount = { count: number; maxModelLength: number }

export async function splitChunksToModelLimit(
  chunks: Chunk[],
  countTokens: (document: string) => Promise<TokenCount>,
): Promise<Chunk[]> {
  const bounded: Chunk[] = []
  const visit = async (chunk: Chunk): Promise<void> => {
    const { count, maxModelLength } = await countTokens(chunkDocument(chunk))
    if (count <= maxModelLength) {
      bounded.push(chunk)
      return
    }
    const lines = chunk.text.split('\n')
    if (lines.length < 2) {
      throw new Error(`${chunk.id} exceeds the model context and has no line boundary to split`)
    }
    const middle = Math.ceil(lines.length / 2)
    const halves = [lines.slice(0, middle), lines.slice(middle)]
    let nextStart = chunk.startLine
    for (const [index, half] of halves.entries()) {
      const text = half.join('\n').trim()
      if (!text) continue
      const startLine = nextStart
      nextStart += half.length
      await visit({
        ...chunk,
        id: `${chunk.id}:token-${index + 1}`,
        startLine,
        endLine: startLine + half.length - 1,
        text,
      })
    }
  }
  for (const chunk of chunks) await visit(chunk)
  return bounded
}
