// concern: cited-context
/** Extracts bounded repository file context cited by a specification. */

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
