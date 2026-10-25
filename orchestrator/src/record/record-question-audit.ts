// concern: record-question-audit
/** Writes the mutation audit bundled with one question outbox payload. */
import type { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { questionMutationAudit as questionMutationAuditRecord } from '../../../shared/record/schema-question.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { OutboxRowError } from './outbox-failure.ts'
import type { RecordPayload as Payload } from './record-sync-contract.ts'

type QuestionAuditPayload = {
  action: unknown
  actorSession: unknown
  at: unknown
  reason: unknown
}

function questionAudits(row: Payload): QuestionAuditPayload[] {
  if (!Array.isArray(row.audits)) {
    throw new OutboxRowError('question outbox audits must be an array', 'row-validation')
  }
  return row.audits as QuestionAuditPayload[]
}

const date = (value: unknown) => new Date(String(value))
const nullableString = (value: unknown) => (value == null ? null : String(value))

export async function pushQuestionAudits(
  tx: SQL,
  row: Payload,
  questionId: string,
  spaceId: string,
): Promise<void> {
  for (const audit of questionAudits(row)) {
    await drizzle({ client: tx })
      .insert(questionMutationAuditRecord)
      .values({
        id: newRecordId(),
        questionId,
        spaceId,
        action: String(audit.action),
        actorSession: nullableString(audit.actorSession),
        at: date(audit.at),
        reason: nullableString(audit.reason),
      })
      .onConflictDoNothing()
  }
}
