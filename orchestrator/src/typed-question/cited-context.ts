// concern: cited-context
/** Extracts bounded repository file context cited by a specification. */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const CITED_FILE_BYTES = 16 * 1024
export const CITED_TOTAL_BYTES = 64 * 1024

export type CitedFile = { path: string; text: string }
export type CitedFileReader = (path: string) => string | null

const TOKEN = /`([^`\n]+)`|(?:^|\s)([^\s`]+\/[^\s`]+)/gm

function citedPath(token: string): string | null {
  const cleaned = token.replace(/[),.;]+$/, '')
  const path = cleaned.replace(/:(?:\d+(?:-\d+)?|[A-Za-z_$][\w$]*)$/, '')
  if (!path.includes('/') || path.startsWith('/') || path.split('/').includes('..')) return null
  return path
}

/** Read resolvable cited files in first-cited order, bounded per file and in aggregate. */
export function citedContext(spec: string, readFile: CitedFileReader): CitedFile[] {
  const files: CitedFile[] = []
  const seen = new Set<string>()
  let remaining = CITED_TOTAL_BYTES
  for (const match of spec.matchAll(TOKEN)) {
    const path = citedPath(match[1] ?? match[2] ?? '')
    if (!path || seen.has(path) || remaining <= 0) continue
    seen.add(path)
    const source = readFile(path)
    if (source === null) continue
    const bytes = Buffer.from(source).subarray(0, Math.min(CITED_FILE_BYTES, remaining))
    files.push({ path, text: bytes.toString('utf8') })
    remaining -= bytes.byteLength
  }
  return files
}

/** Reads a regular file inside one checkout; anything outside it, or unreadable, is null. */
export function checkoutFileReader(checkout: string): CitedFileReader {
  return (path) => {
    try {
      const root = realpathSync(checkout)
      const candidate = realpathSync(resolve(root, path))
      const fromRoot = relative(root, candidate)
      if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || !statSync(candidate).isFile())
        return null
      return readFileSync(candidate, 'utf8')
    } catch {
      return null
    }
  }
}
