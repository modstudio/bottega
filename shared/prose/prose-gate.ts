// concern: prose
/** Runs the shared prose engine over named write fields and formats one refusal. */

import { isEnglishWord } from './english-words.ts'
import { harperFindings } from './harper-adapter.ts'
import {
  checkProse,
  type ProseCheckFinding,
  proseCheckRefusal,
  proseCheckSkipNotice,
} from './prose-check.ts'

export type ProseGateField = { field: string; text: string; prior: string | null }
export type ProseGateResult = { refusal: string | null; notices: string[] }
export type EngineResult = Awaited<ReturnType<typeof harperFindings>>

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

export async function proseGate(
  fields: ProseGateField[],
  options: {
    displayName: string | null
    enabled: boolean
    engine?: (text: string) => Promise<EngineResult>
  },
): Promise<ProseGateResult> {
  if (!options.enabled)
    return { refusal: null, notices: ['Spelling and grammar check is switched off'] }
  const refusalSections: string[] = []
  const notices: string[] = []
  const engine = options.engine ?? harperFindings
  const checkOptions = { displayName: options.displayName, isEnglishWord }
  for (const field of fields) {
    if (!field.text.trim()) continue
    const current = checkProse(field.text, await engine(field.text), checkOptions)
    const notice = proseCheckSkipNotice(current)
    if (notice) {
      notices.push(`${field.field}: ${notice}`)
      continue
    }
    let findings = current.findings
    if (field.prior !== null) {
      const prior = checkProse(field.prior, await engine(field.prior), checkOptions)
      const priorNotice = proseCheckSkipNotice(prior)
      if (priorNotice) {
        notices.push(`${field.field}: ${priorNotice}`)
        continue
      }
      findings = introducedFindings(findings, prior.findings)
    }
    for (const finding of findings.filter((finding) => !finding.blocking)) {
      const suggestion = finding.suggestion === null ? 'none' : `"${finding.suggestion}"`
      notices.push(`${field.field}: advisory: "${finding.text}"; suggestion: ${suggestion}`)
    }
    const refusal = proseCheckRefusal({ ...current, findings })
    if (refusal) {
      const lines = refusal.split('\n')
      refusalSections.push(`${field.field}:`, ...lines.slice(0, -1))
    }
  }
  return {
    refusal:
      refusalSections.length === 0
        ? null
        : [...refusalSections, 'Correct the text and resubmit it.'].join('\n'),
    notices,
  }
}
