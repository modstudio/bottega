// concern: prose
/** Pure composition of correction-list findings, masking, naming, and refusal text. */

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

export type ProseCheck = { findings: ProseCheckFinding[] }

type FindingWithoutCorrection = Omit<ProseCheckFinding, 'correctedSentence'>
type Range = { start: number; end: number }

function normalizedWord(word: string): string {
  return word.replaceAll('’', "'").replace(/'s$/i, '').toLowerCase()
}

/** Restores the original word's leading capital and possessive to a lowercase variant. */
function variantInPlace(original: string, variant: string): string {
  const possessive = original.match(/['’]s$/i)?.[0] ?? ''
  const capitalized = /^[A-Z]/.test(original)
    ? `${variant[0]?.toUpperCase() ?? ''}${variant.slice(1)}`
    : variant
  return `${capitalized}${possessive}`
}

/** One flag per character, so mask tests cost the same however many ranges a text has. */
type MaskMap = Uint8Array

function maskMap(text: string, ranges: Range[]): MaskMap {
  const masked = new Uint8Array(text.length)
  for (const range of ranges) masked.fill(1, range.start, range.end)
  return masked
}

function overlaps(finding: Range, masked: MaskMap): boolean {
  for (let index = finding.start; index < finding.end; index += 1) {
    if (masked[index] === 1) return true
  }
  return false
}

type CheckProseOptions = {
  displayName: string | null
  isAllowedWord: (word: string) => boolean
  misspellingCorrection: (word: string) => string | null
  americanSpelling: (word: string) => string | null
}

function correctionFindings(
  text: string,
  masks: MaskMap,
  options: CheckProseOptions,
): FindingWithoutCorrection[] {
  const findings: FindingWithoutCorrection[] = []
  for (const match of text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)?/g)) {
    const start = match.index
    const end = start + match[0].length
    if (overlaps({ start, end }, masks)) continue
    const normalized = normalizedWord(match[0])
    if (options.isAllowedWord(normalized)) continue
    const misspelling = options.misspellingCorrection(normalized)
    const american = misspelling === null ? options.americanSpelling(normalized) : null
    if (misspelling === null && american === null) continue
    const rule = misspelling === null ? 'BritishSpelling' : 'Misspelling'
    const variant = misspelling ?? american
    findings.push({
      rule,
      start,
      end,
      text: match[0],
      message:
        rule === 'Misspelling' ? 'This word is a known misspelling.' : 'Use the American spelling.',
      suggestion: variantInPlace(match[0], variant ?? normalized),
      blocking: true,
    })
  }
  return findings
}

function repeatedWordFindings(text: string, masks: MaskMap): FindingWithoutCorrection[] {
  const findings: FindingWithoutCorrection[] = []
  for (const match of text.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    const start = match.index
    const end = start + match[0].length
    if (overlaps({ start, end }, masks)) continue
    findings.push({
      rule: 'RepeatedWord',
      start,
      end,
      text: match[0],
      message: 'This word is repeated.',
      suggestion: match[1] ?? null,
      blocking: false,
    })
  }
  return findings
}

function isNewlineBoundary(text: string, index: number): boolean {
  return text[index] === '\n' && (index + 1 === text.length || /\s/.test(text[index + 1] ?? ''))
}

function isSentenceTerminator(text: string, index: number): boolean {
  return text[index] === '.' || text[index] === '!' || text[index] === '?'
}

function sentenceBounds(text: string, position: number, masks: MaskMap): Range {
  const masked = (index: number) => masks[index] === 1
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
  masks: MaskMap,
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

export function checkProse(text: string, options: CheckProseOptions): ProseCheck {
  const ranges = maskedRanges(text)
  const masks = maskMap(text, ranges)
  const findings: FindingWithoutCorrection[] = [
    ...correctionFindings(text, masks, options),
    ...repeatedWordFindings(text, masks),
    ...namingFindings(text, options.displayName, ranges).map((finding) => ({
      rule: finding.rule,
      start: finding.start,
      end: finding.end,
      text: finding.text,
      message: finding.message,
      suggestion: finding.suggestions[0] ?? null,
      blocking: true,
    })),
  ].sort((left, right) => left.start - right.start || left.end - right.end)
  return {
    findings: findings.map((finding) => ({
      ...finding,
      correctedSentence: correctedSentence(text, finding, findings, masks),
    })),
  }
}

/** Renders a finding's suggestion the same way in refusals and advisory notices. */
export function suggestionText(suggestion: string | null): string {
  return suggestion === null ? 'none' : `"${suggestion}"`
}

export function proseCheckRefusal(check: ProseCheck): string | null {
  const blocking = check.findings.filter((finding) => finding.blocking)
  if (blocking.length === 0) return null
  const lines = blocking.map(
    (finding) =>
      `"${finding.text}"; suggestion: ${suggestionText(finding.suggestion)}; corrected sentence: "${finding.correctedSentence}"`,
  )
  return [...lines, 'Correct the text and resubmit it.'].join('\n')
}
