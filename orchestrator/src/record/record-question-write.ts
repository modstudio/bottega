// concern: hosted-question-write
/** Applies direct question snapshots and their audit atomically. */

import type { SQL } from 'bun'
import { and, sql as drizzleSql, eq, or } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { maskHostedTableWrite } from '../../../shared/hosted-secret-mask.ts'
import { hostedTaskIdForReference } from '../../../shared/record/hosted-task-id.ts'
import {
  hostedQuestionWins,
  questionMutationAudit as questionMutationAuditRecord,
  question as questionRecord,
} from '../../../shared/record/schema-question.ts'
import { run as runRecord } from '../../../shared/record/schema-run.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { RECORD_DIFFERENT_CONTENT } from '../doc/doc-revision-conflict.ts'
import { questionTextWriteRefusal } from '../question-store/question-text-refusal.ts'
import {
  RUN_QUESTION_OWNER_NOT_LIVE_CODE,
  RunQuestionOwnerNotLiveError,
  runQuestionOwnerAbsentMessage,
  runQuestionOwnerLive,
} from '../question-store/run-question-write-guard.ts'
import { isUniqueViolation } from './record-config-error.ts'
import { recordPool } from './record-pool.ts'
import { pushQuestionAudits } from './record-question-audit.ts'
import type {
  QuestionImportBody,
  QuestionIntent,
  QuestionIntentBody,
  QuestionWriteBody,
  QuestionWriteResult,
} from './record-question-contract.ts'
import { RecordQuestionError } from './record-question-contract.ts'
import { allocateQuestionNumber } from './record-question-number.ts'
import { QUESTION_STEP_CONFLICT_SET, questionValuesForWrite } from './record-question-step.ts'
import { questionValues } from './record-question-values.ts'
import { projectRecordId } from './record-sync-project-identity.ts'
import { recordColumnName, sameRecordValue } from './record-task-flow-write-decision.ts'

type Tenant = { url: string } & TenantPrincipal
const maskQuestionValues = <T>(value: T): T => maskHostedTableWrite('question', value)
type ExistingQuestion = {
  number: number | string | null
  revision: number | string
  last_request_id: string | null
  project_id: string | null
  question: string
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
  const holder = (
    lock
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
      `
  ) as Array<{ id: string }>
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

async function projectIdForQuestionWrite(
  intent: QuestionIntent,
  input: Tenant & QuestionWriteBody,
  existing: ExistingQuestion | undefined,
  tx: SQL,
): Promise<string | null> {
  if (existing && intent !== 'ask' && intent !== 'import' && intent !== 'restore')
    return existing.project_id
  return projectRecordId(tx, input.question, input)
}

async function assertRunQuestionOwnerLive(runId: string, tx: SQL): Promise<void> {
  // Ask asks: is this turn still the live owner of its escalation channel?
  const owners = await drizzle({ client: tx })
    .select({ status: runRecord.status })
    .from(runRecord)
    .where(eq(runRecord.id, runId))
    .for('update')
  const owner = owners[0]
  if (!owner)
    throw new RecordQuestionError(runQuestionOwnerAbsentMessage(runId, PLATFORM_SLUG), 409)
  if (!runQuestionOwnerLive(owner.status)) {
    const cause = new RunQuestionOwnerNotLiveError(runId)
    const refusal = new RecordQuestionError(cause.message, 409, RUN_QUESTION_OWNER_NOT_LIVE_CODE)
    refusal.cause = cause
    throw refusal
  }
}

function assertQuestionTextWriteAllowed(
  intent: QuestionIntent,
  stored: string | null,
  proposed: unknown,
  status: 409 | 422,
): void {
  const refusal = questionTextWriteRefusal(intent, stored, proposed)
  if (refusal) throw new RecordQuestionError(refusal.message, status)
}

function maskedQuestionText(question: string): string {
  return maskQuestionValues({ question }).question
}

async function existingQuestionForWrite(
  id: string,
  tx: SQL,
): Promise<ExistingQuestion | undefined> {
  const rows = (await tx`
    SELECT number,revision,last_request_id::text,project_id::text,question
      FROM question WHERE id=${id}::uuid FOR UPDATE
  `) as ExistingQuestion[]
  return rows[0]
}

function replayedQuestionWrite(id: string, existing: ExistingQuestion): QuestionWriteResult {
  return {
    id,
    number: Number(existing.number),
    revision: Number(existing.revision),
    applied: true,
    replayed: true,
  }
}

function questionWritePayload(writeInput: Tenant & QuestionWriteBody, number: number) {
  return {
    ...writeInput.question,
    number,
    spaceId: writeInput.spaceId,
    audits: [{ ...writeInput.audit, id: writeInput.requestId }],
  }
}

export async function writeRecordQuestion(
  intent: QuestionIntent,
  input: Tenant & QuestionIntentBody,
): Promise<QuestionWriteResult> {
  const pool = recordPool(input.url)
  try {
    return await pool.begin(async (tx) => {
      await bindTenant(tx, input)
      return writeRecordQuestionTransaction(intent, input, tx)
    })
  } catch (error) {
    if (intent === 'import' && isUniqueViolation(error, 'question_mutation_audit_identity'))
      throw new RecordQuestionError(
        `question ${input.question.id} ${RECORD_DIFFERENT_CONTENT}`,
        409,
      )
    if (intent === 'import' && isUniqueViolation(error, 'question_pkey'))
      throw new RecordQuestionError(
        `question ${input.question.id} already exists in another space; it was not imported`,
        409,
      )
    if (intent !== 'restore') throw error
    const writeInput = input as Tenant & QuestionWriteBody
    if (isUniqueViolation(error, 'question_pkey'))
      throw new RecordQuestionError(
        `question ${writeInput.question.id} already exists in another space; it was not restored`,
        409,
      )
    if (!isUniqueViolation(error, 'question_space_number_unique')) throw error
    const holderId = await pool.begin(async (tx) => {
      await bindTenant(tx, input)
      return restoreNumberHolder(writeInput, tx, false)
    })
    if (!holderId) throw error
    throw restoreNumberConflict(writeInput, holderId)
  }
}

export async function writeRecordQuestionTransaction(
  intent: QuestionIntent,
  input: Tenant & QuestionIntentBody,
  tx: SQL,
): Promise<QuestionWriteResult> {
  assertQuestionTextWriteAllowed(intent, input.question.question, input.question.question, 422)
  if (intent === 'import')
    return importRecordQuestionTransaction(input as Tenant & QuestionImportBody, tx)
  const writeInput = input as Tenant & QuestionWriteBody
  requireRestoreNumber(intent, writeInput)
  if (intent === 'ask' && writeInput.question.runId)
    await assertRunQuestionOwnerLive(writeInput.question.runId, tx)
  const existing = await existingQuestionForWrite(writeInput.question.id, tx)
  if (existing?.last_request_id === writeInput.requestId)
    return replayedQuestionWrite(writeInput.question.id, existing)
  if (existing)
    assertQuestionTextWriteAllowed(
      intent,
      existing.question,
      maskedQuestionText(writeInput.question.question),
      409,
    )
  const number = await questionNumberForWrite(intent, writeInput, existing, tx)
  const payload = questionWritePayload(writeInput, number)
  const workflowTaskId = await hostedTaskIdForReference(tx, writeInput.spaceId, {
    id: writeInput.question.workflowTaskId,
    key: writeInput.question.workflowKey,
  })
  const projectId = await projectIdForQuestionWrite(intent, writeInput, existing, tx)
  const values = maskQuestionValues(
    await questionValuesForWrite(
      tx,
      payload,
      projectId,
      workflowTaskId,
      writeInput.question.workflowCursorRecordId,
      intent === 'ask',
    ),
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
    .values({ ...values, lastRequestId: writeInput.requestId })
    .onConflictDoUpdate({
      target: questionRecord.id,
      set: {
        ...updates,
        number: drizzleSql`COALESCE(${questionRecord.number}, excluded.number)`,
        workflowTaskId: drizzleSql`COALESCE(excluded.workflow_task_id, ${questionRecord.workflowTaskId})`,
        ...QUESTION_STEP_CONFLICT_SET,
        lastRequestId: writeInput.requestId,
      },
      setWhere: and(
        eq(questionRecord.machineId, values.machineId),
        or(
          eq(questionRecord.lastRequestId, writeInput.requestId),
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
  if (!result && existing && existing.number !== null)
    return {
      id: writeInput.question.id,
      number: Number(existing.number),
      revision: Number(existing.revision),
      applied: false,
    }
  if (!result || result.number == null)
    throw new RecordQuestionError(
      `question ${writeInput.question.id} write did not satisfy its revision precondition`,
      409,
    )
  await pushQuestionAudits(tx, payload, writeInput.question.id, writeInput.spaceId)
  return {
    id: writeInput.question.id,
    number: Number(result.number),
    revision: Number(result.revision),
    applied: true,
  }
}

function assertSameQuestionRow(
  table: string,
  id: string,
  existing: Record<string, unknown>,
  values: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'number' || key === 'lastRequestId') continue
    if (!sameRecordValue(existing[recordColumnName(key)], value))
      throw new RecordQuestionError(`${table} ${id} ${RECORD_DIFFERENT_CONTENT}`, 409)
  }
}

async function importQuestionAudit(
  tx: SQL,
  spaceId: string,
  questionId: string,
  audit: QuestionImportBody['audits'][number],
): Promise<void> {
  const rows = (await tx`
    SELECT * FROM question_mutation_audit WHERE id=${audit.id}::uuid FOR UPDATE
  `) as Array<Record<string, unknown>>
  const values = { ...audit, at: new Date(audit.at), questionId, spaceId }
  if (rows[0]) return assertSameQuestionRow('question_mutation_audit', audit.id, rows[0], values)
  await drizzle({ client: tx }).insert(questionMutationAuditRecord).values(values)
}

async function importRecordQuestionTransaction(
  input: Tenant & QuestionImportBody,
  tx: SQL,
): Promise<QuestionWriteResult> {
  const existing = (await tx`
    SELECT * FROM question WHERE id=${input.question.id}::uuid FOR UPDATE
  `) as Array<Record<string, unknown>>
  const number =
    existing[0]?.number == null
      ? await allocateQuestionNumber(tx, input.spaceId)
      : Number(existing[0].number)
  const workflowTaskId = await hostedTaskIdForReference(tx, input.spaceId, {
    id: input.question.workflowTaskId,
    key: input.question.workflowKey,
  })
  const projectId = await projectRecordId(tx, input.question, input)
  const values = maskQuestionValues({
    ...questionValues(
      { ...input.question, number, spaceId: input.spaceId },
      projectId,
      workflowTaskId,
    ),
    workflowStepOrdinal: input.question.workflowStepOrdinal ?? null,
    workflowStepSlug: input.question.workflowStepSlug ?? null,
    lastRequestId: input.requestId,
  })
  if (existing[0]) assertSameQuestionRow('question', input.question.id, existing[0], values)
  else await drizzle({ client: tx }).insert(questionRecord).values(values)
  for (const audit of input.audits)
    await importQuestionAudit(tx, input.spaceId, input.question.id, audit)
  return {
    id: input.question.id,
    number,
    revision: input.question.revision,
    applied: true,
    ...(existing[0] ? { replayed: true } : {}),
  }
}
