const RAISE_MESSAGE_PLACEHOLDER = "'__SUPERSEDED_RAISE_MESSAGE__'"

function withoutLineComments(ddl: string): string {
  let normalized = ''
  let index = 0
  let inLiteral = false

  while (index < ddl.length) {
    const character = ddl[index]!
    if (character === "'") {
      normalized += character
      if (inLiteral && ddl[index + 1] === "'") {
        normalized += "'"
        index += 2
        continue
      }
      inLiteral = !inLiteral
      index += 1
      continue
    }
    if (!inLiteral && character === '-' && ddl[index + 1] === '-') {
      index += 2
      while (index < ddl.length && ddl[index] !== '\n' && ddl[index] !== '\r') index += 1
      normalized += ' '
      continue
    }
    normalized += character
    index += 1
  }

  return normalized
}

function raiseArgumentEnd(ddl: string, start: number): number | undefined {
  let depth = 0
  let inLiteral = false
  for (let index = start; index < ddl.length; index += 1) {
    const character = ddl[index]!
    if (character === "'") {
      if (inLiteral && ddl[index + 1] === "'") {
        index += 1
        continue
      }
      inLiteral = !inLiteral
      continue
    }
    if (inLiteral) continue
    if (character === '(') {
      depth += 1
      continue
    }
    if (character !== ')') continue
    if (depth === 0) return index
    depth -= 1
  }
  return undefined
}

function nextRaiseStart(
  ddl: string,
  start: number,
): { index: number; argumentStart: number } | undefined {
  let inLiteral = false
  for (let index = start; index < ddl.length; index += 1) {
    if (ddl[index] === "'") {
      if (inLiteral && ddl[index + 1] === "'") {
        index += 1
        continue
      }
      inLiteral = !inLiteral
      continue
    }
    if (inLiteral) continue
    const match = /^RAISE\s*\(\s*(?:ABORT|FAIL|ROLLBACK)\s*,/i.exec(ddl.slice(index))
    if (match && (index === 0 || !/[A-Za-z0-9_]/.test(ddl[index - 1]!))) {
      return { index, argumentStart: index + match[0].length }
    }
  }
  return undefined
}

/** Ignores comments, formatting, and only the compatibility-safe RAISE message edit. */
export function normalizeSupersededDdl(ddl: string): string {
  const uncommented = withoutLineComments(ddl)
  let normalized = ''
  let cursor = 0

  for (
    let raise = nextRaiseStart(uncommented, cursor);
    raise;
    raise = nextRaiseStart(uncommented, cursor)
  ) {
    const argumentEnd = raiseArgumentEnd(uncommented, raise.argumentStart)
    if (argumentEnd === undefined) break
    normalized += uncommented.slice(cursor, raise.argumentStart)
    normalized += RAISE_MESSAGE_PLACEHOLDER
    cursor = argumentEnd
  }

  normalized += uncommented.slice(cursor)
  return normalized.replace(/\s+/g, ' ').trim()
}
