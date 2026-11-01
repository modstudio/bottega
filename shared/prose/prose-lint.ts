// concern: prose
/** Pure prose rules shared by canon and stored documents. */

import { proseLines, proseOnly, TASK_KEY_PATTERN } from './prose-mask.ts'

export type ProseFinding = {
  rule: 'history' | 'issue' | 'numeral' | 'date'
  line: number
  message: string
  remedy: string
  historyCertainty?: 'certain' | 'ambiguous'
  issueKind?: 'task-key'
}

const TASK_KEY_EXEMPTIONS = [
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'ES',
  'TLS',
  'HTTP',
  'IPV',
  'PSR',
  'PEP',
  'ECMA',
  'CVE',
]

/** Phrase-level history patterns available to comment checks; single-word prose rules stay local. */
export const DEFAULT_COMMENT_HISTORY_PHRASES = [
  'used to be',
  'used to have',
  'formerly',
  'back when',
  'previously',
  'was omitted',
  'this replaces',
  'this replaced',
  'the first draft',
  'restores the earlier',
  'restores the old',
  'restores the previous',
] as const

const CERTAIN_HISTORY_PATTERNS = [/\bwas (?:called|named)\b/i, /\brenamed\b/i]

const AMBIGUOUS_HISTORY_PATTERNS = [
  /\bused to\b/i,
  /\bno longer\b/i,
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\b(?:that|this|it) (?:has )?changed\b/i,
]

function historyPattern(
  line: string,
): { pattern: RegExp; certainty: 'certain' | 'ambiguous' } | undefined {
  const certain = CERTAIN_HISTORY_PATTERNS.find((pattern) => pattern.test(line))
  if (certain) return { pattern: certain, certainty: 'certain' }
  const ambiguous = AMBIGUOUS_HISTORY_PATTERNS.find((pattern) => pattern.test(line))
  return ambiguous ? { pattern: ambiguous, certainty: 'ambiguous' } : undefined
}

const ISSUE_PATTERNS = [
  /\bworkaround\b/i,
  /\bknown issue\b/i,
  /\buntil (?:it is |this is )?fixed\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
]

const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/

function containsTaskKey(line: string): boolean {
  const exemptions = new Set(TASK_KEY_EXEMPTIONS)
  return [...line.matchAll(new RegExp(TASK_KEY_PATTERN.source, 'g'))].some((match) => {
    const prefix = match[0].slice(0, match[0].lastIndexOf('-'))
    return !exemptions.has(prefix)
  })
}

export { proseLines } from './prose-mask.ts'

export function lintProse(text: string): ProseFinding[] {
  const findings: ProseFinding[] = []
  for (const { text: line, line: lineNumber } of proseLines(text)) {
    const withoutInlineCode = line.replace(/(`+)[^`]*?\1/g, '')
    const matchedHistoryPattern = historyPattern(withoutInlineCode)
    if (matchedHistoryPattern) {
      findings.push({
        line: lineNumber,
        rule: 'history',
        message: `matches banned history pattern ${matchedHistoryPattern.pattern.source}`,
        remedy: 'state only the current rule, constraint, behavior, or reason',
        historyCertainty: matchedHistoryPattern.certainty,
      })
    }
    const issuePattern = ISSUE_PATTERNS.find((pattern) => pattern.test(withoutInlineCode))
    if (containsTaskKey(line)) {
      findings.push({
        line: lineNumber,
        rule: 'issue',
        issueKind: 'task-key',
        message: 'contains a task key',
        remedy: 'remove the task key; tasks may link to docs, but docs do not link to tasks',
      })
    }
    if (issuePattern) {
      findings.push({
        line: lineNumber,
        rule: 'issue',
        message: `matches banned issue pattern ${issuePattern.source}`,
        remedy: 'state the current rule or behavior without narrating an open or former issue',
      })
    }

    const prose = proseOnly(line)
    const date = prose.match(ISO_DATE_PATTERN)?.[0]
    if (date) {
      findings.push({
        line: lineNumber,
        rule: 'date',
        message: `prose contains ISO date ${date}`,
        remedy: 'remove the date and state only the current policy',
      })
    }
    const orderedMarker = prose.match(/^\s*(?:#+\s*)?(\d+)[.)]\s/)
    for (const match of prose.matchAll(/(?<![A-Za-z0-9_-])\d+(?![A-Za-z0-9_-])/g)) {
      if (orderedMarker && match.index === prose.indexOf(orderedMarker[1]!)) continue
      findings.push({
        line: lineNumber,
        rule: 'numeral',
        message: `prose contains numeral ${match[0]}; name its constant or reporting command`,
        remedy:
          'name the value by its constant or configuration key, or name its reporting command',
      })
      break
    }
  }
  return findings
}
