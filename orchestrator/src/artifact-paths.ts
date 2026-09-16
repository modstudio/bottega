// concern: artifact-paths
/**
 * Knows persisted run artifact paths and their reader-facing presentation.
 * Must not know contracts, databases, run lifecycle, or worktree ownership.
 */
import { basename, join, relative } from 'node:path'

export function runScratchDir(id: number, runsDir: string): string {
  return join(runsDir, String(id), 'scratch')
}

export function runArtifactsDir(id: number, runsDir: string): string {
  return join(runsDir, String(id), 'artifacts')
}

export function persistedRunArtifactPath(
  id: number,
  runsDir: string,
  entry: string,
  worktreePath: string | null,
): string {
  const scratch = runScratchDir(id, runsDir)
  const artifacts = runArtifactsDir(id, runsDir)
  const source = entry.startsWith('/') ? entry : worktreePath ? join(worktreePath, entry) : entry
  return source === scratch || source.startsWith(`${scratch}/`)
    ? join(artifacts, relative(scratch, source))
    : join(artifacts, basename(entry))
}

function jsonStringEnd(text: string, start: number): number {
  let escaped = false
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    const character = text[cursor]!
    if (escaped) escaped = false
    else if (character === '\\') escaped = true
    else if (character === '"') return cursor + 1
  }
  return -1
}

function stringArrayEnd(text: string, start: number): number {
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '"') {
      cursor = jsonStringEnd(text, cursor) - 1
      if (cursor < 0) return -1
    } else if (text[cursor] === ']') return cursor + 1
  }
  return -1
}

function sameStrings(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}

function topLevelStringSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let depth = 0
  for (let cursor = 0; cursor < text.length; cursor++) {
    const character = text[cursor]!
    if (character === '{' || character === '[') depth++
    else if (character === '}' || character === ']') depth--
    else if (character === '"') {
      const end = jsonStringEnd(text, cursor)
      if (end < 0) return []
      if (depth === 1) spans.push({ start: cursor, end })
      cursor = end - 1
    }
  }
  return spans
}

function stringArraySpanAfterKey(
  text: string,
  keyEnd: number,
): { start: number; end: number } | null {
  let start = keyEnd
  while (/\s/.test(text[start] ?? '')) start++
  if (text[start] !== ':') return null
  start++
  while (/\s/.test(text[start] ?? '')) start++
  if (text[start] !== '[') return null
  const end = stringArrayEnd(text, start)
  return end < 0 ? null : { start, end }
}

function filesWrittenArraySpan(
  text: string,
  filesWritten: string[],
): { start: number; end: number } | null {
  let found: { start: number; end: number } | null = null
  for (const key of topLevelStringSpans(text)) {
    if (JSON.parse(text.slice(key.start, key.end)) !== 'files_written') continue
    const array = stringArraySpanAfterKey(text, key.end)
    if (!array) continue
    try {
      if (sameStrings(JSON.parse(text.slice(array.start, array.end)), filesWritten)) found = array
    } catch {
      return null
    }
  }
  return found
}

/** Rewrite only files_written string tokens; null means the text is not the expected JSON shape. */
export function rewriteFilesWrittenPaths(
  text: string,
  mapPath: (path: string) => string,
): string | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const filesWritten = (value as { files_written?: unknown }).files_written
  if (!Array.isArray(filesWritten) || !filesWritten.every((entry) => typeof entry === 'string')) {
    return null
  }
  const span = filesWrittenArraySpan(text, filesWritten)
  if (!span) return null
  const array = text.slice(span.start, span.end)
  const strings: { start: number; end: number; value: string }[] = []
  for (let cursor = 1; cursor < array.length - 1; cursor++) {
    if (array[cursor] !== '"') continue
    const end = jsonStringEnd(array, cursor)
    if (end < 0) return null
    strings.push({ start: cursor, end, value: JSON.parse(array.slice(cursor, end)) })
    cursor = end - 1
  }
  if (strings.length !== filesWritten.length) return null
  let rewritten = array
  for (let index = strings.length - 1; index >= 0; index--) {
    const string = strings[index]!
    rewritten =
      rewritten.slice(0, string.start) +
      JSON.stringify(mapPath(string.value)) +
      rewritten.slice(string.end)
  }
  return text.slice(0, span.start) + rewritten + text.slice(span.end)
}
