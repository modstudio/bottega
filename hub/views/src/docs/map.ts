import type { DocSnippetHighlight } from '../../../../shared/doc-snippet.ts'

/** Split a plain search snippet into highlighted and unhighlighted presentation spans. */
export function highlightSnippet(input: {
  snippet: string
  highlights: readonly DocSnippetHighlight[]
}): { text: string; highlight: boolean; start: number }[] {
  const { snippet, highlights } = input
  if (highlights.length === 0) return snippet ? [{ text: snippet, highlight: false, start: 0 }] : []
  const parts: { text: string; highlight: boolean; start: number }[] = []
  let cursor = 0
  for (const { start, length } of highlights) {
    if (start > cursor)
      parts.push({ text: snippet.slice(cursor, start), highlight: false, start: cursor })
    if (length > 0)
      parts.push({ text: snippet.slice(start, start + length), highlight: true, start })
    cursor = Math.max(cursor, start + length)
  }
  if (cursor < snippet.length)
    parts.push({ text: snippet.slice(cursor), highlight: false, start: cursor })
  return parts.filter((part) => part.text.length > 0)
}
