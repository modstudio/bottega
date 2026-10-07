export type FenceUse = 'diagram' | 'highlight' | 'plain'

/** Which treatment a fenced block's info language receives. */
export function fenceUse(language: string | undefined): FenceUse {
  const lang = language?.trim().toLowerCase() ?? ''
  if (lang === '') return 'plain'
  if (lang === 'mermaid') return 'diagram'
  return 'highlight'
}

/**
 * Whether this document should load mermaid or the highlighter. A page with
 * neither kind of fence must request neither import.
 */
export function markdownImportNeeds(content: string): { mermaid: boolean; highlight: boolean } {
  let mermaid = false
  let highlight = false
  for (const language of fencedLanguages(content)) {
    const use = fenceUse(language)
    if (use === 'diagram') mermaid = true
    if (use === 'highlight') highlight = true
    if (mermaid && highlight) break
  }
  return { mermaid, highlight }
}

function fencedLanguages(content: string): (string | undefined)[] {
  const languages: (string | undefined)[] = []
  let fence: { char: string; length: number } | null = null
  for (const line of content.split(/\r?\n/)) {
    if (fence) {
      if (closesFence(line, fence)) fence = null
      continue
    }
    const open = openingFence(line)
    if (!open) continue
    fence = { char: open.char, length: open.length }
    languages.push(languageOf(open.info))
  }
  return languages
}

function openingFence(line: string): { char: string; length: number; info: string } | null {
  const match = /^( {0,3})([`~]{3,})(.*)$/.exec(line)
  if (!match) return null
  const marker = match[2]!
  const info = match[3] ?? ''
  if (marker[0] === '`' && info.includes('`')) return null
  return { char: marker[0]!, length: marker.length, info: info.trim() }
}

function closesFence(line: string, fence: { char: string; length: number }): boolean {
  const match = /^( {0,3})([`~]{3,})\s*$/.exec(line)
  return Boolean(match && match[2]![0] === fence.char && match[2]!.length >= fence.length)
}

function languageOf(info: string): string | undefined {
  const token = info.split(/\s+/)[0]
  return token || undefined
}
