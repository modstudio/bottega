// concern: hosted-question-write
/** Applies direct question snapshots and their audit atomically. */

import type { SQL } from 'bun'
import { and, sql as drizzleSql, eq, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { hostedTaskIdForReference } from '../../../shared/record/hosted-task-id.ts'
import {
  hostedQuestionWins,
  question as questionRecord,
} from '../../../shared/record/schema-question.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { isUniqueViolation } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'
import { pushQuestionAudits } from './record-question-audit.ts'
import type {
  QuestionIntent,
  QuestionWriteBody,
  QuestionWriteResult,
} from './record-question-contract.ts'
import { RecordQuestionError } from './record-question-contract.ts'
import { allocateQuestionNumber } from './record-question-number.ts'
import { QUESTION_STEP_CONFLICT_SET, questionValuesForWrite } from './record-question-step.ts'
import { projectRecordId } from './record-sync-project-identity.ts'

type Tenant = { url: string } & TenantPrincipal
type ExistingQuestion = {
  number: number | string | null
  revision: number | string
  last_request_id: string | null
}

function requireRestoreNumber(intent: QuestionIntent, input: Tenant & QuestionWriteBody): void {
  if (intent !== 'restore' || input.question.number !== null) return
  throw new RecordQuestionError(
    `question ${input.question.id} cannot be restored without its original number; pass the number from the retired outbox payload, then retry`,
    422,
  )
}

function restoreNumberConflict(input: Tenant & QuestionWriteBody, holderId: string) {
  return new RecordQuestionError(
    `question number ${input.question.number} in space ${input.spaceId} is already held by question ${holderId}; restore under its original number is refused`,
    409,
  )
}

async function restoreNumberHolder(
  input: Tenant & QuestionWriteBody,
  tx: SQL,
  lock: boolean,
): Promise<string | null> {
  const holder = (lock
    ? await tx`
        SELECT id::text FROM question
        WHERE space_id=${input.spaceId}::uuid AND number=${input.question.number}
          AND id<>${input.question.id}::uuid
        FOR UPDATE
      `
    : await tx`
        SELECT id::text FROM question
        WHERE space_id=${input.spaceId}::uuid AND number=${input.question.number}
          AND id<>${input.question.id}::uuid
      `) as Array<{ id: string }>
  return holder[0]?.id ?? null
}

async function questionNumberForWrite(
  intent: QuestionIntent,
  input: Tenant & QuestionWriteBody,
  existing: ExistingQuestion | undefined,
  tx: SQL,
): Promise<number> {
  if (intent !== 'ask' && intent !== 'restore' && !existing)
    throw new RecordQuestionError(`question ${input.question.id} not found`, 404)
  if (intent === 'restore' && existing?.number == null) {
    const holderId = await restoreNumberHolder(input, tx, true)
    if (holderId) throw restoreNumberConflict(input, holderId)
  }
  if (existing?.number != null) return Number(existing.number)
  if (intent === 'restore') return input.question.number!
  return allocateQuestionNumber(tx, input.spaceId)
}

export async function writeRecordQuestion(
  intent: QuestionIntent,
  input: Tenant & QuestionWriteBody,
): Promise<QuestionWriteResult> {
  const pool = recordPool(input.url)
  try {
    return await pool.begin(async (tx) => {
      await bindTenant(tx, input)
      return writeRecordQuestionTransaction(intent, input, tx)
    })
  } catch (error) {
    if (intent !== 'restore' || !isUniqueViolation(error, 'question_space_number_unique'))
      throw error
    const holderId = await pool.begin(async (tx) => {
      await bindTenant(tx, input)
      return restoreNumberHolder(input, tx, false)
    })
    if (!holderId) throw error
    throw restoreNumberConflict(input, holderId)
  }
}

export async function writeRecordQuestionTransaction(
  intent: QuestionIntent,
  input: Tenant & QuestionWriteBody,
  tx: SQL,
): Promise<QuestionWriteResult> {
  requireRestoreNumber(intent, input)
  const existing = (await tx`
      SELECT number,revision,last_request_id::text
        FROM question WHERE id=${input.question.id}::uuid FOR UPDATE
    `) as ExistingQuestion[]
  if (existing[0]?.last_request_id === input.requestId)
    return {
      id: input.question.id,
      number: Number(existing[0].number),
      revision: Number(existing[0].revision),
      applied: true,
    }
  const number = await questionNumberForWrite(intent, input, existing[0], tx)
  const payload = {
    ...input.question,
    number,
    spaceId: input.spaceId,
    audits: [{ ...input.audit, id: input.requestId }],
  }
  const workflowTaskId = await hostedTaskIdForReference(tx, input.spaceId, {
    id: input.question.workflowTaskId,
    key: input.question.workflowKey,
  })
  const projectId = await projectRecordId(tx, input.question, input)
  const values = await questionValuesForWrite(
    tx,
    payload,
    projectId,
    workflowTaskId,
    input.question.workflowCursorRecordId,
  )
  const {
    id: _id,
    createdAt: _createdAt,
    number: _number,
    workflowTaskId: _task,
    ...updates
  } = values
  const written = await drizzle({ client: tx })
    .insert(questionRecord)
    .values({ ...values, lastRequestId: input.requestId })
    .onConflictDoUpdate({
      target: questionRecord.id,
      set: {
        ...updates,
        number: drizzleSql`COALESCE(${questionRecord.number}, excluded.number)`,
        workflowTaskId: drizzleSql`COALESCE(excluded.workflow_task_id, ${questionRecord.workflowTaskId})`,
        ...QUESTION_STEP_CONFLICT_SET,
        lastRequestId: input.requestId,
      },
      setWhere: and(
        eq(questionRecord.machineId, values.machineId),
        or(
          eq(questionRecord.lastRequestId, input.requestId),
          hostedQuestionWins(drizzleSql`excluded.revision`, questionRecord.revision),
        ),
      ),
    })
    .returning({
      id: questionRecord.id,
      number: questionRecord.number,
      revision: questionRecord.revision,
    })
  const result = written[0]
  if (!result && existing[0] && existing[0].number !== null)
    return {
      id: input.question.id,
      number: Number(existing[0].number),
      revision: Number(existing[0].revision),
      applied: false,
    }
  if (!result || result.number == null)
    throw new RecordQuestionError(
      `question ${input.question.id} write did not satisfy its revision precondition`,
      409,
    )
  await pushQuestionAudits(tx, payload, input.question.id, input.spaceId)
  return {
    id: input.question.id,
    number: Number(result.number),
    revision: Number(result.revision),
    applied: true,
  }
}
