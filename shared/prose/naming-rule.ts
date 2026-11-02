// concern: prose
/** Pure naming rule for refusing role-sense naming in record prose. */

import { maskedRanges } from './prose-mask.ts'

export type NamingFinding = {
  rule: 'Naming'
  start: number
  end: number
  text: string
  message: string
  suggestions: string[]
}

const PROGRAMMING_QUALIFIERS = [
  'sql',
  'comparison',
  'logical',
  'bitwise',
  'arithmetic',
  'ternary',
  'spread',
  'rest',
  'assignment',
  'equality',
  'boolean',
  'mathematical',
  'unary',
  'binary',
  'infix',
  'prefix',
  'postfix',
  'pipe',
  'nullish',
  'optional',
  'chaining',
  'relational',
  'set',
  'range',
] as const

function overlaps(start: number, end: number, ranges: Array<{ start: number; end: number }>) {
  return ranges.some((range) => start < range.end && end > range.start)
}

function programmingSense(text: string, start: number): boolean {
  const before = text.slice(0, start).replace(/ +$/, '')
  const qualifier = before.match(/([A-Za-z]+)$/)?.[1]?.toLowerCase()
  if (qualifier && PROGRAMMING_QUALIFIERS.some((word) => word === qualifier)) return true
  if (/(`+)[^`\n]*\1$/.test(before)) return true
  const symbols = before.match(/[+*/%<>!&|^~?.=-]+$/)?.[0]
  if (!symbols) return false
  const symbolStart = before.length - symbols.length
  const characterBeforeSymbols = before[symbolStart - 1]
  if (characterBeforeSymbols !== undefined && !/\s/.test(characterBeforeSymbols)) return false
  if (symbols.length >= 2) return true
  const lineBeforeSymbol = before.slice(0, symbolStart).split('\n').at(-1) ?? ''
  return lineBeforeSymbol.trimStart().length > 0
}

function replacement(text: string, displayName: string | null, determiner: string | null): string {
  const generic = determiner !== null && /^[A-Z]/.test(determiner) ? 'The user' : 'the user'
  const person = displayName ?? generic
  return /['’]s$/i.test(text) ? `${person}'s` : person
}

export function namingFindings(
  text: string,
  displayName: string | null,
  masks: Array<{ start: number; end: number }> = maskedRanges(text),
): NamingFinding[] {
  const message = displayName
    ? `Name the person: ${displayName}; where a role word is needed, use "the user".`
    : 'Name the person who decided; where a role word is needed, use "the user".'
  const findings: NamingFinding[] = []
  for (const match of text.matchAll(/\boperators?\b(?:['’]s\b)?/gi)) {
    const wordStart = match.index
    const end = wordStart + match[0].length
    if (overlaps(wordStart, end, masks) || programmingSense(text, wordStart)) continue
    const determinerMatch = text.slice(0, wordStart).match(/\b(the|a|an)\s+$/i)
    const determiner = determinerMatch?.[1] ?? null
    const start = determinerMatch ? wordStart - determinerMatch[0].length : wordStart
    const matchedText = text.slice(start, end)
    findings.push({
      rule: 'Naming',
      start,
      end,
      text: matchedText,
      message,
      suggestions: [replacement(match[0], displayName, determiner)],
    })
  }
  return findings
}
