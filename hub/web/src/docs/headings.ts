export type DocHeading = { id: string; title: string }

export function headingId(title: string): string {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

function fenceOpen(line: string): { char: string; length: number } | null {
  const match = /^( {0,3})([`~]{3,})/.exec(line)
  if (!match) return null
  return { char: match[2]![0]!, length: match[2]!.length }
}

function fenceCloses(line: string, fence: { char: string; length: number }): boolean {
  const match = /^( {0,3})([`~]{3,})\s*$/.exec(line)
  return Boolean(match && match[2]![0] === fence.char && match[2]!.length >= fence.length)
}

/**
 * Second-level ATX headings in a markdown body, in document order. Fenced and
 * indented code is ignored; duplicate titles share the same id scheme the
 * renderer uses.
 */
export function secondLevelHeadings(body: string): DocHeading[] {
  const headings: DocHeading[] = []
  const seen = new Map<string, number>()
  let fence: { char: string; length: number } | null = null
  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      if (fenceCloses(line, fence)) fence = null
      continue
    }
    const open = fenceOpen(line)
    if (open) {
      fence = open
      continue
    }
    if (/^(?: {4}|\t)/.test(line)) continue
    const match = /^ {0,3}##[ \t]+(.+?)\s*$/.exec(line)
    if (!match) continue
    const title = match[1]!.replace(/\s+#+\s*$/, '').trim()
    if (!title) continue
    const base = headingId(title)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    headings.push({ id: count === 0 ? base : `${base}-${count + 1}`, title })
  }
  return headings
}
