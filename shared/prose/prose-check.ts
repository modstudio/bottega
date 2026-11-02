// concern: prose
/** Pure composition of Harper findings, masking, naming, and refusal text. */

import type { EngineFinding, EngineResult } from './harper-adapter.ts'
import { namingFindings } from './naming-rule.ts'
import { maskedRanges } from './prose-mask.ts'

export type ProseCheckFinding = {
  rule: string
  start: number
  end: number
  text: string
  message: string
  suggestion: string | null
  blocking: boolean
  correctedSentence: string
}

export type ProseCheck =
  | { ran: true; findings: ProseCheckFinding[] }
  | { ran: false; reason: string; findings: ProseCheckFinding[] }

type FindingWithoutCorrection = Omit<ProseCheckFinding, 'correctedSentence'>

function normalizedWord(word: string): string {
  return word.replaceAll('’', "'").replace(/'s$/i, '').toLowerCase()
}

export function americanVariant(
  word: string,
  isEnglishWord: (word: string) => boolean,
): string | null {
  const normalized = normalizedWord(word)
  const replacements: Array<[RegExp, string]> = [
    [/our(s|ed|ing|ite|ites|able)?$/, 'or$1'],
    [/isations$/, 'izations'],
    [/isation$/, 'ization'],
    [/ising$/, 'izing'],
    [/ises$/, 'izes'],
    [/ised$/, 'ized'],
    [/ise$/, 'ize'],
    [/ysing$/, 'yzing'],
    [/ysed$/, 'yzed'],
    [/yse$/, 'yze'],
    [/ogues$/, 'ogs'],
    [/ogue$/, 'og'],
    [/dgements$/, 'dgments'],
    [/dgement$/, 'dgment'],
    [/llers$/, 'lers'],
    [/ller$/, 'ler'],
    [/lling$/, 'ling'],
    [/lled$/, 'led'],
    [/ence$/, 'ense'],
    [/tres$/, 'ters'],
    [/tre$/, 'ter'],
  ]
  for (const [pattern, replacement] of replacements) {
    const candidate = normalized.replace(pattern, replacement)
    if (candidate !== normalized && isEnglishWord(candidate)) return candidate
  }
  return null
}

/** Restores the original word's leading capital and possessive to a lowercase variant. */
function variantInPlace(original: string, variant: string): string {
  const possessive = original.match(/['’]s$/i)?.[0] ?? ''
  const capitalized = /^[A-Z]/.test(original)
    ? `${variant[0]?.toUpperCase() ?? ''}${variant.slice(1)}`
    : variant
  return `${capitalized}${possessive}`
}

function isDetachedPossessive(text: string, finding: EngineFinding): boolean {
  if (finding.text === 's' && /['’]/.test(text[finding.start - 1] ?? '')) return true
  return /^\d+['’]s$/i.test(finding.text)
}

function classifiedEngineFinding(
  text: string,
  finding: EngineFinding,
  isEnglishWord: (word: string) => boolean,
): FindingWithoutCorrection | null {
  if (finding.rule === 'SpellCheck' && isDetachedPossessive(text, finding)) return null
  const normalized = normalizedWord(finding.text)
  const variant = finding.rule === 'SpellCheck' ? americanVariant(normalized, isEnglishWord) : null
  return {
    rule: finding.rule,
    start: finding.start,
    end: finding.end,
    text: finding.text,
    message: finding.message,
    suggestion: variant === null ? spanReplacement(finding) : variantInPlace(finding.text, variant),
    blocking: finding.rule === 'SpellCheck' && (variant !== null || !isEnglishWord(normalized)),
  }
}

function spanReplacement(finding: EngineFinding): string | null {
  const suggestion = finding.suggestions[0]
  if (!suggestion) return null
  if (suggestion.kind === 'remove') return ''
  if (suggestion.kind === 'insert-after') return `${finding.text}${suggestion.text}`
  return suggestion.text
}

function isNewlineBoundary(text: string, index: number): boolean {
  return text[index] === '\n' && (index + 1 === text.length || /\s/.test(text[index + 1] ?? ''))
}

function isSentenceTerminator(text: string, index: number): boolean {
  return text[index] === '.' || text[index] === '!' || text[index] === '?'
}

function overlaps(
  finding: Pick<EngineFinding, 'start' | 'end'>,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => finding.start < range.end && finding.end > range.start)
}

function sentenceBounds(
  text: string,
  position: number,
  ranges: Array<{ start: number; end: number }>,
): { start: number; end: number } {
  const masked = (index: number) =>
    ranges.some((range) => index >= range.start && index < range.end)
  let start = 0
  for (let index = position - 1; index >= 0; index -= 1) {
    if (!masked(index) && (isSentenceTerminator(text, index) || isNewlineBoundary(text, index))) {
      start = index + 1
      break
    }
  }
  let end = text.length
  for (let index = position; index < text.length; index += 1) {
    if (!masked(index) && isSentenceTerminator(text, index)) {
      end = index + 1
      break
    }
    if (!masked(index) && isNewlineBoundary(text, index)) {
      end = index
      break
    }
  }
  while (start < end && /\s/.test(text[start] ?? '')) start += 1
  while (end > start && /\s/.test(text[end - 1] ?? '')) end -= 1
  return { start, end }
}

function correctedSentence(
  text: string,
  subject: FindingWithoutCorrection,
  findings: FindingWithoutCorrection[],
  masks: Array<{ start: number; end: number }>,
): string {
  const bounds = sentenceBounds(text, subject.start, masks)
  let sentence = text.slice(bounds.start, bounds.end)
  const corrections = findings
    .filter(
      (finding) =>
        finding.blocking &&
        finding.suggestion !== null &&
        finding.start >= bounds.start &&
        finding.end <= bounds.end,
    )
    .sort((left, right) => right.start - left.start)
  for (const finding of corrections) {
    sentence = `${sentence.slice(0, finding.start - bounds.start)}${finding.suggestion}${sentence.slice(
      finding.end - bounds.start,
    )}`
  }
  return sentence
}

export function checkProse(
  text: string,
  engine: EngineResult,
  options: { displayName: string | null; isEnglishWord: (word: string) => boolean },
): ProseCheck {
  const masks = maskedRanges(text)
  const engineFindings = engine.ran
    ? engine.findings.filter((finding) => !overlaps(finding, masks))
    : []
  const findings: FindingWithoutCorrection[] = [
    ...engineFindings
      .map((finding) => classifiedEngineFinding(text, finding, options.isEnglishWord))
      .filter((finding): finding is FindingWithoutCorrection => finding !== null),
    ...namingFindings(text, options.displayName).map((finding) => ({
      rule: finding.rule,
      start: finding.start,
      end: finding.end,
      text: finding.text,
      message: finding.message,
      suggestion: finding.suggestions[0] ?? null,
      blocking: true,
    })),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
  const completed = findings.map((finding) => ({
    ...finding,
    correctedSentence: correctedSentence(text, finding, findings, masks),
  }))
  return engine.ran
    ? { ran: true, findings: completed }
    : { ran: false, reason: engine.reason, findings: completed }
}

export function proseCheckRefusal(check: ProseCheck): string | null {
  const blocking = check.findings.filter((finding) => finding.blocking)
  if (blocking.length === 0) return null
  const lines = blocking.map((finding) => {
    const suggestion = finding.suggestion === null ? 'none' : `"${finding.suggestion}"`
    return `"${finding.text}"; suggestion: ${suggestion}; corrected sentence: "${finding.correctedSentence}"`
  })
  return [...lines, 'Correct the text and resubmit it.'].join('\n')
}

export function proseCheckSkipNotice(check: ProseCheck): string | null {
  return check.ran ? null : `Spelling and grammar check did not run: ${check.reason}`
}
