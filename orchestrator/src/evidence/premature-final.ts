// concern: premature-final

const OPENING_PROGRESS_VOCABULARY =
  /\b(?:starting|beginning|gathering|reading|review not started|before (?:writing|drafting|answering))\b/i

export type PrematureFinalReplyShape =
  | 'reader-no-deliverables'
  | 'review-no-evidence'
  | 'done-writer-no-files'
  | 'other'

export type PrematureFinalFacts = {
  exitCode: number
  toolEventRecorded: boolean
  evidence: {
    filesWritten?: readonly string[] | null
    filesChanged?: readonly string[] | null
    filesCovered?: readonly string[] | null
    commandsRun?: readonly string[] | null
    mcpTools?: readonly string[] | null
    docsRead?: readonly string[] | null
  }
  reportsRun: boolean
  questionsAsked: boolean
  replyShape: PrematureFinalReplyShape
  textFields: readonly string[]
}

export type PrematureFinalRefusal = {
  failureKind: 'premature-final'
  error: string
}

function hasEvidence(facts: PrematureFinalFacts): boolean {
  return Object.values(facts.evidence).some((items) => items != null && items.length > 0)
}

/** Refuse a terminal reply that contains only an opening progress narration. */
export function decidePrematureFinal(facts: PrematureFinalFacts): PrematureFinalRefusal | null {
  if (
    facts.exitCode !== 0 ||
    facts.toolEventRecorded ||
    hasEvidence(facts) ||
    facts.reportsRun ||
    facts.questionsAsked ||
    facts.replyShape === 'other'
  ) {
    return null
  }

  const openingText = facts.textFields.find((text) => OPENING_PROGRESS_VOCABULARY.test(text))
  if (!openingText) return null
  const excerpt = openingText.trim().replace(/\s+/g, ' ').slice(0, 120)
  return {
    failureKind: 'premature-final',
    error:
      'premature final: the agent ended its turn with opening narration and no work ' +
      `(${excerpt}…)`,
  }
}
