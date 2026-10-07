/**
 * Body the reading pane feeds to Markdown: a leading level-one ATX heading is
 * dropped so the title above the body is the only one.
 */
/** The text of a body's leading level-one ATX heading, when it has one. */
export function leadingHeading(body: string): string | null {
  const first = body.split('\n').find((line) => line.trim() !== '')
  const match = first === undefined ? null : /^#(?!#)[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(first)
  return match?.[1] ? match[1] : null
}

/**
 * What the reading pane shows above a body. The stored title is often a full sentence, so a
 * body's own leading heading is the title and the stored title becomes the line beneath it.
 */
export function paneTitle(title: string, body: string): { title: string; lede: string | null } {
  const heading = leadingHeading(body)
  if (!heading || heading === title) return { title, lede: null }
  return { title: heading, lede: title }
}

export function readingBody(body: string): string {
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index]!.trim() === '') index += 1
  const first = lines[index]
  if (first === undefined || !/^#(?!#)[ \t]+/.test(first)) return body
  return lines.slice(index + 1).join('\n')
}
