// concern: prose
/** Runs the shared prose correction lists over named write fields and formats one refusal. */

import {
  checkProse,
  type ProseCheckFinding,
  proseCheckRefusal,
  suggestionText,
} from './prose-check.ts'
import { americanSpelling, isAllowedWord, misspellingCorrection } from './spelling-lists.ts'

export type ProseGateField = { field: string; text: string; prior: string | null }
export type ProseGateResult = { refusal: string | null; notices: string[] }

function introducedFindings(
  findings: ProseCheckFinding[],
  prior: ProseCheckFinding[],
): ProseCheckFinding[] {
  const remaining = new Map<string, number>()
  for (const finding of prior) {
    const key = `${finding.rule}\0${finding.text}`
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  return findings.filter((finding) => {
    const key = `${finding.rule}\0${finding.text}`
    const count = remaining.get(key) ?? 0
    if (count === 0) return true
    remaining.set(key, count - 1)
    return false
  })
}

type CheckOptions = Parameters<typeof checkProse>[1]
type FieldOutcome = { notices: string[]; refusalLines: string[] }

function advisoryNotices(field: string, findings: ProseCheckFinding[]): string[] {
  return findings
    .filter((finding) => !finding.blocking)
    .map(
      (finding) =>
        `${field}: advisory: "${finding.text}"; suggestion: ${suggestionText(finding.suggestion)}`,
    )
}

function checkedField(field: ProseGateField, checkOptions: CheckOptions): FieldOutcome {
  const current = checkProse(field.text, checkOptions)
  const findings =
    field.prior === null
      ? current.findings
      : introducedFindings(current.findings, checkProse(field.prior, checkOptions).findings)
  const refusal = proseCheckRefusal({ ...current, findings })
  return {
    notices: advisoryNotices(field.field, findings),
    refusalLines: refusal ? [`${field.field}:`, ...refusal.split('\n').slice(0, -1)] : [],
  }
}

export async function proseGate(
  fields: ProseGateField[],
  options: { displayName: string | null; enabled: boolean },
): Promise<ProseGateResult> {
  if (!options.enabled)
    return { refusal: null, notices: ['Spelling and grammar check is switched off'] }
  const refusalSections: string[] = []
  const notices: string[] = []
  const checkOptions = {
    displayName: options.displayName,
    isAllowedWord,
    misspellingCorrection,
    americanSpelling,
  }
  for (const field of fields) {
    if (!field.text.trim()) continue
    const outcome = checkedField(field, checkOptions)
    notices.push(...outcome.notices)
    refusalSections.push(...outcome.refusalLines)
  }
  return {
    refusal:
      refusalSections.length === 0
        ? null
        : [...refusalSections, 'Correct the text and resubmit it.'].join('\n'),
    notices,
  }
}
