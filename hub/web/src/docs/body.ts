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
export function paneTitle(title: string, _body: string): { title: string; lede: string | null } {
  return { title, lede: null }
}

/** Remove only a leading level-one heading that repeats the displayed document title. */
export function readingBody(title: string, body: string): string {
  if (leadingHeading(body) !== title) return body
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index]!.trim() === '') index += 1
  return lines.slice(index + 1).join('\n')
}
