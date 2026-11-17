// concern: question-mutation
/** Owns authority and audit for workflow-question mutations. Run questions keep run authority. */

import type { Database } from 'bun:sqlite'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db, sessionId } from '../database/db.ts'
import {
  askQuestion,
  mutateQuestion,
  requireQuestionMutationApplied,
} from '../question-store/question-store-mutation.ts'
import {
  questionById,
  unlinkedWorkflowQuestions,
  waitingQuestions,
} from '../question-store/question-store-read.ts'
import { rulingActor } from './question-vocabulary.ts'
import { adoptedMutationReason } from './run-authority.ts'
import {
  joinMutationReason,
  RUN_MUTATION_WINDOW_MS,
  type RunMutationOwnerFacts,
  reauthorizeAdoptedMutation,
  runMutationOwnerDecision,
} from './run-mutation-owner.ts'
import type { SessionProcessProbe } from './session-liveness-adapter.ts'
import { sessionLivenessEvidence } from './session-liveness-adapter.ts'

export type QuestionMutationAction = 'rule' | 'overturn' | 'file' | 'close'

export function authorizeWorkflowQuestionMutation(input: {
  owner: string | null
  actor: string | null
  fromOperator: boolean
  subject: string
  action: QuestionMutationAction
  chainLastActivityAt: number
  now?: number
  database?: Database
  probe?: SessionProcessProbe
}): string | null {
  const database = input.database ?? db()
  const readFacts = (): RunMutationOwnerFacts & {
    ownerProcesses: ReturnType<typeof sessionLivenessEvidence>['candidates']
  } => {
    const liveness =
      input.owner === null
        ? { ownerProcess: 'unknown' as const, ownerLastSeenAt: null }
        : sessionLivenessEvidence(database, input.owner, input.actor, {
            now: input.now,
            probe: input.probe,
          })
    return {
      owner: input.owner,
      actor: input.actor,
      ownerLastSeenAt: liveness.ownerLastSeenAt,
      chainLastActivityAt: input.chainLastActivityAt,
      coordinatorRun: false,
      now: input.now ?? Date.now(),
      windowMs: RUN_MUTATION_WINDOW_MS,
      ownerProcess: liveness.ownerProcess,
      ownerProcesses: 'candidates' in liveness ? liveness.candidates : [],
    }
  }
  const initial = readFacts()
  const refusal = () => {
    if (!input.actor)
      throw new Error(
        `${input.subject} is owned by session ${input.owner}; ${callerIdentityRefusal(callerIdentity(), input.action)}`,
      )
    throw new Error(
      `${input.subject} is owned by session ${input.owner}; ` +
        `current session ${input.actor} cannot ${input.action} it (owner active within the window)`,
    )
  }
  const current = reauthorizeAdoptedMutation(initial, readFacts, refusal)
  const decision = runMutationOwnerDecision(current)
  if (input.fromOperator || decision === 'owner') return null
  if (decision === 'adopt')
    return adoptedMutationReason(input.owner, input.actor, {
      ownerProcess: current.ownerProcess,
      candidates: current.ownerProcesses,
    })
  return refusal()
}

export async function upsertWorkflowQuestion(
  input: {
    cursorId: string
    projectId: string | null
    workflowKey: string
    workflowTaskRecordId: string | null
    stepOrdinal: number
    stepSlug: string
    question: string
    at: string
  },
  database: Database = db(),
): Promise<{ recordId: string; number: number }> {
  const open = (await waitingQuestions(database)).find(
    ({ workflow_cursor_record_id }) => workflow_cursor_record_id === input.cursorId,
  )
  if (open) {
    const row = await questionById(database, open.question_record_id)
    if (row?.project_record_id === null && input.projectId) {
      const mutation = await mutateQuestion(database, {
        id: open.question_record_id,
        intent: 'close',
        at: input.at,
        actorSession: sessionId(),
        reason: `re-asked in its project's record space (DEV-2373)`,
        changes: {
          closedAt: input.at,
          closeReason: `re-asked in its project's record space (DEV-2373)`,
        },
      })
      requireQuestionMutationApplied(mutation, row)
    } else {
      const mutation = await mutateQuestion(database, {
        id: open.question_record_id,
        intent: 'link',
        at: input.at,
        actorSession: sessionId(),
        reason: null,
        changes: {
          question: input.question,
          workflowKey: input.workflowKey || null,
          workflowTaskId: input.workflowTaskRecordId,
        },
      })
      const linked = await questionById(database, open.question_record_id)
      requireQuestionMutationApplied(mutation, linked!)
      return { recordId: open.question_record_id, number: Number(linked!.number) }
    }
  }
  const inserted = await askQuestion(database, {
    workflowCursorRecordId: input.cursorId,
    projectId: input.projectId,
    workflowKey: input.workflowKey || null,
    workflowTaskId: input.workflowTaskRecordId,
    askedAt: input.at,
    question: input.question,
    askedVia: 'workflow',
    awaitingOperatorAt: input.at,
  })
  return { recordId: inserted.id, number: inserted.number }
}

/** Links one workflow question through the mutation path so revision and outbox stay in sync. */
export async function linkWorkflowQuestionTaskReference(
  questionId: string,
  taskRecordId: string,
  database: Database = db(),
): Promise<boolean> {
  const row = await questionById(database, questionId)
  if (!row || row.workflow_task_record_id !== null) return false
  const mutation = await mutateQuestion(database, {
    id: questionId,
    intent: 'link',
    at: new Date().toISOString(),
    actorSession: sessionId(),
    reason: null,
    changes: { workflowTaskId: taskRecordId },
  })
  requireQuestionMutationApplied(mutation, row)
  return true
}

/** Links workflow questions through the mutation path so revisions and outbox rows stay in sync. */
export async function linkWorkflowQuestionsTaskReference(
  input: { project: string; workflowKey: string; taskRecordId: string },
  database: Database = db(),
): Promise<number> {
  const questions = (
    await unlinkedWorkflowQuestions(database, {
      project: input.project,
      workflowKey: input.workflowKey,
    })
  ).map((row) => String(row.record_id))
  let linked = 0
  for (const questionId of questions) {
    if (await linkWorkflowQuestionTaskReference(questionId, input.taskRecordId, database)) linked++
  }
  return linked
}

export async function answerWorkflowQuestion(
  input: {
    questionId: string
    cursorId: string
    ruling: string
    basis?: string | null
    at: string
    actor: string | null
    fromOperator: boolean
    personName: string | null
    channel: 'cli' | 'mcp'
    adoptionReason?: string | null
  },
  database: Database = db(),
): Promise<void> {
  const row = await questionById(database, input.questionId)
  if (
    !row ||
    row.workflow_cursor_record_id !== input.cursorId ||
    row.answer !== null ||
    row.closed_at !== null
  )
    throw new Error(`question ${input.questionId} is not open`)
  const mutation = await mutateQuestion(database, {
    id: input.questionId,
    intent: 'answer',
    at: input.at,
    actorSession: input.actor,
    reason: joinMutationReason(input.ruling, input.adoptionReason ?? null),
    auditAction: 'rule',
    requireOpen: true,
    changes: {
      answer: input.ruling,
      answerBasis: input.basis ?? null,
      answeredAt: input.at,
      answeredBy: rulingActor(input.fromOperator, input.actor),
      answeredByName: input.personName,
      answererKind: input.fromOperator ? 'operator' : 'agent',
      answerChannel: input.channel,
    },
  })
  requireQuestionMutationApplied(mutation, row)
}
