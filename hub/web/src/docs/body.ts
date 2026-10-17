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

export function viewedPaneTitle(
  current: { title: string; body: string },
  revision: { title: string; body: string } | null,
): { title: string; lede: string | null } {
  const shown = revision ?? current
  return paneTitle(shown.title, shown.body)
}

/**
 * A body split at its leading level-one ATX heading: `prefix` is the exact source up to the end
 * of that heading line (blank lines before it included), `rest` everything after it. Without such
 * a heading `prefix` is empty and `rest` is the whole body.
 */
function splitLeadingHeading(body: string): { prefix: string; rest: string } {
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index]!.trim() === '') index += 1
  const first = lines[index]
  if (first === undefined || !/^#(?!#)[ \t]+/.test(first)) return { prefix: '', rest: body }
  const prefix = lines.slice(0, index + 1).join('\n')
  return { prefix, rest: body.slice(prefix.length) }
}

export const docsBodyTransform = {
  split(body: string) {
    const { prefix, rest } = splitLeadingHeading(body)
    return { editable: rest, retained: prefix }
  },
  join(editable: string, retained: string) {
    return `${retained}${editable}`
  },
}

export function readingBody(body: string): string {
  const { prefix, rest } = splitLeadingHeading(body)
  return prefix ? rest.slice(1) : body
}
