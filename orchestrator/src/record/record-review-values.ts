// concern: record-review-values
/** Maps local review evidence payloads to hosted record values. */
import { nullableRecordDate, recordDate } from '../../../shared/record-timestamp.ts'
import { nullableNumber } from './record-value-conversions.ts'

type Payload = Record<string, unknown>

export const commonReviewRecordValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  withheldFields: row.withheldFields,
  createdAt: recordDate(row.createdAt),
  updatedAt: recordDate(row.updatedAt),
})

const nullableString = (value: unknown): string | null => (value == null ? null : String(value))

export function reviewValues(row: Payload, projectId: string | null) {
  return {
    ...commonReviewRecordValues(row),
    projectId,
    recordedAt: recordDate(row.recordedAt),
    completedAt: nullableRecordDate(row.completedAt),
    tier: nullableNumber(row.tier),
    tierRisk: nullableNumber(row.tierRisk),
    tierSize: nullableNumber(row.tierSize),
    tierInsertions: nullableNumber(row.tierInsertions),
    tierDeletions: nullableNumber(row.tierDeletions),
    tierReasons: row.tierReasons,
    tierReason: nullableString(row.tierReason),
    role: String(row.role),
    patchId: nullableString(row.patchId),
    pathSet: row.pathSet,
    commitMessage: nullableString(row.commitMessage),
    outdatedAt: nullableRecordDate(row.outdatedAt),
    outdatedReason: nullableString(row.outdatedReason),
    round: nullableNumber(row.round),
  }
}
