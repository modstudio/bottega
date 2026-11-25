/** Splits one already-masked TypeScript call without treating nested commas as separators. */
export function typescriptCallArguments(source: string, open: number, close: number): string[] {
  const args: string[] = []
  let start = open + 1
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let index = start; index < close; index += 1) {
    const char = source[index]
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) {
      args.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  const last = source.slice(start, close).trim()
  if (last || args.length > 0) args.push(last)
  return args
}
