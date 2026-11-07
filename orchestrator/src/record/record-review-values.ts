// concern: record-review-values
/** Maps local review evidence payloads to hosted record values. */
import { recordDate } from '../../../shared/record-timestamp.ts'

type Payload = Record<string, unknown>

export const commonReviewRecordValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  withheldFields: row.withheldFields,
  createdAt: recordDate(row.createdAt),
  updatedAt: recordDate(row.updatedAt),
})
