// concern: workflows
/** Records an agent's workflow ruling before the cursor closes it in the caller's transaction. */

import type { Database } from 'bun:sqlite'
import { nowIso, sessionId } from '../database/db.ts'
import { answerWorkflowQuestion, upsertWorkflowQuestion } from '../run/question-mutation.ts'
import type { AutonomyValue } from './autonomy.ts'
import type { Floor } from './workflow-floor.ts'
import { selfRulingRefusal } from './workflow-self-ruling.ts'

export type WorkflowSelfRulingInput = {
  ruling: string
  basis: string
  question?: string
  channel: 'cli' | 'mcp'
}

export function recordWorkflowSelfRuling(
  input: {
    cursorId: number
    workflowKey: string
    stepOrdinal: number
    stepSlug: string
    stepTitle: string
    resolvedAutonomy: AutonomyValue
    floors: Pick<Floor, 'kind' | 'operatorRuling'>[]
    selfRuling: WorkflowSelfRulingInput
  },
  database: Database,
): { questionId: number } {
  const ruling = input.selfRuling.ruling.trim()
  if (!ruling) throw new Error('--self-ruling is required')
  const basis = input.selfRuling.basis.trim()
  const refusal = selfRulingRefusal(input.resolvedAutonomy, input.floors, basis)
  if (refusal) throw new Error(refusal)
  const at = nowIso()
  const question = upsertWorkflowQuestion(
    {
      cursorId: input.cursorId,
      workflowKey: input.workflowKey,
      stepOrdinal: input.stepOrdinal,
      stepSlug: input.stepSlug,
      question: input.selfRuling.question?.trim() || input.stepTitle,
      at,
    },
    database,
  )
  answerWorkflowQuestion(
    {
      questionId: question.recordId,
      cursorId: input.cursorId,
      ruling,
      basis,
      at,
      actor: sessionId(),
      fromOperator: false,
      channel: input.selfRuling.channel,
    },
    database,
  )
  return { questionId: question.number }
}

export function bindCloseSelfRuling<T extends { ruling?: number }>(
  input: Omit<Parameters<typeof recordWorkflowSelfRuling>[0], 'selfRuling'> & {
    evidence: T
    selfRuling?: WorkflowSelfRulingInput
  },
  database: Database,
): T {
  if (!input.selfRuling) return input.evidence
  if (input.evidence.ruling !== undefined)
    throw new Error('--self-ruling and --ruling are mutually exclusive')
  const recorded = recordWorkflowSelfRuling({ ...input, selfRuling: input.selfRuling }, database)
  return { ...input.evidence, ruling: recorded.questionId }
}
