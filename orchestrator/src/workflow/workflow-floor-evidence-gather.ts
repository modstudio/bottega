// concern: workflows
/** Composes independent floor-evidence readers into one validated fact set. */

import { db } from '../database/db.ts'
import { gatherValidatedEvidenceBase, questionRowToFacts } from './workflow-floor-evidence.ts'
import { gatherStepQuestionEvidence } from './workflow-step-question-evidence.ts'

export function gatherValidatedEvidence(
  input: Parameters<typeof gatherValidatedEvidenceBase>[0],
): ReturnType<typeof gatherValidatedEvidenceBase> {
  const gathered = gatherValidatedEvidenceBase(input)
  Object.assign(gathered, gatherStepQuestionEvidence(input, input.d ?? db(), questionRowToFacts))
  return gathered
}
