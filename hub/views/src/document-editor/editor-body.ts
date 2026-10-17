/** A body split at its leading level-one ATX heading. */
export function splitLeadingHeading(body: string): { prefix: string; rest: string } {
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && lines[index]!.trim() === '') index += 1
  const first = lines[index]
  if (first === undefined || !/^#(?!#)[ \t]+/.test(first)) return { prefix: '', rest: body }
  const prefix = lines.slice(0, index + 1).join('\n')
  return { prefix, rest: body.slice(prefix.length) }
}

export function readingBody(body: string): string {
  const { prefix, rest } = splitLeadingHeading(body)
  return prefix ? rest.slice(1) : body
}
