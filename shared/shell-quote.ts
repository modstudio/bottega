// concern: shell-quote
/** Quotes one value for display in a pasteable POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Parses the canonical command form produced by shellQuote for each argv value. */
export function parseShellQuoted(text: string): string[] | null {
  if (!text) return null
  const values: string[] = []
  let offset = 0
  while (offset < text.length) {
    if (text[offset] !== "'") return null
    offset += 1
    let value = ''
    while (offset < text.length) {
      if (text.startsWith("'\\''", offset)) {
        value += "'"
        offset += 4
        continue
      }
      if (text[offset] !== "'") {
        value += text[offset]
        offset += 1
        continue
      }
      offset += 1
      values.push(value)
      if (offset === text.length) return values
      if (text[offset] !== ' ' || text[offset + 1] !== "'") return null
      offset += 1
      break
    }
    if (offset === text.length && text.at(-1) !== "'") return null
  }
  return null
}
