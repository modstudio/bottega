// concern: prose
/** Pure masking rules shared by record prose checks. */

export type MaskedRange = { start: number; end: number }
export type ScannedLine = { text: string; line: number }

export const TASK_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function mergedRanges(ranges: MaskedRange[]): MaskedRange[] {
  const ordered = ranges
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: MaskedRange[] = []
  for (const range of ordered) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

function lineRanges(text: string): Array<MaskedRange & { content: string }> {
  const lines: Array<MaskedRange & { content: string }> = []
  for (const match of text.matchAll(/.*(?:\r?\n|$)/g)) {
    if (match[0] === '') continue
    const start = match.index
    const content = match[0].replace(/\r?\n$/, '')
    lines.push({ start, end: start + match[0].length, content })
  }
  return lines
}

function markdownBlockRanges(text: string): MaskedRange[] {
  const lines = lineRanges(text)
  const ranges: MaskedRange[] = []
  const frontmatterEnd =
    lines[0]?.content === '---'
      ? lines.findIndex(({ content }, index) => index > 0 && content === '---')
      : -1
  if (frontmatterEnd >= 0) ranges.push({ start: 0, end: lines[frontmatterEnd]!.end })

  let fence: '`' | '~' | null = null
  let fenceStart = 0
  for (const [index, line] of lines.entries()) {
    if (frontmatterEnd >= 0 && index <= frontmatterEnd) continue
    const marker = line.content.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] as '`' | '~' | undefined
    if (!marker) continue
    if (fence === marker) {
      ranges.push({ start: fenceStart, end: line.end })
      fence = null
    } else if (fence === null) {
      fence = marker
      fenceStart = line.start
    }
  }
  if (fence) ranges.push({ start: fenceStart, end: text.length })
  return ranges
}

function matches(text: string, pattern: RegExp): MaskedRange[] {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function tokenPathRanges(text: string): MaskedRange[] {
  const ranges: MaskedRange[] = []
  for (const match of text.matchAll(/\S+/g)) {
    const leading = match[0].match(/^[([{<"']*/)?.[0].length ?? 0
    const trailing = match[0].match(/[.),;:!?\]}>"']*$/)?.[0].length ?? 0
    const token = match[0].slice(leading, match[0].length - trailing)
    if (
      token.includes('/') ||
      token.startsWith('~') ||
      token.startsWith('./') ||
      token.startsWith('../') ||
      /^\//.test(token) ||
      /\.[A-Za-z]{1,5}$/.test(token)
    ) {
      ranges.push({ start: match.index + leading, end: match.index + match[0].length - trailing })
    }
  }
  return ranges
}

export function maskedRanges(text: string): MaskedRange[] {
  const ranges = markdownBlockRanges(text)
  const blockRanges = mergedRanges(ranges)
  const visible = [...text]
    .map((character, index) =>
      blockRanges.some((range) => index >= range.start && index < range.end) ? ' ' : character,
    )
    .join('')

  ranges.push(...matches(visible, /(`+)[^`\n]*?\1/g))
  ranges.push(...matches(visible, /\]\((?:[^()\s]|\([^)]*\))*\)/g))
  ranges.push(...matches(visible, /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s)\]}>]+/g))
  const protectedRanges = mergedRanges(ranges)
  const tokenVisible = [...visible]
    .map((character, index) =>
      protectedRanges.some((range) => index >= range.start && index < range.end) ? ' ' : character,
    )
    .join('')
  ranges.push(...tokenPathRanges(tokenVisible))
  ranges.push(...matches(visible, new RegExp(TASK_KEY_PATTERN.source, 'g')))
  ranges.push(...matches(visible, /\b[A-Za-z][A-Za-z0-9_-]*#\d+\b/g))
  ranges.push(
    ...matches(visible, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi),
  )
  ranges.push(...matches(visible, /\b(?=[0-9a-f]{7,}\b)(?=[0-9a-f]*\d)[0-9a-f]+\b/gi))
  ranges.push(...matches(visible, /(?<![\w-])--?[A-Za-z][\w-]*/g))
  ranges.push(...matches(visible, ANSI_ESCAPE_PATTERN))
  ranges.push(...matches(visible, /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b/g))
  ranges.push(...matches(visible, /\b(?=[A-Za-z]*[a-z][A-Z])[A-Za-z]+\b/g))
  ranges.push(...matches(visible, /(?<!\w)[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+(?!\w)/g))
  ranges.push(...matches(visible, /\b[A-Z]{2,}s?\b/g))
  ranges.push(...matches(visible, /(?<!['’])\b[B-HJ-Zb-z]\b/g))
  return mergedRanges(ranges)
}

export function proseLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  const source = text.split(/\r?\n/)
  const frontmatterEnd =
    source[0] === '---' ? source.findIndex((line, index) => index > 0 && line === '---') : -1
  let fence: '`' | '~' | null = null
  for (const [index, line] of source.entries()) {
    if (frontmatterEnd >= 0 && index <= frontmatterEnd) continue
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] as '`' | '~' | undefined
    if (marker) {
      if (fence === marker) fence = null
      else if (fence === null) fence = marker
      continue
    }
    if (fence === null) lines.push({ text: line, line: index + 1 })
  }
  return lines
}

export function proseOnly(line: string): string {
  return line
    .replace(/(`+)[^`\n]*?\1/g, (value) => ' '.repeat(value.length))
    .replace(/\[[^\]]*\]\([^)]*\)/g, (value) => ' '.repeat(value.length))
}
