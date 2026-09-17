// concern: retrieval-corpus
/** Builds bounded, overlapping retrieval units from the repository source corpus. */
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { Glob } from 'bun'

export type Chunk = {
  id: string
  path: string
  startLine: number
  endLine: number
  text: string
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
        startLine,
        endLine: end,
        text: body,
      })
    }
    if (end === lines.length) break
  }
  return chunks
}

export async function loadCorpus(repositoryRoot: string): Promise<Chunk[]> {
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
  return chunks
}

export function chunkDocument(chunk: Chunk): string {
  return `${chunk.path}:${chunk.startLine}\n${chunk.text}`
}
