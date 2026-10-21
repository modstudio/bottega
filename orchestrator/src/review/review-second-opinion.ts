// concern: review second opinion
/** Identifies the two runs credited as distinct-model opinions for one lens. */

export type SecondOpinionRun = {
  recordId: string
  runId: string
  lens: string
  model: string | null
  graded: boolean
  completed: boolean
}

export type CreditedSecondOpinionRuns = {
  firstRunId: string
  secondRunId: string
}

/** Selects the earliest graded run with a model and the earliest distinct model. */
export function identifySecondOpinionRun(
  opinions: readonly SecondOpinionRun[],
  lens: string,
): CreditedSecondOpinionRuns | null {
  const eligible = opinions
    .filter((opinion) => opinion.completed && opinion.graded && opinion.lens === lens)
    .sort((left, right) => left.recordId.localeCompare(right.recordId))
  const first = eligible.find((opinion) => opinion.model)
  const second = first
    ? eligible.find((opinion) => opinion.model && opinion.model !== first.model)
    : undefined
  return first && second ? { firstRunId: first.runId, secondRunId: second.runId } : null
}
