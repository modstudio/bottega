// concern: review second opinion
/** Identifies the two runs credited as distinct-model opinions for one lens. */

import { evidenceModel } from '../route/evidence-model.ts'

export type SecondOpinionRun = {
  recordId: string
  runId: string
  lens: string
  model: string | null
  baseUrl: string | null
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
  const firstModel = first?.model ? evidenceModel(first.model, first.baseUrl) : null
  const second = firstModel
    ? eligible.find(
        (opinion) => opinion.model && evidenceModel(opinion.model, opinion.baseUrl) !== firstModel,
      )
    : undefined
  return first && second ? { firstRunId: first.runId, secondRunId: second.runId } : null
}
