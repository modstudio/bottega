// concern: canon-lint
/** Pure prose rules shared by canon and stored documents. */

export type ProseFinding = {
  rule: 'history' | 'issue' | 'numeral' | 'date'
  line: number
  message: string
  remedy: string
  historyCertainty?: 'certain' | 'ambiguous'
}

const TASK_KEY_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/
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

const CERTAIN_HISTORY_PATTERNS = [
  /\bwas (?:called|named)\b/i,
  /\brenamed\b/i,
]

const AMBIGUOUS_HISTORY_PATTERNS = [
  /\bno longer\b/i,
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\b(?:that|this|it) (?:has )?changed\b/i,
]

const FORMER_STATE_USED_TO = /\bused to\s+(?:be|have|[a-z]+)\b/i
const BE_FORM_BEFORE_USED_TO = /\b(?:is|are|was|were|be|been|being)\s+$/i

function historyPattern(
  line: string,
): { pattern: RegExp; certainty: 'certain' | 'ambiguous' } | null {
  const usedTo = FORMER_STATE_USED_TO.exec(line)
  if (usedTo && !BE_FORM_BEFORE_USED_TO.test(line.slice(0, usedTo.index))) {
    return { pattern: FORMER_STATE_USED_TO, certainty: 'certain' }
  }
  const certain = CERTAIN_HISTORY_PATTERNS.find((pattern) => pattern.test(line))
  if (certain) return { pattern: certain, certainty: 'certain' }
  const ambiguous = AMBIGUOUS_HISTORY_PATTERNS.find((pattern) => pattern.test(line))
  return ambiguous ? { pattern: ambiguous, certainty: 'ambiguous' } : null
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

type ScannedLine = { text: string; line: number }

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

function proseOnly(line: string): string {
  return line
    .replace(/(`+)[^`\n]*?\1/g, (value) => ' '.repeat(value.length))
    .replace(/\[[^\]]*\]\([^)]*\)/g, (value) => ' '.repeat(value.length))
}

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
        message: 'contains a task key',
        remedy: 'remove the task key; tasks may link to docs, but docs do not link to tasks',
      })
    } else if (issuePattern) {
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
