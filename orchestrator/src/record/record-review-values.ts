// concern: record-review-values
/** Maps local review evidence payloads to hosted record values. */

type Payload = Record<string, unknown>

export const commonReviewRecordValues = (row: Payload) => ({
  id: String(row.id),
  spaceId: String(row.spaceId),
  machineId: String(row.machineId),
  localId: BigInt(String(row.localId)),
  createdAt: new Date(String(row.createdAt)),
  updatedAt: new Date(String(row.updatedAt)),
})
