export type DocHeading = { id: string; title: string }

export function headingId(title: string): string {
  const slug = title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/** Second-level ATX headings in a markdown body, in document order. */
export function secondLevelHeadings(body: string): DocHeading[] {
  const headings: DocHeading[] = []
  const seen = new Map<string, number>()
  for (const line of body.split(/\r?\n/)) {
    const match = /^##[ \t]+(.+?)\s*$/.exec(line)
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
