// concern: premature-final

const OPENING_PROGRESS_VOCABULARY =
  /\b(?:starting|beginning|gathering|reading|review not started|before (?:writing|drafting|answering)|i will|i'll|next i)\b/i

export type PrematureFinalReplyShape = 'reader' | 'review' | 'done-writer' | 'other'

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
  deliveredContents: readonly string[]
  measuredFiles: readonly string[] | null
  textFields: readonly string[]
}

export type PrematureFinalRefusal = {
  failureKind: 'premature-final'
  error: string
}

type ProvisionalPrematureFinalOutcome<FailureKind extends string> = {
  status: 'ok' | 'asking' | 'failed'
  error: string | null
  failureKind: FailureKind | null
}

function hasEvidence(facts: PrematureFinalFacts): boolean {
  return Object.values(facts.evidence).some((items) => items != null && items.length > 0)
}

/** Refuse a terminal reply that contains only an opening progress narration. */
export function decidePrematureFinal(facts: PrematureFinalFacts): PrematureFinalRefusal | null {
  const readerReplyEmpty =
    facts.deliveredContents.length === 0 ||
    facts.deliveredContents.every((content) => OPENING_PROGRESS_VOCABULARY.test(content))
  const emptyReply =
    (facts.replyShape === 'reader' && readerReplyEmpty) ||
    facts.replyShape === 'review' ||
    (facts.replyShape === 'done-writer' &&
      Array.isArray(facts.measuredFiles) &&
      facts.measuredFiles.length === 0)
  if (
    facts.exitCode !== 0 ||
    facts.toolEventRecorded ||
    hasEvidence(facts) ||
    facts.reportsRun ||
    facts.questionsAsked ||
    !emptyReply
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

/** Premature-final replaces only provisional outcomes that describe an otherwise empty reply. */
export function applyPrematureFinalFailure<FailureKind extends string>(
  outcome: ProvisionalPrematureFinalOutcome<FailureKind>,
  refusal: PrematureFinalRefusal | null,
): ProvisionalPrematureFinalOutcome<FailureKind | 'premature-final'> {
  if (!refusal) return outcome
  if (
    outcome.status === 'ok' ||
    outcome.failureKind === 'unevidenced' ||
    outcome.failureKind === 'other'
  ) {
    return { status: 'failed', ...refusal }
  }
  return outcome
}
