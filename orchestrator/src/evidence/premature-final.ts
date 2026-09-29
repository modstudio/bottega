// concern: premature-final

export const PREMATURE_FINAL_MAX_MS = 90_000

const OPENING_PROGRESS_VOCABULARY =
  /\b(?:starting|beginning|gathering|reading|review not started|before (?:writing|drafting|answering))\b/i

export type PrematureFinalReplyShape =
  | 'all-blocked-reader'
  | 'empty-review'
  | 'done-writer-no-files'
  | 'other'

export type PrematureFinalFacts = {
  exitCode: number
  latencyMs: number
  toolEventRecorded: boolean
  evidence: {
    filesWritten?: readonly string[] | null
    filesChanged?: readonly string[] | null
    findings?: readonly unknown[] | null
    filesCovered?: readonly string[] | null
    commandsRun?: readonly string[] | null
    mcpTools?: readonly string[] | null
    docsRead?: readonly string[] | null
  }
  questionsAsked: boolean
  replyShape: PrematureFinalReplyShape
  textFields: readonly string[]
}

export type PrematureFinalRefusal = {
  failureKind: 'unevidenced'
  error: string
}

function hasEvidence(facts: PrematureFinalFacts): boolean {
  return Object.values(facts.evidence).some((items) => items != null && items.length > 0)
}

/** Refuse a quick terminal reply that contains only an opening progress narration. */
export function decidePrematureFinal(facts: PrematureFinalFacts): PrematureFinalRefusal | null {
  if (
    facts.exitCode !== 0 ||
    facts.latencyMs > PREMATURE_FINAL_MAX_MS ||
    facts.toolEventRecorded ||
    hasEvidence(facts) ||
    facts.questionsAsked ||
    facts.replyShape === 'other'
  ) {
    return null
  }

  const openingText = facts.textFields.find((text) => OPENING_PROGRESS_VOCABULARY.test(text))
  if (!openingText) return null
  const excerpt = openingText.trim().replace(/\s+/g, ' ').slice(0, 80)
  return {
    failureKind: 'unevidenced',
    error:
      'premature final: the agent ended its turn with opening narration and no work ' +
      `(${excerpt}…)`,
  }
}
