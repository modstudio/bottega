// concern: score-sync
/** Owns validation and upsert of one local score into its tenant-bound hosted record. */
import type { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { runScore as runScoreRecord } from '../../../shared/record/schema-run.ts'
import { VERDICT_PAYLOAD_SCHEMA, type VerdictPayload } from '../verdict/verdict-payload.ts'
import type { Payload } from './record-sync-types.ts'
import { validateRecordVerdict } from './record-verdicts.ts'

const nullableString = (value: unknown) => (value == null ? null : String(value))
const jsonString = (value: unknown) => (value == null ? null : JSON.stringify(value))

function scoreValues(row: VerdictPayload) {
  return {
    runId: String(row.id),
    spaceId: String(row.spaceId),
    delivery: String(row.delivery),
    quality: nullableString(row.quality),
    fidelity: nullableString(row.fidelity),
    note: nullableString(row.note),
    scoredAt: new Date(row.scoredAt),
    scoredBy: String(row.scoredBy),
    withheldFields: jsonString(row.withheldFields),
    updatedAt: new Date(row.updatedAt),
  }
}

async function hostedScoreMatches(tx: SQL, verdict: VerdictPayload): Promise<boolean> {
  if (
    verdict.reproduced !== null ||
    verdict.coverage !== null ||
    verdict.limits !== null ||
    verdict.overlap !== null
  ) {
    return false
  }
  const scores = await tx`
    SELECT delivery, quality, fidelity FROM run_score
    WHERE run_id=${verdict.id}::uuid AND space_id=${verdict.spaceId}::uuid
  `
  const score = scores[0] as Record<string, unknown> | undefined
  return (
    score !== undefined &&
    score.delivery === verdict.delivery &&
    score.quality === verdict.quality &&
    score.fidelity === verdict.fidelity
  )
}

export async function pushScore(tx: SQL, row: Payload): Promise<void> {
  const verdict = VERDICT_PAYLOAD_SCHEMA.parse(row)
  if (!(await hostedScoreMatches(tx, verdict))) await validateRecordVerdict(tx, verdict)
  const values = scoreValues(verdict)
  const { runId: _runId, ...updates } = values
  await drizzle({ client: tx })
    .insert(runScoreRecord)
    .values(values)
    .onConflictDoUpdate({ target: runScoreRecord.runId, set: updates })
}
