// concern: doc-snippet
/** Turns a marked markdown fragment into plain text and highlight ranges. */

export const DOC_SNIPPET_START = '\uE000'
export const DOC_SNIPPET_STOP = '\uE001'

export type DocSnippetHighlight = { start: number; length: number }

export type DocPlainSnippet = {
  snippet: string
  highlights: DocSnippetHighlight[]
}

const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})[^`]*$/
const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>\s?)+/
const HEADING_PREFIX = /^\s{0,3}#{1,6}(?:\s+|$)/
const LIST_PREFIX = /^\s*(?:[-*]|[0-9]+\.)\s+/

export function docPlainSnippet(marked: string): DocPlainSnippet {
  return extractHighlights(collapseWhitespace(reduceMarkdown(marked)))
}

function reduceMarkdown(marked: string): string {
  const lines: string[] = []
  for (const raw of marked.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (FENCE_LINE.test(line) || isTableSeparator(line)) continue
    lines.push(formatTableRow(stripInline(stripLinePrefix(line))))
  }
  return lines.join('\n')
}

function stripLinePrefix(line: string): string {
  return line.replace(BLOCKQUOTE_PREFIX, '').replace(HEADING_PREFIX, '').replace(LIST_PREFIX, '')
}

function isTableSeparator(line: string): boolean {
  const cells = line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()) && cell.includes('-'))
}

function formatTableRow(line: string): string {
  if (!line.includes('|')) return line
  const cells = line.split('|')
  const trimmed = line.trim()
  if (trimmed.startsWith('|')) cells.shift()
  if (trimmed.endsWith('|')) cells.pop()
  return cells
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .join(' · ')
}

function stripInline(text: string): string {
  let current = text
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current
      .replace(/(`+)([^`]+)\1/g, '$2')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1')
  }
  return current
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function extractHighlights(marked: string): DocPlainSnippet {
  let snippet = ''
  const highlights: DocSnippetHighlight[] = []
  let index = 0
  while (index < marked.length) {
    const char = marked[index]
    if (char === DOC_SNIPPET_START) {
      index += 1
      const start = snippet.length
      while (
        index < marked.length &&
        marked[index] !== DOC_SNIPPET_STOP &&
        marked[index] !== DOC_SNIPPET_START
      ) {
        snippet += marked[index]
        index += 1
      }
      if (marked[index] === DOC_SNIPPET_STOP) index += 1
      const length = snippet.length - start
      if (length > 0) highlights.push({ start, length })
      continue
    }
    if (char === DOC_SNIPPET_STOP) {
      index += 1
      continue
    }
    snippet += char
    index += 1
  }
  return { snippet, highlights }
}
