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
import { recordPool } from './record-pool.ts'
import { pushQuestionAudits } from './record-question-audit.ts'
import type {
  QuestionIntent,
  QuestionWriteBody,
  QuestionWriteResult,
} from './record-question-contract.ts'
import { projectRecordId } from './record-sync-project-identity.ts'
import { questionValues } from './record-sync-service.ts'

type Tenant = { url: string } & TenantPrincipal

async function allocateQuestionNumber(tx: SQL, spaceId: string): Promise<number> {
  const rows = (await tx`
    INSERT INTO question_number_counter (space_id,next)
    VALUES (
      ${spaceId}::uuid,
      COALESCE((SELECT MAX(number)::bigint + 2 FROM question WHERE space_id=${spaceId}::uuid),2)
    )
    ON CONFLICT (space_id) DO UPDATE SET next=GREATEST(
      question_number_counter.next,
      COALESCE((SELECT MAX(number)::bigint + 1 FROM question WHERE space_id=${spaceId}::uuid),1)
    ) + 1
    RETURNING next - 1 AS number
  `) as Array<{ number: bigint | number | string }>
  return Number(rows[0]!.number)
}

export async function writeRecordQuestion(
  intent: QuestionIntent,
  input: Tenant & QuestionWriteBody,
): Promise<QuestionWriteResult> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    const existing = (await tx`
      SELECT number,revision,last_request_id::text
        FROM question WHERE id=${input.question.id}::uuid FOR UPDATE
    `) as Array<{
      number: number | string | null
      revision: number | string
      last_request_id: string | null
    }>
    if (existing[0]?.last_request_id === input.requestId)
      return {
        id: input.question.id,
        number: Number(existing[0].number),
        revision: Number(existing[0].revision),
      }
    if (intent !== 'ask' && !existing[0]) throw new Error(`question ${input.question.id} not found`)
    const number =
      existing[0]?.number == null
        ? await allocateQuestionNumber(tx, input.spaceId)
        : Number(existing[0].number)
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
    const values = questionValues(payload, projectId, workflowTaskId)
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
    if (!result && existing[0])
      throw new Error(
        `question ${input.question.id} already holds hosted revision ${existing[0].revision}; re-read the question, then retry`,
      )
    if (!result || result.number == null)
      throw new Error(
        `question ${input.question.id} write did not satisfy its revision precondition`,
      )
    await pushQuestionAudits(tx, payload, input.question.id, input.spaceId)
    return {
      id: input.question.id,
      number: Number(result.number),
      revision: Number(result.revision),
    }
  })
}
