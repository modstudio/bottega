/**
 * Body the reading pane feeds to Markdown: a leading level-one ATX heading is
 * dropped so the title above the body is the only one.
 */
export function readingBody(body: string): string {
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index]!.trim() === '') index += 1
  const first = lines[index]
  if (first === undefined || !/^#(?!#)[ \t]+/.test(first)) return body
  return lines.slice(index + 1).join('\n')
}
