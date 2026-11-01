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
  return /(?:&&|\|\||\?\?|===?|=>|\.\.\.|[+*/%<>!&|^~-])$/.test(before)
}

function replacement(text: string, displayName: string | null): string {
  const person = displayName ?? 'the user'
  return /['’]s$/i.test(text) ? `${person}'s` : person
}

export function namingFindings(text: string, displayName: string | null): NamingFinding[] {
  const masks = maskedRanges(text)
  const message = displayName
    ? `Name the person: ${displayName}; where a role word is needed, use "the user".`
    : 'Name the person who decided; where a role word is needed, use "the user".'
  const findings: NamingFinding[] = []
  for (const match of text.matchAll(/\boperators?\b(?:['’]s\b)?/gi)) {
    const start = match.index
    const end = start + match[0].length
    if (overlaps(start, end, masks) || programmingSense(text, start)) continue
    findings.push({
      rule: 'Naming',
      start,
      end,
      text: match[0],
      message,
      suggestions: [replacement(match[0], displayName)],
    })
  }
  return findings
}
