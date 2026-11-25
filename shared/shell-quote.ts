// concern: shell-quote
/** Quotes one value for display in a pasteable POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

type ParsedShellQuotedToken = { value: string; next: number }

function parseShellQuotedToken(text: string, start: number): ParsedShellQuotedToken | null {
  if (text[start] !== "'") return null
  let value = ''
  let offset = start + 1
  while (offset < text.length) {
    if (text.startsWith("'\\''", offset)) {
      value += "'"
      offset += 4
      continue
    }
    if (text[offset] === "'") return { value, next: offset + 1 }
    value += text[offset]
    offset += 1
  }
  return null
}

/** Parses the canonical command form produced by shellQuote for each argv value. */
export function parseShellQuoted(text: string): string[] | null {
  if (!text) return null
  const values: string[] = []
  let offset = 0
  while (offset < text.length) {
    const token = parseShellQuotedToken(text, offset)
    if (!token) return null
    values.push(token.value)
    if (token.next === text.length) return values
    if (text[token.next] !== ' ' || text[token.next + 1] !== "'") return null
    offset = token.next + 1
  }
  return null
}
