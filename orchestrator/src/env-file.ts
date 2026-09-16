// concern: tracked recipe environment file decisions
/** Knows only how environment text is filtered and managed. Must not read files, execute steps, or know the lifecycle. */

export type EnvTextPlan = { ok: true; text: string } | { ok: false; reason: string }

type Line = { number: number; start: number; end: number; text: string }

function linesIn(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  let number = 1
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline + 1
    const withoutNewline = text.slice(start, newline === -1 ? end : newline)
    lines.push({
      number,
      start,
      end,
      text: withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline,
    })
    start = end
    number += 1
  }
  return lines
}

function blockText(opening: string, closing: string, body: string): string {
  if (!body) return `${opening}\n${closing}`
  return `${opening}\n${body}${body.endsWith('\n') ? '' : '\n'}${closing}`
}

function appendSeparator(base: string): string {
  if (!base) return ''
  if (base.endsWith('\n\n')) return ''
  return base.endsWith('\n') ? '\n' : '\n\n'
}

function closingLineEnding(base: string, close: Line): string {
  const source = base.slice(close.start, close.end)
  if (source.endsWith('\r\n')) return '\r\n'
  return source.endsWith('\n') ? '\n' : ''
}

export function managedBlockPlan(base: string, treeName: string, body: string): EnvTextPlan {
  const opening = `# >>> orch-worktree ${treeName}`
  const closing = `# <<< orch-worktree ${treeName}`
  const lines = linesIn(base)
  const openingLines = lines.filter((line) => line.text === opening)
  const blocks = openingLines.flatMap((open) => {
    const close = lines.find((line) => line.number > open.number && line.text === closing)
    return close ? [{ open, close }] : []
  })
  const unclosed = openingLines.find(
    (open) => !lines.some((line) => line.number > open.number && line.text === closing),
  )
  if (unclosed) {
    return {
      ok: false,
      reason: `managed block opening on line ${unclosed.number} has no closing line`,
    }
  }
  if (blocks.length > 1) {
    return {
      ok: false,
      reason: `more than one managed block opens on lines ${blocks.map(({ open }) => open.number).join(', ')}`,
    }
  }
  const replacement = blockText(opening, closing, body)
  const block = blocks[0]
  if (!block) {
    return { ok: true, text: `${base}${appendSeparator(base)}${replacement}` }
  }
  const { open, close } = block
  return {
    ok: true,
    text: `${base.slice(0, open.start)}${replacement}${closingLineEnding(base, close)}${base.slice(close.end)}`,
  }
}

function assignmentKey(line: string): string | null {
  return line.match(/^\s*(?:export\s+)?([^\s=]+)\s*=/)?.[1] ?? null
}

export function omitKeys(base: string, keys: readonly string[]): string {
  const omitted = new Set(keys)
  return linesIn(base)
    .filter((line) => {
      const key = assignmentKey(line.text)
      return key === null || !omitted.has(key)
    })
    .map((line) => base.slice(line.start, line.end))
    .join('')
}
